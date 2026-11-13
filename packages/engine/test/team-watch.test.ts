import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  closeRoutineRun,
  executeRoutineRun,
  liveLodiSwitches,
  markNotificationDone,
  RIGHT_HAND,
  renderPush,
  routineFailureEnd,
} from "../src";
import { OUTSIDE_RUN_ERRORS, outsideRoutineFailure, ROUTINE_RETRY_AFTER_MS } from "../src/routine-ledger";
import {
  enqueueTeamWatches,
  runTeamWatch,
  TEAM_WATCH_DAILY_ROWS,
  TEAM_WATCH_JOB,
  teamWatchLane,
  teamWatchNames,
} from "../src/team-watch";
import { addMember, type Fixture, setup } from "./fixtures";
import {
  agentRunRow,
  channelRoutine,
  fire,
  minutesFromNow,
  notificationsOf,
  routineDeps,
  routineRow,
  routineRunRow,
} from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Wednesday 2026-11-11, 15:00 UTC: daytime where nobody chose a time zone, a third of the month gone. */
const NOW = new Date("2026-11-11T15:00:00Z");
const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms);

const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};
const watch = (now = NOW) => runTeamWatch(f.jobDeps, f.org.id, now);
const rows = () => notificationsOf(f, "team_watch");
const checks = async () =>
  (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, TEAM_WATCH_JOB))).length;
const setSwitch = (teamWatch: boolean) =>
  f.db
    .insert(schema.organizationSettings)
    .values({ orgId: f.org.id, teamWatch })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { teamWatch } });

const computer = async (values: Partial<typeof schema.machines.$inferInsert> = {}) => {
  const [machine] = await f.db
    .insert(schema.machines)
    .values({ orgId: f.org.id, name: "Mac da Ana", pairedByUserId: f.owner.id, lastSeenAt: ago(2 * HOUR), ...values })
    .returning();
  if (!machine) throw new Error("no machine");
  return machine;
};

/** A plan's sign-in on a computer, thinking for all of its owner's agents there. */
const plan = async (values: Partial<typeof schema.machineAccounts.$inferInsert> = {}) => {
  const machine = await computer({ lastSeenAt: NOW, online: true });
  const id = crypto.randomUUID();
  await f.db.insert(schema.machineAccounts).values({
    id,
    orgId: f.org.id,
    machineId: machine.id,
    kind: "claude_code",
    label: "Trabalho",
    status: "signed_out",
    shared: true,
    createdBy: f.owner.id,
    updatedAt: ago(HOUR),
    ...values,
  });
  return id;
};

const connector = async (label: string, values: Partial<typeof schema.connectorConnections.$inferInsert> = {}) => {
  const [row] = await f.db
    .insert(schema.connectorConnections)
    .values({
      orgId: f.org.id,
      connector: label.toLowerCase(),
      label,
      toolPrefix: label.toLowerCase(),
      serverUrl: `https://${label.toLowerCase()}.example.com/mcp`,
      authType: "none",
      status: "needs_reconnect",
      createdByUserId: f.owner.id,
      updatedAt: ago(HOUR),
      ...values,
    })
    .returning();
  if (!row) throw new Error("no connector");
  return row;
};

const spend = (agentId: string, spentNanoUsd: number, now = NOW) =>
  f.db
    .insert(schema.agentBudgetPeriods)
    .values({ orgId: f.org.id, agentId, periodStart: `${now.toISOString().slice(0, 7)}-01`, spentNanoUsd })
    .onConflictDoUpdate({
      target: [schema.agentBudgetPeriods.agentId, schema.agentBudgetPeriods.periodStart],
      set: { spentNanoUsd },
    });

