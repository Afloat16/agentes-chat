import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  type AccessInput,
  createChannel,
  createVaultItem,
  ensureRightHand,
  getAgentAccess,
  grantedScopeKeys,
  insertMessage,
  isAllowed,
  listUsableVault,
  openPersonAgentDm,
  RIGHT_HAND,
  setAgentAccess,
  setAgentMail,
  type ToolContext,
  toolAccess,
  type VaultRun,
} from "../src";
import { addMember, type Fixture } from "./fixtures";
import { imapAccount, type MailFixture, mailSetup } from "./mail-fixtures";
import { type VaultFixture, vaultSetup } from "./vault-fixtures";

/**
 * One right hand answers everyone (ADR 0137), with a normal agent's tools: what is one person's reaches nobody else
 * through it, and nowhere others read its reply.
 */

let open: Fixture | undefined;
afterEach(async () => {
  const current = open;
  open = undefined;
  await current?.close();
});

async function lodiOf(f: Fixture) {
  await ensureRightHand(f.db, f.org.id);
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
}

/** A run of the right hand on what `userId` wrote in `channelId` (their own DM with it when left out). */
async function lodiRun(f: Fixture, userId: string, channelId?: string): Promise<ToolContext> {
  const lodi = await lodiOf(f);
  const place = channelId ?? (await openPersonAgentDm(f.db, f.org.id, userId, lodi.id)).id;
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: place,
    author: { type: "person", userId },
    body: "o que você tem aí?",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId: place,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: lodi.id,
    runId: run.id,
    channelId: place,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

describe("the Vault", () => {
  let v: VaultFixture;
  const titles = async (ctx: ToolContext) => {
    const run: VaultRun = { orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId };
    return (await listUsableVault(v.deps, run)).map((i) => i.title).sort();
  };

  test("a person's own item only in their own DM with it; a team item open to everyone, anywhere", async () => {
    v = await vaultSetup();
    open = v.f;
    const lodi = await lodiOf(v.f);
    await createVaultItem(v.deps, v.bruno.id, v.f.org.id, {
      kind: "contact",
      scope: "personal",
      title: "Contador do Bruno",
      contact: { city: "Recife" },
    });
    await createVaultItem(v.deps, v.carla.id, v.f.org.id, {
      kind: "contact",
      scope: "team",
      title: "Fornecedor",
      contact: { city: "Olinda" },
      access: { everyone: true, roleIds: [], userIds: [], allAgents: false, agentIds: [lodi.id] },
    });
    await createVaultItem(v.deps, v.carla.id, v.f.org.id, {
      kind: "contact",
      scope: "team",
      title: "Só do Suporte",
      contact: { city: "Natal" },
      access: { everyone: false, roleIds: [v.supportRoleId], userIds: [], allAgents: false, agentIds: [lodi.id] },
    });
    // Bruno, in his own DM: his item, and the team's he is in the audience of.
    expect(await titles(await lodiRun(v.f, v.bruno.id))).toEqual(["Contador do Bruno", "Fornecedor", "Só do Suporte"]);
    // Dora, in hers: nothing of Bruno's, nor what only Support sees.
    expect(await titles(await lodiRun(v.f, v.dora.id))).toEqual(["Fornecedor"]);
    // Bruno calling it in a channel, where others read the reply: nothing that is his alone.
    expect(await titles(await lodiRun(v.f, v.bruno.id, v.f.general.id))).toEqual(["Fornecedor"]);
    // Any other agent keeps a person's own item wherever that person asks.
    const asked = await lodiRun(v.f, v.bruno.id, v.f.general.id);
    expect(await titles({ ...asked, agentId: v.dev.id })).toContain("Contador do Bruno");
  });
});

describe("a mailbox", () => {
  let m: MailFixture;
  const mailTools = async (ctx: ToolContext) =>
    (await m.tools.list(ctx)).map((t) => t.name).filter((n) => n.startsWith("mail_"));

  test("serves its owner alone, in their own DM with it: nobody else's run, and no channel", async () => {
    m = await mailSetup();
    open = m.f;
    const { f } = m;
    const lia = await addMember(f.db, f.org.id, "member", "lia");
    const lodi = await lodiOf(f);
    const account = await imapAccount(m);
    await setAgentMail(f.db, f.owner.id, f.org.id, lodi.id, account.id, {
      level: "read",
      canDelete: false,
      policy: {
        folders: [],
        senders: [],
        windowDays: null,
        allowedRecipients: [],
        dailySendCap: 25,
        sendWithoutAsking: false,
        fromAddress: null,
      },
    });
    // The grant row counts now: its owner reads the mailbox through it.
    expect(await mailTools(await lodiRun(f, f.owner.id))).toContain("mail_support_search");
    // Everyone talks to it, so being in its audience opens no one else's mailbox.
    const hers = await lodiRun(f, lia.id);
    expect(await mailTools(hers)).toEqual([]);
    const refused = await m.tools.invoke(hers, {
      toolUseId: "tu_search",
      name: "mail_support_search",
      input: { text: "salário" },
    });
    expect(refused.type === "result" && refused.output.isError).toBe(true);
    // Its owner in a channel, where others read the reply.
    expect(await mailTools(await lodiRun(f, f.owner.id, f.general.id))).toEqual([]);
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "financeiro", visibility: "private" });
    expect(await mailTools(await lodiRun(f, f.owner.id, room.id))).toEqual([]);
  });
});

