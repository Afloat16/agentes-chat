import { afterEach, expect, test } from "bun:test";
import { and, eq, inArray, schema } from "@agenteschat/db";
import {
  COMMAND_RULE_TOOL,
  COMPOSIO_EXECUTOR,
  decideApprovals,
  ForbiddenError,
  highRisk,
  listApprovals,
  liveLodiSwitches,
  personAgentDmKey,
  publishApproval,
  REQUEST_PERMISSION_TOOL,
  RIGHT_HAND,
  SQL_READS,
  setLodiPrefs,
} from "../src";
import {
  APPROVALS_DIGEST_JOB,
  approvalsDigestLane,
  postApprovalsDigest,
  queueApprovalsDigest,
} from "../src/approvals-digest";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const HOUR = 3_600_000;
const NOW = new Date("2026-11-06T01:00:00Z");
/** A connected app: nothing reads the row, an approval only names it. */
const APP = "00000000-0000-4000-8000-00000000c001";

const deps = () => ({ db: f.db, pubsub: f.pubsub, now: () => NOW });

let n = 0;
/** One approval waiting, as the gateway writes it: a connected app's plain action unless `over` says otherwise. */
async function ask(over: Partial<typeof schema.approvals.$inferInsert> = {}) {
  n += 1;
  const tool = over.tool ?? "notes_create_page";
  const scope = over.scope ?? `custom:${APP}:write`;
  const [row] = await f.db
    .insert(schema.approvals)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: `use-${n}`,
      tool,
      scope,
      connectionId: APP,
      params: {},
      actionHash: `hash-${n}`,
      title: `Create page ${n}`,
      ownerUserId: f.owner.id,
      expiresAt: new Date(NOW.getTime() + 72 * HOUR),
      highRisk: highRisk(tool, scope),
      ...over,
    })
    .returning();
  if (!row) throw new Error("no approval");
  return row;
}

const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** What the right hand posted by itself, oldest first. */
const posts = async () =>
  f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.authorAgentId, (await lodiOf()).id))
    .orderBy(schema.messages.createdAt);

const cardIds = (m: { meta: Record<string, unknown> } | undefined) =>
  (m?.meta.actionCard as { params: { approvalIds: string[] } } | undefined)?.params.approvalIds;

const digest = (userId: string, at = NOW) => postApprovalsDigest(f.jobDeps, f.org.id, { userId }, at);

test("the switch is live", () => {
  expect(approvalsDigestLane.live).toBe(true);
  expect(liveLodiSwitches()).toContain("digest");
});

test("a new approval queues one job a person on the next 10-minute mark at least 10 minutes away", async () => {
  f = await setup({ rightHand: true });
  const jobs = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, APPROVALS_DIGEST_JOB));
  await queueApprovalsDigest(f.db, f.org.id, [f.owner.id], new Date("2026-11-06T12:03:00Z"));
  await queueApprovalsDigest(f.db, f.org.id, [f.owner.id, f.owner.id], new Date("2026-11-06T12:09:59Z"));
  await queueApprovalsDigest(f.db, f.org.id, [f.owner.id], new Date("2026-11-06T12:10:00Z"));
  expect((await jobs()).map((j) => [j.nextAttemptAt.toISOString(), j.dedupeKey, j.payload])).toEqual([
    [
      "2026-11-06T12:20:00.000Z",
      `approvals_digest.post:${f.org.id}:${f.owner.id}:2026-11-06T12:20:00.000Z`,
      { userId: f.owner.id },
    ],
  ]);
  // Publishing an approval queues it for whoever is told: the agent's owner.
  await publishApproval(deps(), await ask(), "approval.created");
  const queued = await jobs();
  expect(queued).toHaveLength(2);
  expect(queued.every((j) => (j.payload as { userId: string }).userId === f.owner.id)).toBe(true);
});

test("under three nothing, three give one quiet card, a fourth joins it, and no model is called", async () => {
  f = await setup({ rightHand: true });
  const first = [await ask(), await ask()];
  await digest(f.owner.id);
  expect(await posts()).toEqual([]);

  first.push(await ask());
  await digest(f.owner.id);
  const [card, ...more] = await posts();
  expect(more).toEqual([]);
  expect(card?.meta).toMatchObject({
    bodyCode: "action_approvals",
    actionCard: {
      kind: "approvals",
      forUserId: f.owner.id,
      params: { approvalIds: first.map((a) => a.id), why: "", digest: true },
    },
  });
  // In the person's own DM with the right hand, and nowhere else.
  const [dm] = await f.db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, card?.channelId ?? ""));
  expect(dm?.dmKey).toBe(personAgentDmKey(f.owner.id, (await lodiOf()).id));
  // Ids only: what each approval says comes from the reader's own list.
  expect(JSON.stringify(card)).not.toContain("Create page");

  // The same job again says nothing more.
  await digest(f.owner.id);
  expect(await posts()).toHaveLength(1);

  // A fourth, and one decided meanwhile: the same card, the decided one keeping its line.
  const fourth = await ask();
  await decideApprovals(deps(), f.owner.id, f.org.id, { ids: [first[0]?.id ?? ""], decision: "approve" });
  await digest(f.owner.id, new Date(NOW.getTime() + HOUR));
  const after = await posts();
  expect(after.map((m) => m.id)).toEqual([card?.id ?? ""]);
  expect(cardIds(after[0])).toEqual([...first.map((a) => a.id), fourth.id]);

  // It never rings: no inbox row, no push, and nothing asked of a model.
  expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "notifications.message"))).toEqual([]);
  expect(await f.db.select().from(schema.notifications)).toEqual([]);
  expect(f.provider.calls).toHaveLength(0);
});