/** Something waiting on a person in "Esperando você". */
const ask = async (userId: string, at: Date, values: Partial<typeof schema.notifications.$inferInsert> = {}) => {
  const [row] = await f.db
    .insert(schema.notifications)
    .values({
      orgId: f.org.id,
      userId,
      kind: "agent_question",
      waiting: true,
      groupKey: `agent_question:${crypto.randomUUID()}`,
      actors: [{ type: "agent", id: f.agent.id }],
      latest: { text: "Qual das duas?" },
      createdAt: at,
      updatedAt: at,
      ...values,
    })
    .returning();
  if (!row) throw new Error("no notification");
  return row;
};
const reread = async (id: string) => {
  const [row] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.id, id));
  if (!row) throw new Error("no notification");
  return row;
};

describe("the sweep", () => {
  test("a healthy workspace gets no check, a problem gets one per window, the switch off none", async () => {
    f = await setup({ rightHand: true });
    expect(teamWatchLane.live).toBe(true);
    expect(liveLodiSwitches()).toContain("teamWatch");
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);

    // A blip tells nobody: under the grace there is nothing to look at.
    const slack = await connector("Slack", { updatedAt: ago(5 * MIN) });
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);
    await f.db
      .update(schema.connectorConnections)
      .set({ updatedAt: ago(HOUR) })
      .where(eq(schema.connectorConnections.id, slack.id));

    await setSwitch(false);
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);
    await setSwitch(true);
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(1);
    expect(await enqueueTeamWatches(f.db, new Date(NOW.getTime() + MIN))).toBe(0);
    expect(await enqueueTeamWatches(f.db, new Date(NOW.getTime() + 10 * MIN))).toBe(1);
    expect(await checks()).toBe(2);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a workspace without the right hand, or closed, gets none", async () => {
    f = await setup();
    await connector("Slack");
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);
    await f.close();

    f = await setup({ rightHand: true });
    await connector("Slack");
    await f.db.update(schema.organizations).set({ standing: "suspended" }).where(eq(schema.organizations.id, f.org.id));
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);
    await watch();
    expect(await rows()).toHaveLength(0);
  });

  test("an ask left unread for hours is something to look at only in that person's daytime", async () => {
    f = await setup({ rightHand: true });
    await ask(f.owner.id, ago(5 * HOUR));
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(1);
    // 15:00 UTC is midnight in Tokyo.
    await f.db
      .update(schema.organizationMembers)
      .set({ timezone: "Asia/Tokyo" })
      .where(eq(schema.organizationMembers.userId, f.owner.id));
    expect(await enqueueTeamWatches(f.db, new Date(NOW.getTime() + 10 * MIN))).toBe(0);
  });
});

