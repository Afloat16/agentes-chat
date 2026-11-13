import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, like, schema } from "@agenteschat/db";
import {
  askAgentToImplement,
  createIssue,
  createReminder,
  drainOutbox,
  fireDueRoutines,
  insertMessage,
  liveLodiSwitches,
  lodiPromptBlocks,
  openPersonAgentDm,
  RIGHT_HAND,
  runAuthority,
  saidKey,
  setLodiPrefs,
  setWorkIssueState,
  updateIssue,
} from "../src";
import { isAgentOnlyNotice, noticeText } from "../src/notices";
import {
  checkHandedTask,
  followLane,
  HANDED_TASK_LOOKS,
  HANDED_TASK_WAKES_A_DAY,
  KEPT_REMINDERS_MAX,
  keepingWordBlock,
  TASK_CHECK_JOB,
  TASK_END_JOB,
  tellTaskEnd,
} from "../src/right-hand-follow";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const person = (userId: string) => ({ type: "person" as const, userId });

const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** A turn of Lodi on what `userId` wrote in their DM with it, already ended. */
async function lodiTurn(userId: string, body: string) {
  const lodi = await lodiOf();
  const dm = await openPersonAgentDm(f.db, f.org.id, userId, lodi.id);
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "person", userId },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId: dm.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "dm",
      hop: 1,
      status: "done",
    })
    .returning();
  if (!run) throw new Error("no run");
  return { lodi, dm, run };
}

/** `userId` asks Lodi, and Lodi hands a task everyone sees to @dev for them. Nothing of it is left to run. */
async function handOver(userId = f.owner.id, title = "Campanha de Natal") {
  const { lodi, dm, run } = await lodiTurn(userId, `pede pro dev: ${title}`);
  const made = await createIssue(deps(), person(userId), f.org.id, { title });
  await askAgentToImplement(deps(), userId, f.org.id, made.id, f.agent.id, {
    agentId: lodi.id,
    runId: run.id,
    hop: 1,
  });
  const [c] = await f.db
    .select()
    .from(schema.agentConsultations)
    .where(eq(schema.agentConsultations.askerRunId, run.id));
  const [issue] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, made.id));
  if (!c || !issue?.conversationChannelId) throw new Error("not handed over");
  // @dev's own turn is not what these tests are about: it never runs.
  await f.db.update(schema.outbox).set({ status: "done" }).where(eq(schema.outbox.kind, "agent_run.execute"));
  return { lodi, dm, run, c, issue, conversationId: issue.conversationChannelId };
}

/** The hand-over was reported back an hour ago: @dev answered and its turn ended. */
async function reported(c: { id: string; targetRunId: string | null }, status: "answered" | "failed" = "answered") {
  const at = new Date(Date.now() - HOUR);
  await f.db
    .update(schema.agentConsultations)
    .set({ status, answer: "PR aberto, falta revisar.", answeredAt: at, reportedAt: at })
    .where(eq(schema.agentConsultations.id, c.id));
  if (c.targetRunId)
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, c.targetRunId));
}

/** Nothing happened to the task or in its conversation for two days. */
async function quiet(issue: { id: string }, conversationId: string) {
  const at = new Date(Date.now() - 2 * DAY);
  await f.db.update(schema.issues).set({ updatedAt: at }).where(eq(schema.issues.id, issue.id));
  await f.db.update(schema.messages).set({ createdAt: at }).where(eq(schema.messages.channelId, conversationId));
}

const noticesIn = async (channelId: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId))).filter(
    (m) => (m.meta.notice as { refs?: { task?: string } } | undefined)?.refs?.task,
  );

/** What a notice tells Lodi. */
const said = (m: { meta: Record<string, unknown> } | undefined) =>
  (m?.meta.notice as { text?: string } | undefined)?.text ?? "";

const jobsOf = async (kind: string) => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, kind));

const check = (c: { id: string }, n = 1) => checkHandedTask(deps(), f.org.id, { consultationId: c.id, n });

