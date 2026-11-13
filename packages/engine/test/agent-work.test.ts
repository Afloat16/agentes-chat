import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, orgTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  agentStatuses,
  consultationsIn,
  createAgent,
  getThread,
  listWorkingRuns,
  openConsultationsIn,
  postPersonMessage,
  sendNote,
  suspendRunForTool,
  taskManager,
  workStateOf,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const runs = () => f.db.select().from(schema.agentRuns);

/**
 * @dev, asked by Ana in #general (in a thread when `root` is given), hands work to @infra in their private
 * conversation; @infra's run is at work there.
 */
async function delegated(root?: string) {
  const infra = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Infra", handle: "infra", role: "Servers", instructions: "You run them.", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev olha os bugs",
    ...(root ? { threadId: root } : {}),
  });
  const asker = (await runs()).find((r) => r.agentId === f.agent.id);
  if (!asker) throw new Error("no run");
  const sent = await sendNote(f.db, {
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: asker.id,
    hop: 1,
    targetAgentId: infra.id,
    body: "Vê o log de ontem",
    chain: [f.agent.id],
  });
  if (!sent) throw new Error("not sent");
  const helper = (await runs()).find((r) => r.agentId === infra.id);
  if (!helper) throw new Error("no helper run");
  // The asker's turn ended (a hand-off never waits); the helper works.
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, asker.id));
  await f.db
    .update(schema.agentRuns)
    .set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() })
    .where(eq(schema.agentRuns.id, helper.id));
  return { infra, asker, helper };
}

const workOf = async (userId: string, agentId: string) =>
  (await agentStatuses(f.db, userId, f.org.id)).find((s) => s.agentId === agentId)?.work ?? null;