test("silent with the switch off, in a closed workspace, for someone gone, and when they decided in time", async () => {
  f = await setup({ rightHand: true });
  const three = [await ask(), await ask(), await ask()];

  await setLodiPrefs(f.db, f.org.id, f.owner.id, { digestOff: true });
  await digest(f.owner.id);
  expect(await posts()).toEqual([]);
  await setLodiPrefs(f.db, f.org.id, f.owner.id, { digestOff: false });

  await f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() + 24 * HOUR) })
    .where(eq(schema.organizations.id, f.org.id));
  await digest(f.owner.id);
  expect(await posts()).toEqual([]);
  await f.db.update(schema.organizations).set({ deletionDueAt: null }).where(eq(schema.organizations.id, f.org.id));

  await digest("nobody");
  await postApprovalsDigest(f.jobDeps, f.org.id, {}, NOW);
  expect(await posts()).toEqual([]);

  // Decided before the job ran: two are left, and two is not worth a card.
  await decideApprovals(deps(), f.owner.id, f.org.id, { ids: [three[0]?.id ?? ""], decision: "refuse" });
  await digest(f.owner.id);
  expect(await posts()).toEqual([]);
  // One past its deadline does not count either.
  await ask({ expiresAt: new Date(NOW.getTime() - HOUR) });
  await digest(f.owner.id);
  expect(await posts()).toEqual([]);
  expect(f.provider.calls).toHaveLength(0);
});

test("an old card is left alone, and a person gets at most two digests a day", async () => {
  f = await setup({ rightHand: true });
  const settle = (ids: string[]) =>
    f.db.update(schema.approvals).set({ status: "approved" }).where(inArray(schema.approvals.id, ids));
  const first = [await ask(), await ask(), await ask()];
  await digest(f.owner.id);
  const [old] = await posts();
  await f.db
    .update(schema.messages)
    .set({ createdAt: new Date(NOW.getTime() - HOUR) })
    .where(eq(schema.messages.id, old?.id ?? ""));

  // Thirteen hours on the first card still lists what waits, but nobody is looking at it: a new one.
  const later = new Date(NOW.getTime() + 12 * HOUR);
  const fourth = await ask();
  await digest(f.owner.id, later);
  const two = await posts();
  expect(two).toHaveLength(2);
  expect(cardIds(two[0])).toEqual(first.map((a) => a.id));
  expect(cardIds(two[1])).toEqual([...first.map((a) => a.id), fourth.id]);

  // All decided, three new ones the same day: the day's two are spent, so nothing.
  await settle([...first.map((a) => a.id), fourth.id]);
  const next = [await ask(), await ask(), await ask()];
  await digest(f.owner.id, new Date(later.getTime() + HOUR));
  expect(await posts()).toHaveLength(2);

  // The next day it speaks again.
  await digest(f.owner.id, new Date(NOW.getTime() + 24 * HOUR));
  const three = await posts();
  expect(three).toHaveLength(3);
  expect(cardIds(three[2])).toEqual(next.map((a) => a.id));
});

test("it counts only what the person was told about, and never another person's mailbox", async () => {
  f = await setup({ rightHand: true });
  const bia = await addMember(f.db, f.org.id, "admin", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  // Three of the owner's agent: Bia may decide them as an admin, silently. She was not told, so no card for her.
  for (let i = 0; i < 3; i++) await ask();
  // Three in the owner's own mailbox, asked by someone else: only the owner decides those.
  const mailbox = { userIds: [f.owner.id], label: "owner", requestedBy: caio.id, requesterDecides: false };
  for (let i = 0; i < 3; i++)
    await ask({ tool: "mail_work_draft", scope: "mail:draft", approvers: { ...mailbox, required: true } });
  expect((await listApprovals(f.db, bia.id, f.org.id, { status: "pending" })).filter((a) => a.canDecide)).toHaveLength(
    3,
  );

  await digest(bia.id);
  await digest(caio.id);
  expect(await posts()).toEqual([]);

  await digest(f.owner.id);
  const [card, ...more] = await posts();
  expect(more).toEqual([]);
  expect(cardIds(card)).toHaveLength(6);
  const [dm] = await f.db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, card?.channelId ?? ""));
  expect(dm?.dmKey).toBe(personAgentDmKey(f.owner.id, (await lodiOf()).id));
  // Nobody else is in that conversation.
  const members = await f.db
    .select()
    .from(schema.channelMembers)
    .where(eq(schema.channelMembers.channelId, card?.channelId ?? ""));
  expect(members.flatMap((m) => m.userId ?? [])).toEqual([f.owner.id]);
});