describe("what it tells", () => {
  test("a sign-in that ended tells its owner once, in their language, and leaves when it is back", async () => {
    f = await setup({ rightHand: true });
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const lodi = await lodiOf();
    const accountId = await plan();
    await watch();
    await watch();
    const [row] = await rows();
    expect(await rows()).toHaveLength(1);
    expect(row).toMatchObject({
      userId: f.owner.id,
      waiting: true,
      count: 1,
      actors: [{ type: "agent", id: lodi.id }],
      source: { accountId },
      latest: {
        reason: "sign_in",
        names: ["Trabalho"],
        text: "O login de IA acabou: Trabalho. Entre de novo em Configurações",
      },
    });
    // A plan is its owner's alone.
    expect((await rows()).some((r) => r.userId === admin.id)).toBe(false);

    await f.db.update(schema.machineAccounts).set({ status: "active" }).where(eq(schema.machineAccounts.id, accountId));
    await watch(new Date(NOW.getTime() + 10 * MIN));
    expect((await rows())[0]?.doneAt).not.toBeNull();
    expect(f.provider.calls).toHaveLength(0);
  });

  test("put away with Feito, the same problem never returns, and a new one of that cause does", async () => {
    f = await setup({ rightHand: true });
    await connector("Slack");
    await watch();
    const [first] = await rows();
    await markNotificationDone({ db: f.db }, f.owner.id, f.org.id, first?.id ?? "", true);
    await watch(new Date(NOW.getTime() + 10 * MIN));
    await watch(new Date(NOW.getTime() + 26 * HOUR));
    expect(await rows()).toHaveLength(1);

    await connector("Notion", { updatedAt: ago(-25 * HOUR) });
    await watch(new Date(NOW.getTime() + 27 * HOUR));
    const all = await rows();
    expect(all).toHaveLength(2);
    // The new row lists what is wrong now, the one put away included: it is still to reconnect.
    expect(all.find((r) => !r.doneAt)).toMatchObject({ count: 2, latest: { names: ["Slack", "Notion"] } });
  });

  test("several of one cause are one row, rewritten in place as the list changes", async () => {
    f = await setup({ rightHand: true });
    const slack = await connector("Slack", { updatedAt: ago(3 * HOUR) });
    await connector("Notion", { updatedAt: ago(2 * HOUR) });
    await watch();
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({
      count: 2,
      latest: { text: "Precisa reconectar: Slack, Notion. Reconecte em Configurações" },
    });

    await connector("Linear", { updatedAt: ago(HOUR) });
    await connector("Sentry", { updatedAt: ago(HOUR) });
    await f.db.update(schema.notifications).set({ readAt: NOW }).where(eq(schema.notifications.kind, "team_watch"));
    await watch(new Date(NOW.getTime() + 10 * MIN));
    const [grown] = await rows();
    expect(await rows()).toHaveLength(1);
    // Something new in it: unread again, with no second row.
    expect(grown).toMatchObject({ count: 4, readAt: null, latest: { names: ["Slack", "Notion", "Linear"] } });
    expect(String(grown?.latest.text)).toContain("Slack, Notion, Linear +1");

    await f.db
      .update(schema.connectorConnections)
      .set({ status: "active" })
      .where(eq(schema.connectorConnections.id, slack.id));
    await watch(new Date(NOW.getTime() + 20 * MIN));
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ count: 3, doneAt: null });
    expect(teamWatchNames(["a", "b", "c", "d", "e"])).toBe("a, b, c +2");
  });

  test("a connector goes to who connected it while they manage connectors, else to who does", async () => {
    f = await setup({ rightHand: true });
    const member = await addMember(f.db, f.org.id, "member", "caio");
    await connector("Slack", { createdByUserId: member.id });
    await connector("Banco", { createdByUserId: null });
    await watch();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ userId: f.owner.id, count: 2 });
  });

  test("a mailbox reaches only its owner, and one nobody owns reaches nobody", async () => {
    f = await setup({ rightHand: true });
    const member = await addMember(f.db, f.org.id, "member", "caio");
    await addMember(f.db, f.org.id, "admin", "bia");
    const mailbox = {
      orgId: f.org.id,
      provider: "imap",
      via: "imap",
      status: "needs_reconnect",
      updatedAt: ago(HOUR),
    };
    await f.db.insert(schema.mailAccounts).values([
      { ...mailbox, address: "caio@example.com", createdByUserId: member.id },
      { ...mailbox, address: "suporte@example.com", createdByUserId: null },
    ]);
    await watch();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ userId: member.id, latest: { reason: "mailbox", names: ["caio@example.com"] } });
  });

  test("a database to reconnect is told to who manages connectors", async () => {
    f = await setup({ rightHand: true });
    await f.db.insert(schema.dbConnections).values({
      orgId: f.org.id,
      label: "Produção",
      host: "db.example.com",
      database: "app",
      username: "reader",
      secretCiphertext: "v1.x.y.z",
      wrappedDataKey: "k",
      kekId: "local:v1",
      status: "needs_reconnect",
      createdByUserId: f.owner.id,
    });
    await watch();
    expect((await rows())[0]).toMatchObject({ userId: f.owner.id, waiting: true, latest: { reason: "database" } });
  });

  test("a budget used up waits on who may raise it. One about to end is a plain row, only on pace to end early", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    const member = await addMember(f.db, f.org.id, "member", "caio");
    // Its owner may not raise a budget: the workspace's owner hears it.
    await f.db.update(schema.agents).set({ ownerUserId: member.id }).where(eq(schema.agents.id, f.agent.id));
    await spend(f.agent.id, 8_500_000_000);
    await watch();
    const [low] = await rows();
    expect(low).toMatchObject({
      userId: f.owner.id,
      waiting: false,
      source: { agentId: f.agent.id },
      latest: { reason: "budget_low", names: ["Dev"] },
    });

    await f.db.update(schema.agentBudgetPeriods).set({ spentNanoUsd: 10_000_000_000 });
    await watch(new Date(NOW.getTime() + 10 * MIN));
    const all = await rows();
    expect(all.find((r) => r.id === low?.id)?.doneAt).not.toBeNull();
    expect(all.find((r) => !r.doneAt)).toMatchObject({ waiting: true, latest: { reason: "budget_out" } });
    // It raises nothing itself.
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.monthlyBudgetNanoUsd).toBe(10_000_000_000);
  });

  test("85% of a budget on the 29th tells nobody", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    const late = new Date("2026-11-29T15:00:00Z");
    await spend(f.agent.id, 8_500_000_000, late);
    await watch(late);
    expect(await rows()).toHaveLength(0);
  });

  test("a brought computer gone with a run waiting is told to who paired it. Idle, or the workspace's own, is not", async () => {
    f = await setup({ rightHand: true });
    const idle = await computer({ name: "Ocioso" });
    const own = await computer({ name: "Da casa", kind: "managed" });
    const mac = await computer();
    await watch();
    expect(await rows()).toHaveLength(0);

    const run = {
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      triggerMessageId: crypto.randomUUID(),
      threadRootId: crypto.randomUUID(),
      trigger: "mention" as const,
      hop: 0,
    };
    await f.db.insert(schema.agentRuns).values([
      { ...run, waitingMachineId: mac.id },
      { ...run, triggerMessageId: crypto.randomUUID(), waitingMachineId: own.id },
    ]);
    expect(idle.id).not.toBe(mac.id);
    await watch();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      userId: f.owner.id,
      source: { machineId: mac.id },
      latest: { reason: "computer", names: ["Mac da Ana"] },
    });
    // Under half an hour gone tells nobody.
    await f.db.update(schema.notifications).set({ doneAt: NOW }).where(eq(schema.notifications.kind, "team_watch"));
    const blip = await computer({ name: "Piscou", lastSeenAt: ago(10 * MIN) });
    await f.db
      .insert(schema.agentRuns)
      .values({ ...run, triggerMessageId: crypto.randomUUID(), waitingMachineId: blip.id });
    await watch(new Date(NOW.getTime() + MIN));
    expect((await rows()).filter((r) => !r.doneAt)).toHaveLength(0);
  });

  test("what another notice already told the person gets no second row, now or later", async () => {
    f = await setup({ rightHand: true });
    await plan();
    await f.db.insert(schema.notifications).values({
      orgId: f.org.id,
      userId: f.owner.id,
      kind: "run_failed",
      groupKey: "run_failed:x",
      latest: { reason: "not_logged_in", plan: "Trabalho" },
      createdAt: ago(30 * MIN),
      updatedAt: ago(30 * MIN),
    });
    await watch();
    expect(await rows()).toHaveLength(0);
    // That notice gone, the same sign-in is still not told twice.
    await f.db.delete(schema.notifications);
    await watch(new Date(NOW.getTime() + 10 * MIN));
    expect(await rows()).toHaveLength(0);
  });

  test("a budget's end or a computer's absence another notice told is not told again", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    await spend(f.agent.id, 10_000_000_000);
    const mac = await computer();
    await f.db.insert(schema.agentRuns).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      triggerMessageId: crypto.randomUUID(),
      threadRootId: crypto.randomUUID(),
      trigger: "mention",
      hop: 0,
      waitingMachineId: mac.id,
    });
    const told = { orgId: f.org.id, userId: f.owner.id, createdAt: ago(30 * MIN), updatedAt: ago(30 * MIN) };
    await f.db.insert(schema.notifications).values([
      { ...told, kind: "routine_failed", groupKey: "routine_failed:x", latest: { reason: "budget_exceeded" } },
      { ...told, kind: "routine_stalled", groupKey: "routine_stalled:x", source: { machineId: mac.id } },
    ]);
    await watch();
    expect(await rows()).toHaveLength(0);
  });

  test("at most three new rows a person a day, the rest told on a later day", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    await plan();
    await connector("Slack");
    await spend(f.agent.id, 10_000_000_000);
    await f.db.insert(schema.dbConnections).values({
      orgId: f.org.id,
      label: "Produção",
      host: "db.example.com",
      database: "app",
      username: "reader",
      secretCiphertext: "v1.x.y.z",
      wrappedDataKey: "k",
      kekId: "local:v1",
      status: "needs_reconnect",
      createdByUserId: f.owner.id,
    });
    await watch();
    await watch(new Date(NOW.getTime() + 10 * MIN));
    expect(await rows()).toHaveLength(TEAM_WATCH_DAILY_ROWS);
    await watch(new Date(NOW.getTime() + 25 * HOUR));
    expect(await rows()).toHaveLength(4);
  });

  test("with the switch off the job tells nothing", async () => {
    f = await setup({ rightHand: true });
    await connector("Slack");
    await setSwitch(false);
    await watch();
    expect(await rows()).toHaveLength(0);
  });
});