describe("the lane", () => {
  test("is live: its switch shows, and both jobs have a handler", async () => {
    f = await setup({ rightHand: true });
    expect(followLane.live).toBe(true);
    expect(liveLodiSwitches([followLane])).toEqual(["reminders"]);
    expect(Object.keys(followLane.jobs).sort()).toEqual([TASK_CHECK_JOB, TASK_END_JOB]);
    expect(Object.keys(f.handlers)).toEqual(expect.arrayContaining([TASK_CHECK_JOB, TASK_END_JOB]));
  });

  test("a task handed over by Lodi gets its first look a day later, once; one a person hands over gets none", async () => {
    f = await setup({ rightHand: true });
    const { c } = await handOver();
    const [job] = await jobsOf(TASK_CHECK_JOB);
    expect(job).toMatchObject({
      payload: { consultationId: c.id, n: 1 },
      dedupeKey: `${TASK_CHECK_JOB}:${c.id}:1`,
      status: "pending",
    });
    const wait = (job?.nextAttemptAt.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(DAY - 60_000);
    expect(wait).toBeLessThanOrEqual(DAY);

    const mine = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "Sem o Lodi" });
    await askAgentToImplement(deps(), f.owner.id, f.org.id, mine.id, f.agent.id);
    expect(await jobsOf(TASK_CHECK_JOB)).toHaveLength(1);
    // And its end queues nothing: Lodi never had it.
    await updateIssue(deps(), person(f.owner.id), f.org.id, mine.id, { status: "done" });
    expect(await jobsOf(TASK_END_JOB)).toEqual([]);
  });
});