describe("its access, on its page", () => {
  type Tree = Awaited<ReturnType<typeof getAgentAccess>>;
  /**
   * The page's save body, read back from the tree as the apps do: every scope shown granted but `off`, and every tool
   * shown denied but those of the scopes in `on`.
   */
  const bodyOf = (tree: Tree, change: { off?: string[]; on?: string[] } = {}): AccessInput => ({
    all: tree.all,
    connectors: {},
    scopes: tree.builtins
      .filter((b) => b.scope !== "" && b.state === "granted" && !change.off?.includes(b.scope))
      .map((b) => ({ connectionId: null, scope: b.scope })),
    tools: {
      allow: [],
      deny: tree.builtins
        .filter((b) => !change.on?.includes(b.scope))
        .flatMap((b) => b.tools.filter((t) => t.state === "denied").map((t) => ({ connectionId: null, name: t.name }))),
    },
  });
  const stateOf = (tree: Tree, name: string) =>
    tree.builtins.flatMap((b) => b.tools).find((t) => t.name === name)?.state;

  test("shows what it holds, leaves a computer's out, and a built-in area turned off stays off until turned on", async () => {
    const v = await vaultSetup();
    open = v.f;
    const { f } = v;
    const lodi = await lodiOf(f);
    const save = (body: AccessInput) => setAgentAccess(f.db, f.owner.id, f.org.id, lodi.id, body);
    const before = await getAgentAccess(f.db, f.owner.id, f.org.id, lodi.id);
    const shown = before.builtins.map((b) => b.scope);
    for (const scope of ["sandbox:run", "browser:use", "desktop:use"]) expect(shown).not.toContain(scope);
    for (const name of ["vault_list", "create_artifact", "load_skill", "remember"])
      expect(stateOf(before, name)).toBe("granted");

    // The Vault off and the Drive to reading only, as the page saves them.
    const off = await save(bodyOf(before, { off: ["vault:read", "vault:write", "drive:write"] }));
    expect(stateOf(off, "vault_list")).toBe("denied");
    expect(stateOf(off, "vault_save")).toBe("denied");
    expect(stateOf(off, "create_artifact")).toBe("denied");
    expect(stateOf(off, "read_artifact")).toBe("granted");
    const keys = await grantedScopeKeys(f.db, f.org.id, lodi.id);
    expect(isAllowed(toolAccess(keys, { name: "vault_list", scope: "vault:read" }))).toBe(false);
    expect(isAllowed(toolAccess(keys, { name: "read_wiki_page", scope: "wiki:read" }))).toBe(true);

    // The page saved again as it is keeps them off; turning the Vault on lifts it.
    const same = await save(bodyOf(off));
    expect(stateOf(same, "vault_list")).toBe("denied");
    const on = await save(bodyOf(same, { on: ["vault:read", "vault:write"] }));
    expect(stateOf(on, "vault_list")).toBe("granted");
    expect(stateOf(on, "vault_save")).toBe("granted");
    expect(stateOf(on, "create_artifact")).toBe("denied");
  });
});