describe("what it fixes", () => {
  const DOWN = "provider_error: down@Claude: 529 overloaded";
  const ledger = () => ({ db: f.db, pubsub: f.pubsub });
  /** One run of the routine that fails with `error`, as a failed run leaves it. */
  const failRun = async (routineRunId: string, error: string) => {
    const rr = await routineRunRow(f, routineRunId);
    const run = await agentRunRow(f, rr.agentRunId);
    await f.db.update(schema.agentRuns).set({ status: "failed", error }).where(eq(schema.agentRuns.id, run.id));
    await closeRoutineRun(ledger(), run, { status: "failed", ...routineFailureEnd(error) });
  };
  const failOnce = async (routineId: string, minutesAgo: number, error: string) =>
    failRun((await fire(f, routineId, minutesFromNow(-minutesAgo))).id, error);
  const slotIn = (routineId: string, minutes: number) =>
    f.db
      .update(schema.routines)
      .set({ nextRunAt: minutesFromNow(minutes) })
      .where(eq(schema.routines.id, routineId));
  const farSlot = (routineId: string) => slotIn(routineId, 5 * 60);

  test("which failures are outside the routine", () => {
    for (const error of [
      DOWN,
      "provider_error: timeout@Claude: no answer",
      "provider_error: unreachable@Claude: ECONNRESET",
      "provider_error: rate_limit@Claude: 429",
      "gave_up: still down",
      "timeout",
      "runner_error",
      "brain_interrupted: cut",
      "Interrupted by a server restart",
    ])
      expect([error, outsideRoutineFailure("provider_error", error)]).toEqual([error, true]);
    expect(outsideRoutineFailure("lost", null)).toBe(true);
    for (const error of [
      "provider_error: invalid_key@Claude: refused",
      "provider_error: no_credit@Claude: out of credit",
      "budget_exceeded",
      "too_many_tool_calls",
      "empty_reply",
      "agent_archived",
      "no_ai",
      null,
    ])
      expect([error, outsideRoutineFailure("error", error)]).toEqual([error, false]);
    expect(OUTSIDE_RUN_ERRORS.size).toBeGreaterThan(1);
  });

  test("a first outside failure is tried once more before anyone is told, and told when that fails too", async () => {
    f = await setup({ rightHand: true });
    const routine = await channelRoutine(f);
    await farSlot(routine.id);
    await failOnce(routine.id, 30, DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(0);
    const queued = (await f.db.select().from(schema.routineRuns)).filter((r) => r.status === "queued");
    expect(queued).toHaveLength(1);
    const retry = queued[0];
    const wait = (retry?.at.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(ROUTINE_RETRY_AFTER_MS - MIN);
    expect(wait).toBeLessThanOrEqual(ROUTINE_RETRY_AFTER_MS);
    const [job] = await f.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.dedupeKey, `routine.run:${retry?.id}`));
    expect(job?.nextAttemptAt.getTime()).toBe(retry?.at.getTime());

    await executeRoutineRun(routineDeps(f), retry?.id ?? "");
    await failRun(retry?.id ?? "", DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
    // Once between two good runs: the next failures queue nothing and tell nothing more.
    await failOnce(routine.id, 20, DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
    expect((await f.db.select().from(schema.routineRuns)).filter((r) => r.status === "queued")).toHaveLength(0);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a failure of the routine's own, a close slot or the switch off is told at once, with no retry", async () => {
    f = await setup({ rightHand: true });
    const own = await channelRoutine(f, { name: "Própria" });
    await farSlot(own.id);
    await failOnce(own.id, 30, "provider_error: invalid_key@Claude: refused");
    const close = await channelRoutine(f, { name: "Perto" });
    await slotIn(close.id, 30);
    await failOnce(close.id, 30, DOWN);
    await setSwitch(false);
    const off = await channelRoutine(f, { name: "Desligada" });
    await farSlot(off.id);
    await failOnce(off.id, 30, DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(3);
    expect((await f.db.select().from(schema.routineRuns)).filter((r) => r.status === "queued")).toHaveLength(0);
  });

  test("a routine paused for outside causes is resumed once, silently. Paused again, it stays", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const routine = await channelRoutine(f);
    // Its next slot is close, so the slot itself is the retry and the first failure is told as always.
    await slotIn(routine.id, 30);
    for (const minutesAgo of [50, 40, 30, 20, 10]) await failOnce(routine.id, minutesAgo, DOWN);
    expect(await routineRow(f, routine.id)).toMatchObject({ active: false, pausedReason: "failing" });
    expect(await notificationsOf(f, "routine_paused")).toHaveLength(1);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);

    // Too soon after the pause: an outage needs time to pass.
    await watch(new Date(Date.now() + 5 * MIN));
    expect((await routineRow(f, routine.id)).active).toBe(false);

    await watch(new Date(Date.now() + 45 * MIN));
    const resumed = await routineRow(f, routine.id);
    expect(resumed).toMatchObject({ active: true, pausedReason: null, failuresInRow: 0 });
    expect(resumed.nextRunAt).not.toBeNull();
    const audit = (await f.db.select().from(schema.auditLog)).filter((a) => a.action === "routine.resumed");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "agent", actorId: lodi.id, targetId: routine.id });
    expect((await notificationsOf(f, "routine_paused"))[0]?.doneAt).not.toBeNull();
    // What it fixed is said to nobody.
    expect(await rows()).toHaveLength(0);

    await slotIn(routine.id, 30);
    for (const minutesAgo of [9, 8, 7, 6, 5]) await failOnce(routine.id, minutesAgo, DOWN);
    expect((await routineRow(f, routine.id)).active).toBe(false);
    await watch(new Date(Date.now() + 45 * MIN));
    expect((await routineRow(f, routine.id)).active).toBe(false);
    // One pause notice each time it paused, and no second "failed" after the resume.
    expect(await notificationsOf(f, "routine_paused")).toHaveLength(2);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a routine failing for its own reasons, or one paused for another reason, is left paused", async () => {
    f = await setup({ rightHand: true });
    const own = await channelRoutine(f);
    await slotIn(own.id, 30);
    for (const minutesAgo of [50, 40, 30, 20]) await failOnce(own.id, minutesAgo, DOWN);
    await failOnce(own.id, 10, "too_many_tool_calls");
    const left = await channelRoutine(f, { name: "Saiu" });
    await f.db
      .update(schema.routines)
      .set({ active: false, nextRunAt: null, pausedReason: "creator_left" })
      .where(eq(schema.routines.id, left.id));
    await watch(new Date(Date.now() + 45 * MIN));
    expect(await routineRow(f, own.id)).toMatchObject({ active: false, pausedReason: "failing" });
    expect(await routineRow(f, left.id)).toMatchObject({ active: false, pausedReason: "creator_left" });
  });
});