describe("a handed task that ends after its report", () => {
  test("wakes Lodi once in the requester's DM, as their own turn, with a notice only it reads", async () => {
    f = await setup({ rightHand: true });
    const bea = await addMember(f.db, f.org.id, "member", "bea");
    const other = await lodiTurn(bea.id, "oi");
    const { lodi, dm, run, c, issue } = await handOver();
    await reported(c);
    const callsBefore = f.provider.calls.length;

    await updateIssue(deps(), person(bea.id), f.org.id, issue.id, { status: "done" });

    const [notice] = await noticesIn(dm.id);
    expect(await noticesIn(dm.id)).toHaveLength(1);
    expect(notice?.authorAgentId).toBe(lodi.id);
    expect(notice?.meta.notice).toMatchObject({
      kind: "wait_result",
      refs: { task: issue.id, state: "done", runId: run.id, consultationId: c.id },
    });
    expect(isAgentOnlyNotice(notice?.meta)).toBe(true);
    const text = said(notice);
    expect(text).toContain(`Task #${issue.number} "Campanha de Natal"`);
    expect(text).toContain("which you handed to @dev");
    expect(text).toContain("is now done: bea marked it.");
    // The stored words mention nobody, so they start no agent.
    expect(notice?.body).not.toContain("@");
    expect(notice?.mentionedAgentIds).toEqual([]);

    // One turn of Lodi, in that DM, on the notice: the requester's own (their AI, their permissions).
    const woken = (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.channelId, dm.id))).filter(
      (r) => r.id !== run.id,
    );
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({ agentId: lodi.id, trigger: "dm", triggerMessageId: notice?.id, hop: 1 });
    if (!woken[0]) throw new Error("no run");
    expect(await runAuthority(f.db, woken[0])).toMatchObject({ kind: "person", personId: f.owner.id });
    // Telling it called no model.
    expect(f.provider.calls).toHaveLength(callsBefore);

    // One thing tells them: the inbox row of the same change is done.
    const rows = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, f.owner.id), eq(schema.notifications.kind, "issue_status")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.doneAt).not.toBeNull();
    // Nothing reached anyone else's DM with Lodi.
    expect(await noticesIn(other.dm.id)).toEqual([]);

    // Reopened and done again, and the job of each change running late: never said twice.
    await updateIssue(deps(), person(bea.id), f.org.id, issue.id, { status: "todo" });
    await updateIssue(deps(), person(bea.id), f.org.id, issue.id, { status: "done" });
    const jobs = await jobsOf(TASK_END_JOB);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) expect(await tellTaskEnd(deps(), f.org.id, job.payload)).toBe(false);
    expect(await noticesIn(dm.id)).toHaveLength(1);

    // The turn it started is the one model call of it all.
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length - callsBefore).toBe(1);
  });

  test("a canceled task is told too, and @dev closing it in the run Lodi started still counts as news", async () => {
    f = await setup({ rightHand: true });
    const { dm, c, issue, conversationId } = await handOver();
    await reported(c);
    await updateIssue(
      deps(),
      { type: "agent", agentId: f.agent.id, channelId: conversationId, runId: c.targetRunId ?? undefined },
      f.org.id,
      issue.id,
      { status: "canceled" },
    );
    const [notice] = await noticesIn(dm.id);
    expect(said(notice)).toContain("was canceled: @dev marked it.");
    expect(noticeText(notice?.meta, true)).toStartWith("[News of a task you handed over for this person]: ");
    expect(noticeText(notice?.meta, true)).not.toContain("finished");
    expect(noticeText(notice?.meta, true)).toContain("Only you see this.");
    expect(noticeText(notice?.meta, false)).not.toContain("Only you see this.");
  });

  test("the job alone tells it when the change itself could not", async () => {
    f = await setup({ rightHand: true });
    const bea = await addMember(f.db, f.org.id, "member", "bea");
    const { dm, c, issue } = await handOver();
    await reported(c);
    // As if the server stopped right after the change was saved.
    const at = new Date();
    await f.db.update(schema.issues).set({ status: "done", updatedAt: at }).where(eq(schema.issues.id, issue.id));
    const payload = { issueId: issue.id, to: "done", at: at.getTime(), by: { type: "person", id: bea.id } };
    expect(await tellTaskEnd(deps(), f.org.id, payload)).toBe(true);
    expect(await tellTaskEnd(deps(), f.org.id, payload)).toBe(false);
    expect(await noticesIn(dm.id)).toHaveLength(1);
  });

  test("background work that ends the task later is told by the job, in @dev's name", async () => {
    f = await setup({ rightHand: true });
    const { dm, c, issue, conversationId } = await handOver();
    await reported(c);
    const [work] = await f.db
      .insert(schema.agentWorks)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: conversationId,
        anchorMessageId: c.messageId,
        ownThread: false,
        title: "Campanha de Natal",
        issueId: issue.id,
        status: "done",
        how: "agent",
        lastUpdateAt: new Date(),
      })
      .returning();
    if (!work) throw new Error("no work");
    await setWorkIssueState(deps(), work, { ended: "done" });
    const [job] = await jobsOf(TASK_END_JOB);
    expect(job?.payload).toMatchObject({ issueId: issue.id, to: "done", by: { type: "agent", id: f.agent.id } });
    expect(job?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await noticesIn(dm.id)).toEqual([]);

    await drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + 5 * 60_000) });
    const [notice] = await noticesIn(dm.id);
    expect(said(notice)).toContain("is now done: @dev marked it.");
    expect(await noticesIn(dm.id)).toHaveLength(1);
  });

  test("nobody is woken when the requester made the change, or Lodi did it for them, or they asked the run that did", async () => {
    f = await setup({ rightHand: true });
    const own = await handOver(f.owner.id, "Eu mesma fecho");
    await reported(own.c);
    await updateIssue(deps(), person(f.owner.id), f.org.id, own.issue.id, { status: "done" });

    const forMe = await handOver(f.owner.id, "Lodi fecha por mim");
    await reported(forMe.c);
    const asked = await lodiTurn(f.owner.id, "fecha a tarefa do natal");
    await updateIssue(
      deps(),
      { type: "agent", agentId: forMe.lodi.id, channelId: forMe.dm.id, runId: asked.run.id },
      f.org.id,
      forMe.issue.id,
      { status: "done" },
    );

    const direct = await handOver(f.owner.id, "Pedi direto ao dev");
    await reported(direct.c);
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: direct.conversationId,
      threadId: direct.issue.conversationRootId ?? undefined,
      author: { type: "person", userId: f.owner.id },
      body: "pode fechar",
    });
    const [devRun] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: direct.conversationId,
        threadRootId: direct.issue.conversationRootId ?? said.id,
        triggerMessageId: said.id,
        trigger: "mention",
        hop: 1,
        status: "done",
      })
      .returning();
    await updateIssue(
      deps(),
      { type: "agent", agentId: f.agent.id, channelId: direct.conversationId, runId: devRun?.id },
      f.org.id,
      direct.issue.id,
      { status: "done" },
    );

    expect(await noticesIn(own.dm.id)).toEqual([]);
    for (const job of await jobsOf(TASK_END_JOB)) expect(await tellTaskEnd(deps(), f.org.id, job.payload)).toBe(false);
    expect(await noticesIn(own.dm.id)).toEqual([]);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("silent while the hand-over is still out, when its report came after the change or just before, and with the switch off", async () => {
    f = await setup({ rightHand: true });
    const bea = await addMember(f.db, f.org.id, "member", "bea");
    // Still out: what comes of it is reported by itself.
    const out = await handOver(f.owner.id, "Ainda com o dev");
    await updateIssue(deps(), person(bea.id), f.org.id, out.issue.id, { status: "done" });
    // Closed after the change: that report already tells the end.
    await f.db
      .update(schema.agentConsultations)
      .set({ status: "answered", answeredAt: new Date(Date.now() + HOUR) })
      .where(eq(schema.agentConsultations.id, out.c.id));
    for (const job of await jobsOf(TASK_END_JOB)) expect(await tellTaskEnd(deps(), f.org.id, job.payload)).toBe(false);

    // Reported a minute before the change: the run that reported also closed the task, and its report tells it.
    const same = await handOver(f.owner.id, "No mesmo fim");
    await reported(same.c);
    await f.db
      .update(schema.agentConsultations)
      .set({ answeredAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.agentConsultations.id, same.c.id));
    await updateIssue(deps(), person(bea.id), f.org.id, same.issue.id, { status: "done" });

    const off = await handOver(f.owner.id, "Sem lembrar");
    await reported(off.c);
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { remindOff: true });
    await updateIssue(deps(), person(bea.id), f.org.id, off.issue.id, { status: "done" });

    expect(await noticesIn(out.dm.id)).toEqual([]);
    // Their inbox still tells them: nothing was done for them there.
    const rows = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, f.owner.id), eq(schema.notifications.kind, "issue_status")));
    expect(rows.map((r) => r.doneAt)).toEqual([null, null, null]);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a requester who no longer sees the task, or left, is told nothing", async () => {
    f = await setup({ rightHand: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const hidden = await handOver(bob.id, "Ficou restrita");
    await reported(hidden.c);
    await f.db
      .update(schema.issues)
      .set({ restricted: true, audienceUserIds: [f.owner.id] })
      .where(eq(schema.issues.id, hidden.issue.id));
    await updateIssue(deps(), person(f.owner.id), f.org.id, hidden.issue.id, { status: "done" });
    expect(await noticesIn(hidden.dm.id)).toEqual([]);

    const gone = await handOver(bob.id, "Bob saiu");
    await reported(gone.c);
    await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, bob.id));
    await updateIssue(deps(), person(f.owner.id), f.org.id, gone.issue.id, { status: "done" });
    expect(await noticesIn(gone.dm.id)).toEqual([]);
    expect(await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.trigger, "dm"))).toHaveLength(2);
  });

  test(`past ${HANDED_TASK_WAKES_A_DAY} wakes in a person's day the notice is written and starts no turn, and their inbox keeps its row`, async () => {
    f = await setup({ rightHand: true });
    const bea = await addMember(f.db, f.org.id, "member", "bea");
    const handed = [];
    for (let i = 0; i <= HANDED_TASK_WAKES_A_DAY; i++) {
      const h = await handOver(f.owner.id, `Tarefa ${i}`);
      await reported(h.c);
      handed.push(h);
    }
    const dm = handed[0]?.dm.id ?? "";
    for (const h of handed) {
      await updateIssue(deps(), person(bea.id), f.org.id, h.issue.id, { status: "done" });
      // Each turn ends before the next news comes.
      await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.channelId, dm));
    }
    const notices = await noticesIn(dm);
    expect(notices).toHaveLength(HANDED_TASK_WAKES_A_DAY + 1);
    const ids = notices.map((n) => n.id);
    const turns = (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.channelId, dm))).filter((r) =>
      ids.includes(r.triggerMessageId),
    );
    expect(turns).toHaveLength(HANDED_TASK_WAKES_A_DAY);
    const slots = await f.db
      .select()
      .from(schema.outbox)
      .where(like(schema.outbox.dedupeKey, `${saidKey(f.org.id, `right_hand.task_wake:${f.owner.id}:`)}%`));
    expect(slots).toHaveLength(HANDED_TASK_WAKES_A_DAY);
    const open = (
      await f.db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, f.owner.id), eq(schema.notifications.kind, "issue_status")))
    ).filter((r) => r.doneAt === null);
    expect(open).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(0);
  });
});