describe("work one agent handed another (ADR 0084 addendum)", () => {
  test("shows where it was handed off to who reads that conversation, bare to anyone else", async () => {
    f = await setup();
    const { infra, helper } = await delegated();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const rui = await addMember(f.db, f.org.id, "admin", "rui");

    expect(await workOf(f.owner.id, infra.id)).toMatchObject({
      state: "working",
      ask: null,
      runId: helper.id,
      channelId: f.general.id,
      channelKind: "channel",
      channelName: "general",
      threadId: null,
      forAgentId: f.agent.id,
      routine: false,
      count: 1,
    });
    // Not in #general: the bare state, which the face already says.
    expect(await workOf(bia.id, infra.id)).toMatchObject({
      state: "working",
      channelId: null,
      channelName: null,
      forAgentId: null,
      messageId: null,
    });
    // An administrator reads every channel.
    expect(await workOf(rui.id, infra.id)).toMatchObject({ channelId: f.general.id, forAgentId: f.agent.id });

    // Início: listed where it was handed off, for its members only.
    const listed = await listWorkingRuns(f.db, f.owner.id, f.org.id);
    expect(listed.find((r) => r.runId === helper.id)).toMatchObject({
      agentId: infra.id,
      channelId: f.general.id,
      channelName: "general",
      threadId: null,
      forAgentId: f.agent.id,
    });
    expect((await listWorkingRuns(f.db, bia.id, f.org.id)).some((r) => r.runId === helper.id)).toBe(false);

    // The working line knows the hand-off is out, and what it is.
    expect(await openConsultationsIn(f.db, f.org.id, f.general.id)).toMatchObject([
      { consultedAgentId: infra.id, kind: "note" },
    ]);

    // The task manager says where it came from to who reads it.
    const view = await taskManager(f.db, f.owner.id, f.org.id);
    expect(view.tasks.find((t) => t.runId === helper.id)?.delegation).toMatchObject({
      agentId: f.agent.id,
      from: { channelId: f.general.id, channelKind: "channel", channelName: "general", threadId: null },
    });
  });

  test("waits on who may decide its approval, on someone else for everyone else", async () => {
    f = await setup();
    const { infra, helper } = await delegated();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    for (const id of [bia.id, caio.id])
      await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: id });
    await f.db
      .update(schema.agentRuns)
      .set({ status: "waiting_approval", updatedAt: new Date(Date.now() - 180_000) })
      .where(eq(schema.agentRuns.id, helper.id));
    await f.db.insert(schema.approvals).values({
      orgId: f.org.id,
      runId: helper.id,
      agentId: infra.id,
      channelId: f.general.id,
      threadRootId: helper.threadRootId,
      toolUseId: "toolu_1",
      tool: "github_merge_pull_request",
      scope: "",
      params: {},
      actionHash: "hash",
      title: "Merge PR #12",
      ownerUserId: bia.id,
      requestedByUserId: f.owner.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    // The agent's owner decides it; so does the workspace's owner (every key). Caio waits like everyone else.
    expect(await workOf(bia.id, infra.id)).toMatchObject({ state: "you", ask: "approval", channelId: f.general.id });
    expect(await workOf(f.owner.id, infra.id)).toMatchObject({ state: "you", ask: "approval" });
    const theirs = await workOf(caio.id, infra.id);
    expect(theirs).toMatchObject({ state: "approval", ask: null });
    // Waiting counts from when the wait began, not from the hand-off.
    expect(Date.now() - Date.parse(theirs?.since ?? "")).toBeGreaterThanOrEqual(170_000);

    // The divider reads the same wait, with its clock.
    const [c] = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(c).toMatchObject({ kind: "note", waiting: "approval" });
    expect(c?.waitingSince).toBeInstanceOf(Date);
  });

  test("a run in line says so", async () => {
    f = await setup();
    const { infra, helper } = await delegated();
    await f.db.update(schema.agentRuns).set({ status: "queued" }).where(eq(schema.agentRuns.id, helper.id));
    expect(await workOf(f.owner.id, infra.id)).toMatchObject({ state: "queued", forAgentId: f.agent.id });
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]).toMatchObject({ waiting: "queued" });
  });

  test("a thread counts what its runs handed off as its own work, and says what holds it", async () => {
    f = await setup();
    const root = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "Revisar a proposta do cliente novo",
    });
    const { helper } = await delegated(root.id);
    expect(await getThread(f.db, f.owner.id, f.org.id, root.id)).toMatchObject({
      working: true,
      needsYou: false,
      wait: null,
    });
    await f.db.update(schema.agentRuns).set({ status: "waiting_input" }).where(eq(schema.agentRuns.id, helper.id));
    const waiting = await getThread(f.db, f.owner.id, f.org.id, root.id);
    expect(waiting).toMatchObject({ working: false, needsYou: false, wait: "input" });
    expect(waiting.since).not.toBeNull();
    // The helper's work shows there too, with the thread.
    const statuses = await agentStatuses(f.db, f.owner.id, f.org.id);
    expect(statuses.find((s) => s.agentId === helper.agentId)?.work).toMatchObject({
      state: "answer",
      threadId: root.id,
    });
  });

  test("a computer brain parking mid-turn tells its face and the conversation that handed it the work", async () => {
    f = await setup();
    const { infra, asker, helper } = await delegated();
    const seen: string[] = [];
    f.pubsub.subscribe(channelTopic(f.general.id), (e) => seen.push((e as { type: string }).type));
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      const ev = (e as { event?: { type: string; agentId?: string } }).event;
      if (ev?.type === "agent.status" && ev.agentId === infra.id) seen.push("agent.status");
    });
    const [approval] = await f.db
      .insert(schema.approvals)
      .values({
        orgId: f.org.id,
        runId: helper.id,
        agentId: infra.id,
        channelId: helper.channelId,
        threadRootId: helper.threadRootId,
        toolUseId: "toolu_2",
        tool: "github_merge_pull_request",
        scope: "",
        params: {},
        actionHash: "hash2",
        title: "Merge PR #12",
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    if (!approval) throw new Error("no approval");
    const [running] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, helper.id));
    if (!running) throw new Error("no run");
    await suspendRunForTool(
      { db: f.db, pubsub: f.pubsub },
      running,
      { id: "toolu_2", name: approval.tool },
      {
        type: "approval",
        approval,
      },
    );
    expect(seen).toContain("agent.consultation");
    expect(seen).toContain("agent.status");
    expect(asker.channelId).toBe(f.general.id);
  });
});

test("how one run stands: in line, at work, waiting on someone, or nothing for a wait on its plan", () => {
  const run = { onMachine: false, outage: false, waitCode: null, you: false };
  expect(workStateOf({ ...run, status: "queued" })).toBe("queued");
  expect(workStateOf({ ...run, status: "running" })).toBe("working");
  // Asking its computer for room from the line.
  expect(workStateOf({ ...run, status: "running", onMachine: true })).toBe("queued");
  expect(workStateOf({ ...run, status: "waiting_approval" })).toBe("approval");
  expect(workStateOf({ ...run, status: "waiting_approval", you: true })).toBe("you");
  expect(workStateOf({ ...run, status: "waiting_input" })).toBe("answer");
  expect(workStateOf({ ...run, status: "waiting_input", you: true })).toBe("you");
  expect(workStateOf({ ...run, status: "waiting_input", onMachine: true })).toBe("computer");
  expect(workStateOf({ ...run, status: "waiting_input", waitCode: "busy", onMachine: true })).toBe("queued");
  expect(workStateOf({ ...run, status: "waiting_input", outage: true })).toBe("outage");
  expect(workStateOf({ ...run, status: "waiting_input", waitCode: "plan_limit" })).toBeNull();
  expect(workStateOf({ ...run, status: "waiting_input", waitCode: "usage_pause" })).toBeNull();
});