test("the one tap decides only what the server calls routine, as the person who taps", async () => {
  f = await setup({ rightHand: true });
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const mine = { userIds: [f.owner.id], label: "owner", requestedBy: null, requesterDecides: false };
  const plain = [
    await ask(),
    await ask({ tool: "notes_update_page" }),
    // Composio's executor, by the action its input names.
    await ask({
      tool: `acme_${COMPOSIO_EXECUTOR}`,
      params: { tools: [{ tool_slug: "GITHUB_CREATE_AN_ISSUE", arguments: { title: "x" } }] },
    }),
    // SQL the Postgres guard proved read-only when it asked.
    await ask({
      tool: "supabase_execute_sql",
      approveAlways: { tool: "execute_sql", actions: [`${SQL_READS}project_id=abc`] },
    }),
  ];
  const risky = [
    // A shell command on the agent's computer, whatever it is called.
    await ask({
      tool: "run_code",
      scope: "sandbox:run",
      connectionId: null,
      params: { language: "bash", code: "gh pr merge 12" },
      approveAlways: { tool: COMMAND_RULE_TOOL, actions: ["gh pr merge"] },
    }),
    await ask({ tool: "run_code", scope: "sandbox:run", connectionId: null, params: { language: "python" } }),
    await ask({ tool: REQUEST_PERMISSION_TOOL, scope: "", connectionId: null, params: { permission: "x" } }),
    await ask({ tool: "mail_work_send", scope: "mail:send", approvers: { ...mine, required: true } }),
    await ask({ tool: "mail_work_draft", scope: "mail:draft", approvers: mine }),
    await ask({ tool: "github_merge_pull_request", scope: "github:pr.merge" }),
    await ask({ tool: "notes_delete_page" }),
    await ask({ tool: "billing_pay_invoice" }),
    await ask({ tool: "ops_server_execute_command" }),
    await ask({ tool: "supabase_execute_sql" }),
    await ask({
      tool: `acme_${COMPOSIO_EXECUTOR}`,
      params: { tools: [{ tool_slug: "GITHUB_MERGE_A_PULL_REQUEST", arguments: {} }] },
    }),
    // An executor call whose actions cannot be read from its input.
    await ask({ tool: `acme_${COMPOSIO_EXECUTOR}`, params: { tools: "all" } }),
    await ask({ tool: "acme_COMPOSIO_REMOTE_WORKBENCH" }),
    // One of our own tools, even a harmless one.
    await ask({ tool: "create_issue", scope: "issues:write", connectionId: null }),
  ];
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  const listed = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(ids(listed.filter((a) => a.routine))).toEqual(ids(plain));

  await digest(f.owner.id);
  const [card] = await posts();
  const all = [...plain, ...risky].map((a) => a.id);

  // Someone who may decide none of them is told so, and nothing changes.
  expect(
    decideApprovals(deps(), caio.id, f.org.id, { ids: all, decision: "approve", only: "routine" }),
  ).rejects.toBeInstanceOf(ForbiddenError);

  const result = await decideApprovals(deps(), f.owner.id, f.org.id, {
    ids: all,
    decision: "approve",
    only: "routine",
    via: card?.id,
  });
  expect(ids(result.approvals)).toEqual(ids(plain));
  expect([...result.skipped].sort()).toEqual(ids(risky));
  expect(result.approvals.every((a) => a.decidedByUserId === f.owner.id && !a.routine)).toBe(true);
  const waiting = await f.db.select().from(schema.approvals).where(eq(schema.approvals.status, "pending"));
  expect(ids(waiting)).toEqual(ids(risky));

  // One audit row each, the person's own, through the right hand's card. No "Aprovar sempre" rule is kept.
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "approval.approved"));
  expect(audit.map((r) => r.targetId).sort()).toEqual(ids(plain));
  const lodi = await lodiOf();
  expect(audit.every((r) => r.actorType === "person" && r.actorId === f.owner.id)).toBe(true);
  expect(audit.every((r) => (r.details as { via?: string }).via === lodi.id)).toBe(true);
  expect(await f.db.select().from(schema.approvalRules)).toEqual([]);

  // With nothing routine left the same tap decides nothing, and says which it left.
  const again = await decideApprovals(deps(), f.owner.id, f.org.id, { ids: all, decision: "approve", only: "routine" });
  expect(again.approvals).toEqual([]);
  expect([...again.skipped].sort()).toEqual([...all].sort());
  expect(f.provider.calls).toHaveLength(0);
});