describe("what it reminds of", () => {
  test("one reminder a day for everything left unread, never the same thing twice", async () => {
    f = await setup({ rightHand: true });
    const oldest = await ask(f.owner.id, ago(8 * HOUR));
    const other = await ask(f.owner.id, ago(5 * HOUR), { kind: "secret_request", groupKey: "secret:1" });
    const read = await ask(f.owner.id, ago(6 * HOUR), { readAt: ago(HOUR) });
    const recent = await ask(f.owner.id, ago(HOUR));
    await watch();
    expect((await reread(oldest.id)).latest).toMatchObject({ reminder: true, still: 2 });
    expect((await reread(oldest.id)).updatedAt.getTime()).toBe(NOW.getTime());
    // Reminded with the first one: marked, not moved, so no second push.
    expect((await reread(other.id)).latest.reminder).toBe(true);
    expect((await reread(other.id)).updatedAt.getTime()).toBe(other.updatedAt.getTime());
    expect((await reread(read.id)).latest.reminder).toBeUndefined();
    expect((await reread(read.id)).readAt).not.toBeNull();
    expect((await reread(recent.id)).latest.reminder).toBeUndefined();

    // Later the same day what became old waits for tomorrow, and yesterday's are not said again.
    const later = new Date(NOW.getTime() + 3.5 * HOUR);
    await watch(later);
    expect((await reread(recent.id)).latest.reminder).toBeUndefined();
    const tomorrow = new Date(NOW.getTime() + 24 * HOUR);
    await watch(tomorrow);
    expect((await reread(recent.id)).latest).toMatchObject({ reminder: true, still: 1 });
    expect((await reread(oldest.id)).updatedAt.getTime()).toBe(NOW.getTime());
    expect(f.provider.calls).toHaveLength(0);
  });

  test("nothing at night in the person's own time zone", async () => {
    f = await setup({ rightHand: true });
    await f.db
      .update(schema.organizationMembers)
      .set({ timezone: "Asia/Tokyo" })
      .where(eq(schema.organizationMembers.userId, f.owner.id));
    const row = await ask(f.owner.id, ago(8 * HOUR));
    await watch();
    expect((await reread(row.id)).latest.reminder).toBeUndefined();
    // 01:00 UTC is 10:00 in Tokyo.
    await watch(new Date("2026-11-12T01:00:00Z"));
    expect((await reread(row.id)).latest.reminder).toBe(true);
  });

  test("a reminder's push says how many things wait, and a notice's push is its whole sentence", () => {
    const reminder = renderPush("en", {
      kind: "agent_question",
      waiting: true,
      actorName: "Dev",
      actorType: "agent",
      text: "Which one?",
      still: 3,
    });
    expect(reminder.title).toBe("3 things still wait on you");
    expect(reminder.body).toContain("Dev");
    expect(renderPush("pt-BR", { kind: "agent_question", waiting: true, still: 1 }).title).toBe(
      "1 coisa ainda espera você",
    );
    expect(
      renderPush("en", {
        kind: "team_watch",
        waiting: true,
        actorName: "Lodi",
        actorType: "agent",
        text: "AI sign-in ended: Work. Sign in again in Settings",
      }),
    ).toEqual({ title: "Lodi", body: "AI sign-in ended: Work. Sign in again in Settings" });
  });
});