describe("the daily look at a handed task", () => {
  test("says nothing about a task that ended or still moves, and looks again tomorrow only while it moves", async () => {
    f = await setup({ rightHand: true });
    const moving = await handOver(f.owner.id, "Andando");
    await reported(moving.c);
    await check(moving.c);
    expect(await noticesIn(moving.dm.id)).toEqual([]);
    const looks = await jobsOf(TASK_CHECK_JOB);
    expect(looks.map((j) => j.dedupeKey)).toContain(`${TASK_CHECK_JOB}:${moving.c.id}:2`);
    // The same look running twice queues one next look.
    await check(moving.c);
    expect(await jobsOf(TASK_CHECK_JOB)).toHaveLength(looks.length);
    // The last look queues none.
    await check(moving.c, HANDED_TASK_LOOKS);
    expect((await jobsOf(TASK_CHECK_JOB)).map((j) => j.dedupeKey)).not.toContain(
      `${TASK_CHECK_JOB}:${moving.c.id}:${HANDED_TASK_LOOKS + 1}`,
    );

    const ended = await handOver(f.owner.id, "Acabou");
    await reported(ended.c);
    await quiet(ended.issue, ended.conversationId);
    await f.db.update(schema.issues).set({ status: "done" }).where(eq(schema.issues.id, ended.issue.id));
    const before = (await jobsOf(TASK_CHECK_JOB)).length;
    await check(ended.c);
    expect(await jobsOf(TASK_CHECK_JOB)).toHaveLength(before);
    expect(await noticesIn(ended.dm.id)).toEqual([]);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("says once that a task stopped, in the requester's DM only, and stops looking", async () => {
    f = await setup({ rightHand: true });
    const bea = await addMember(f.db, f.org.id, "member", "bea");
    const other = await lodiTurn(bea.id, "oi");
    const { lodi, dm, run, c, issue, conversationId } = await handOver();
    await reported(c);
    await quiet(issue, conversationId);
    const looksBefore = (await jobsOf(TASK_CHECK_JOB)).length;

    await check(c);
    await check(c);
    await check(c, 2);

    const notices = await noticesIn(dm.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.authorAgentId).toBe(lodi.id);
    expect(isAgentOnlyNotice(notices[0]?.meta)).toBe(true);
    expect(notices[0]?.meta.notice).toMatchObject({
      kind: "wait_result",
      refs: { task: issue.id, state: "stuck", runId: run.id },
    });
    const text = said(notices[0]);
    expect(text).toContain("is not finished (in_progress) and has not moved since");
    expect(text).toContain("Nobody is working on it and nothing in its conversation waits on a person.");
    expect(await jobsOf(TASK_CHECK_JOB)).toHaveLength(looksBefore);
    expect(await noticesIn(other.dm.id)).toEqual([]);
    const woken = (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.channelId, dm.id))).filter(
      (r) => r.triggerMessageId === notices[0]?.id,
    );
    expect(woken).toHaveLength(1);
    // The look itself called no model, and no person was notified of the notice.
    expect(f.provider.calls).toHaveLength(0);
    expect(await f.db.select().from(schema.notifications)).toEqual([]);
  });

  test("names who it waits on from the task's own conversation, even while the hand-over is still out", async () => {
    f = await setup({ rightHand: true });
    const bea = await addMember(f.db, f.org.id, "member", "bea");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const { dm, c, issue, conversationId } = await handOver();
    await quiet(issue, conversationId);
    const waiting = (userId: string, channelId: string, kind = "approval") => ({
      orgId: f.org.id,
      userId,
      kind,
      waiting: true,
      groupKey: `${kind}:${userId}:${channelId}`,
      source: { channelId },
    });
    await f.db
      .insert(schema.notifications)
      .values([waiting(bea.id, conversationId), waiting(caio.id, f.general.id, "agent_question")]);

    await check(c);

    const [notice] = await noticesIn(dm.id);
    const text = said(notice);
    expect(text).toContain("It waits on bea (an approval).");
    expect(text).not.toContain("caio");
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a run paused on something else is said as that, and one at work keeps it looking", async () => {
    f = await setup({ rightHand: true });
    const paused = await handOver(f.owner.id, "Pausada");
    await reported(paused.c);
    await quiet(paused.issue, paused.conversationId);
    const runOf = (c: { targetRunId: string | null }) => eq(schema.agentRuns.id, c.targetRunId ?? "");
    await f.db.update(schema.agentRuns).set({ status: "waiting_input" }).where(runOf(paused.c));
    await check(paused.c);
    expect(said((await noticesIn(paused.dm.id))[0])).toContain(
      "@dev's run there is paused and nobody has what it waits on in their inbox",
    );

    const atWork = await handOver(f.owner.id, "Trabalhando");
    await reported(atWork.c);
    await quiet(atWork.issue, atWork.conversationId);
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(runOf(atWork.c));
    await check(atWork.c);
    expect(await noticesIn(paused.dm.id)).toHaveLength(1);
    expect((await jobsOf(TASK_CHECK_JOB)).map((j) => j.dedupeKey)).toContain(`${TASK_CHECK_JOB}:${atWork.c.id}:2`);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("silent when it waits on the requester, when the hand-over is out with nobody asked, and when it failed", async () => {
    f = await setup({ rightHand: true });
    const onMe = await handOver(f.owner.id, "Espera por mim");
    await reported(onMe.c);
    await quiet(onMe.issue, onMe.conversationId);
    await f.db.insert(schema.notifications).values({
      orgId: f.org.id,
      userId: f.owner.id,
      kind: "agent_question",
      waiting: true,
      groupKey: "agent_question:q1",
      source: { channelId: onMe.conversationId },
    });
    await check(onMe.c);
    expect((await jobsOf(TASK_CHECK_JOB)).map((j) => j.dedupeKey)).toContain(`${TASK_CHECK_JOB}:${onMe.c.id}:2`);

    const out = await handOver(f.owner.id, "Ainda fora");
    await quiet(out.issue, out.conversationId);
    await check(out.c);
    expect((await jobsOf(TASK_CHECK_JOB)).map((j) => j.dedupeKey)).toContain(`${TASK_CHECK_JOB}:${out.c.id}:2`);

    // Its failure was told when the hand-over closed.
    const failed = await handOver(f.owner.id, "Falhou");
    await reported(failed.c, "failed");
    await quiet(failed.issue, failed.conversationId);
    await check(failed.c);
    expect((await jobsOf(TASK_CHECK_JOB)).map((j) => j.dedupeKey)).not.toContain(`${TASK_CHECK_JOB}:${failed.c.id}:2`);

    const off = await handOver(f.owner.id, "Desligado");
    await reported(off.c);
    await quiet(off.issue, off.conversationId);
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { remindOff: true });
    await check(off.c);

    expect(await noticesIn(onMe.dm.id)).toEqual([]);
    expect(f.provider.calls).toHaveLength(0);
  });
});

describe("keeping its word", () => {
  const remind = (userId: string, channelId: string, message: string, askAgent = false) =>
    lodiOf().then((lodi) =>
      createReminder({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, {
        agentId: lodi.id,
        channelId,
        threadId: null,
        at: new Date(Date.now() + DAY),
        timezone: "America/Sao_Paulo",
        description: "tomorrow",
        message,
        askAgent,
      }),
    );

  test("the block is in Lodi's DM prompt, lists only that person's reminders there, and goes with the switch", async () => {
    f = await setup({ rightHand: true });
    const bea = await addMember(f.db, f.org.id, "member", "bea");
    const mine = await lodiTurn(f.owner.id, "oi");
    const theirs = await lodiTurn(bea.id, "oi");
    const ctx = { orgId: f.org.id, agentId: mine.lodi.id, personId: f.owner.id };

    const empty = await keepingWordBlock(f.db, ctx);
    expect(empty).toStartWith("# Keeping your word");
    expect(empty).toContain("No reminder waits here.");
    expect(empty).toContain(`At most ${KEPT_REMINDERS_MAX} reminders you set by yourself wait here at once.`);
    expect(await lodiPromptBlocks(f.db, ctx, [followLane])).toEqual([empty]);

    const own = await remind(f.owner.id, mine.dm.id, "mandar o contrato");
    const acts = await remind(f.owner.id, mine.dm.id, "conferir os números", true);
    await remind(bea.id, theirs.dm.id, "segredo da bea");
    await remind(f.owner.id, f.general.id, "no canal");
    const block = await keepingWordBlock(f.db, ctx);
    expect(block).toContain(`- ${own.id}: "mandar o contrato" at `);
    expect(block).toContain(`- ${acts.id}: "conferir os números" at `);
    expect(block).toContain("(America/Sao_Paulo), you act then");
    expect(block).not.toContain("segredo da bea");
    expect(block).not.toContain("no canal");

    // Three it keeps by itself: no more until one comes.
    await remind(f.owner.id, mine.dm.id, "dois");
    await remind(f.owner.id, mine.dm.id, "três");
    expect(await keepingWordBlock(f.db, ctx)).toContain("set no more by yourself");

    await setLodiPrefs(f.db, f.org.id, f.owner.id, { remindOff: true });
    expect(await keepingWordBlock(f.db, ctx)).toBe("");
    expect(await lodiPromptBlocks(f.db, ctx, [followLane])).toEqual([]);
    // One person's switch is theirs alone.
    expect(await keepingWordBlock(f.db, { ...ctx, personId: bea.id })).toContain("segredo da bea");
  });

  test("a reminder it set fires once at its time, as its message to that person, with no model call", async () => {
    f = await setup({ rightHand: true });
    const { lodi, dm } = await lodiTurn(f.owner.id, "vou te mandar o contrato sexta");
    const set = await remind(f.owner.id, dm.id, "mandar o contrato");
    const fire = async () => {
      await f.db
        .update(schema.routines)
        .set({ nextRunAt: new Date(Date.now() - 60_000) })
        .where(and(eq(schema.routines.id, set.id), eq(schema.routines.active, true)));
      await fireDueRoutines({ db: f.db, pubsub: f.pubsub, context: f.context });
      await drainOutbox(f.db, f.handlers);
    };
    await fire();
    await fire();
    const posted = (await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id))).filter(
      (m) => m.meta.reminder === true,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ authorAgentId: lodi.id, meta: { reminderText: "mandar o contrato" } });
    expect(f.provider.calls).toHaveLength(0);
    // And it left the list.
    expect(await keepingWordBlock(f.db, { orgId: f.org.id, agentId: lodi.id, personId: f.owner.id })).toContain(
      "No reminder waits here.",
    );
  });
});
