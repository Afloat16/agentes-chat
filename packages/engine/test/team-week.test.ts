import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, schema, sql } from "@agenteschat/db";
import { en, STRINGS } from "@agenteschat/i18n";
import {
  actOnTeamWeek,
  createSetupToolSource,
  createToolGateway,
  decideProposal,
  enqueueTeamWeeks,
  getLodiPrefs,
  insertMessage,
  LODI_PREFS_DEFAULTS,
  lastTeamWeekSlot,
  lodiPrefsOf,
  notify,
  notifyMessage,
  openPersonAgentDm,
  postPersonMessage,
  postTeamWeek,
  RIGHT_HAND,
  requestKey,
  SET_TEAM_WEEK_TOOL,
  setLodiPrefs,
  TEAM_DAY_JOB,
  TEAM_WEEK_JOB,
  type TeamWeekCard,
  teamWeekCardOf,
  weekKey,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = "America/Sao_Paulo";
/** Friday 2026-11-06, 17:00 in São Paulo (UTC-3). */
const SLOT = new Date("2026-11-06T20:00:00Z");

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

async function inZone(fx: Fixture) {
  await fx.db
    .insert(schema.organizationSettings)
    .values({ orgId: fx.org.id, timezone: ZONE })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { timezone: ZONE } });
}

const jobs = (fx: Fixture) =>
  fx.db
    .select()
    .from(schema.outbox)
    .where(inArray(schema.outbox.kind, [TEAM_WEEK_JOB, TEAM_DAY_JOB]));

const run = (fx: Fixture, agentId: string, at: Date, status: "done" | "failed", error?: string) =>
  fx.db.insert(schema.agentRuns).values({
    orgId: fx.org.id,
    agentId,
    channelId: fx.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
    trigger: "mention",
    hop: 1,
    status,
    error: error ?? null,
    createdAt: at,
  });

/** A run that parked at its budget and has since resumed: only its "budget ran out" note is left. */
const budgetStop = (fx: Fixture, at: Date) =>
  insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "agent", agentId: fx.agent.id, runId: null, hop: 1, stretchId: null },
    body: "My budget for the month ran out.",
    meta: { bodyCode: "budget_wait", usageWait: { code: "budget", runId: crypto.randomUUID() } },
    createdAt: at,
  });

describe("when it comes", () => {
  test("Friday at 17h in the workspace's zone by default; one card per person and week", () => {
    const prefs = lodiPrefsOf({});
    expect(prefs).toMatchObject({ weekOff: false, day: 5, weekHour: 17 });
    expect(lodiPrefsOf({ day: 9, hour: -1, off: "yes" })).toEqual(prefs);
    expect(lastTeamWeekSlot("week", prefs, ZONE, new Date(SLOT.getTime() + HOUR))?.toISOString()).toBe(
      SLOT.toISOString(),
    );
    // Before the slot: last week's.
    expect(lastTeamWeekSlot("week", prefs, ZONE, new Date(SLOT.getTime() - HOUR))?.toISOString()).toBe(
      new Date(SLOT.getTime() - 7 * DAY).toISOString(),
    );
    // Moved to Monday 9h, the same week: the same key, so no second card.
    const monday = lastTeamWeekSlot("week", { ...prefs, day: 1, weekHour: 9 }, ZONE, SLOT);
    expect(monday && weekKey(monday, ZONE)).toBe(weekKey(SLOT, ZONE));
    expect(weekKey(SLOT, ZONE)).toBe("2026-11-02");
  });

  test("requests read the same without accents, mentions or punctuation", () => {
    expect(requestKey("@dev Manda o resumo do dia!")).toBe(requestKey("manda o RESUMO do dia"));
    expect(requestKey("ok")).toBeNull();
  });

  test("queued for admins of a workspace with a team, once, and never when off or before there is a team", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const member = await addMember(f.db, f.org.id, "member", "bia");
    const at = new Date(SLOT.getTime() + HOUR);
    expect(await enqueueTeamWeeks(f.db, at)).toBe(1);
    await enqueueTeamWeeks(f.db, new Date(at.getTime() + HOUR));
    const queued = await jobs(f);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toEqual({ userId: f.owner.id, slot: SLOT.toISOString(), period: "week" });
    expect(queued.some((j) => (j.payload as { userId: string }).userId === member.id)).toBe(false);
    // A slot missed by more than a few hours waits for next week.
    expect(await enqueueTeamWeeks(f.db, new Date(SLOT.getTime() + DAY))).toBe(0);

    await setLodiPrefs(f.db, f.org.id, f.owner.id, { off: true });
    expect(await enqueueTeamWeeks(f.db, new Date(at.getTime() + 7 * DAY))).toBe(0);
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { off: false });
    // No agent but Lodi: no team, no card.
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    expect(await enqueueTeamWeeks(f.db, new Date(at.getTime() + 7 * DAY))).toBe(0);
  });
});

describe("the card", () => {
  async function busyWeek(fx: Fixture) {
    await inZone(fx);
    const lodi = await lodiOf(fx);
    const day = (n: number) => new Date(SLOT.getTime() - n * DAY);
    for (let i = 0; i < 4; i++) await run(fx, fx.agent.id, day(1), "done");
    await run(fx, fx.agent.id, day(2), "failed", "provider_error");
    await budgetStop(fx, day(2));
    // An agent made last week and put in no channel.
    const [lia] = await fx.db
      .insert(schema.agents)
      .values({
        orgId: fx.org.id,
        name: "Lia",
        handle: "lia",
        role: "Research",
        instructions: "",
        model: "claude-sonnet-5-5",
        ownerUserId: fx.owner.id,
        createdAt: day(5),
      })
      .returning();
    // Three questions nobody answered in #general.
    for (const n of [2, 3, 4])
      await insertMessage(fx.db, {
        orgId: fx.org.id,
        channelId: fx.general.id,
        author: { type: "person", userId: fx.owner.id },
        body: `Alguém sabe emitir nota fiscal ${n}?`,
        createdAt: day(n),
      });
    // The same request typed to Dev in their DM on three days, around 18h.
    const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, fx.agent.id);
    for (const n of [1, 2, 3])
      await insertMessage(fx.db, {
        orgId: fx.org.id,
        channelId: dm.id,
        author: { type: "person", userId: fx.owner.id },
        body: n === 1 ? "Manda o resumo do dia, por favor" : "manda o resumo do dia por favor!",
        createdAt: new Date(day(n).getTime() + HOUR),
      });
    // A plan whose steps 2 and 3 wait while step 1 is in review.
    const [parent] = await fx.db
      .insert(schema.issues)
      .values({
        orgId: fx.org.id,
        number: 10,
        title: "Skills do time",
        assigneeType: "agent",
        assigneeId: fx.agent.id,
        createdByType: "person",
        createdById: fx.owner.id,
      })
      .returning();
    const step = (number: number, status: "todo" | "in_review") => ({
      orgId: fx.org.id,
      number,
      title: `Bloco ${number - 10}`,
      status,
      parentIssueId: parent?.id,
      createdByType: "person",
      createdById: fx.owner.id,
      updatedAt: new Date(SLOT.getTime() - 5 * HOUR),
    });
    await fx.db.insert(schema.issues).values([step(11, "in_review"), step(12, "todo"), step(13, "todo")]);
    return { lodi, lia, dm, parent };
  }

  const cardOf = async (fx: Fixture, messageId: string) => {
    const [m] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    const card = teamWeekCardOf(m?.meta);
    if (!m || !card) throw new Error("no card");
    return { m, card };
  };

  test("posted in the admin's DM with Lodi from stored data, each fix a row, once a week", async () => {
    f = await setup({ rightHand: true });
    const { lodi, lia, parent } = await busyWeek(f);
    const id = await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      userId: f.owner.id,
      slot: SLOT.toISOString(),
    });
    expect(id).not.toBeNull();
    const { m, card } = await cardOf(f, id as string);
    expect(m.authorAgentId).toBe(lodi.id);
    // Written in the person's language: the push and the conversation list read it.
    expect(m.body).toBe("Sua semana da equipe está pronta");
    expect(m.meta.bodyCode).toBe("team_week");
    expect(card.from).toBe("2026-10-30");
    expect(card.to).toBe("2026-11-06");
    expect(card.stats.done).toBe(4);
    expect(card.stats.stuck).toBe(1);
    expect(card.worked).toEqual([{ kind: "runs", agentId: f.agent.id, channelId: f.general.id, count: 4 }]);
    const kinds = card.rows.map((r) => r.kind);
    expect(kinds).toEqual(["budget", "channel", "unanswered", "routine", "stalled"]);
    const budget = card.rows.find((r) => r.kind === "budget");
    expect(budget).toMatchObject({ agentId: f.agent.id, from: 50_000_000_000, to: 75_000_000_000, stops: 1 });
    expect(card.rows.find((r) => r.kind === "channel")).toMatchObject({ agentId: lia?.id, channelId: f.general.id });
    expect(card.rows.find((r) => r.kind === "unanswered")).toMatchObject({ channelId: f.general.id, count: 3 });
    expect(card.rows.find((r) => r.kind === "routine")).toMatchObject({
      agentId: f.agent.id,
      dm: true,
      hour: 18,
      count: 3,
    });
    expect(card.rows.find((r) => r.kind === "stalled")).toMatchObject({
      issueId: parent?.id,
      steps: [12, 13],
      onNumber: 11,
      hours: 5,
      agentId: f.agent.id,
    });
    expect(card.proposalIds).toHaveLength(2);
    // The job runs twice after a lease expiry: one card.
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: SLOT.toISOString() }),
    ).toBeNull();
    // Notified like any agent's message in a DM.
    const [notice] = await f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, "notifications.message"), sql`${schema.outbox.payload}->>'messageId' = ${id}`));
    expect(notice).toBeDefined();
    await notifyMessage({ db: f.db, pubsub: f.pubsub }, f.org.id, id as string);
    const inbox = await f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, f.owner.id));
    expect(inbox.map((n) => n.kind)).toContain("agent_reply");
  });

  test("a personal workspace's card says the week is the person's own (ADR 0159)", async () => {
    f = await setup({ rightHand: true });
    await busyWeek(f);
    await f.db
      .update(schema.organizationSettings)
      .set({ mode: "personal" })
      .where(eq(schema.organizationSettings.orgId, f.org.id));
    const id = await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      userId: f.owner.id,
      slot: SLOT.toISOString(),
    });
    const { m } = await cardOf(f, id as string);
    expect(m.body).toBe("Sua semana está pronta");
  });

  test("a quiet week says nothing, and a member never gets the week's", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: SLOT.toISOString() }),
    ).toBeNull();
    const member = await addMember(f.db, f.org.id, "member", "bia");
    await run(f, f.agent.id, new Date(SLOT.getTime() - DAY), "done");
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
        userId: member.id,
        slot: SLOT.toISOString(),
        period: "week",
      }),
    ).toBeNull();
  });

  test("a busy week whose workspace began being deleted since it was queued posts nothing", async () => {
    f = await setup({ rightHand: true });
    await busyWeek(f);
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() + 7 * DAY) })
      .where(eq(schema.organizations.id, f.org.id));
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: SLOT.toISOString() }),
    ).toBeNull();
  });

  test("rows apply as whoever clicks: the budget with Undo on the card, a routine, Lodi asked, the task's agent told", async () => {
    f = await setup({ rightHand: true });
    const { lodi, dm, parent } = await busyWeek(f);
    const id = (await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      userId: f.owner.id,
      slot: SLOT.toISOString(),
    })) as string;
    const { card } = await cardOf(f, id);
    const row = (kind: TeamWeekCard["rows"][number]["kind"]) => {
      const r = card.rows.find((x) => x.kind === kind);
      if (!r) throw new Error(`no ${kind}`);
      return r;
    };

    // The budget, through the settings card's own path: applied, with its receipt (Undo) on this message.
    const budget = row("budget") as Extract<TeamWeekCard["rows"][number], { kind: "budget" }>;
    await decideProposal(f.db, f.owner.id, f.org.id, budget.proposalId, "accept", { pubsub: f.pubsub });
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.monthlyBudgetNanoUsd).toBe(75_000_000_000);
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.messageId, id));
    expect(receipt?.kind).toBe("agent.settings_changed");
    expect(receipt?.runId).toBeNull();

    // A daily routine at the hour it was asked, posting in the DM it was asked in.
    const deps = { db: f.db, pubsub: f.pubsub };
    const done = await actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: row("routine").id });
    const routineId = done.done[row("routine").id]?.routineId;
    const [routine] = await f.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, routineId ?? ""));
    expect(routine).toMatchObject({ agentId: f.agent.id, target: { type: "dm" }, report: "always" });
    expect(routine?.rule).toMatchObject({ freq: "daily", times: ["18:00"], timezone: ZONE });
    await expect(actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: row("routine").id })).rejects.toThrow();

    // Lodi asked for an agent, as the person, in their DM with it.
    await actOnTeamWeek(deps, f.owner.id, f.org.id, id, {
      rowId: row("unanswered").id,
      text: "Proponha um agente para as perguntas de #general.",
    });
    const lodiDm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    const asked = await f.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.channelId, lodiDm.id), eq(schema.messages.authorUserId, f.owner.id)));
    expect(asked.map((m) => m.body)).toEqual(["Proponha um agente para as perguntas de #general."]);

    // The stalled task's agent told to go on, in the task's conversation.
    await actOnTeamWeek(deps, f.owner.id, f.org.id, id, {
      rowId: row("stalled").id,
      text: "@dev os passos #12 e #13 não precisam esperar o #11.",
    });
    const [task] = await f.db
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.id, parent?.id ?? ""));
    const said = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, task?.conversationChannelId ?? ""));
    expect(said.some((m) => m.body.startsWith("@dev os passos"))).toBe(true);

    // Rows with their own card aren't applied here; nobody else acts on the card; "Agora não" puts it away.
    await expect(actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: row("channel").id })).rejects.toThrow();
    const other = await addMember(f.db, f.org.id, "admin", "caio");
    await expect(actOnTeamWeek(deps, other.id, f.org.id, id, { dismiss: true })).rejects.toThrow();
    expect((await actOnTeamWeek(deps, f.owner.id, f.org.id, id, { dismiss: true })).dismissedAt).not.toBeNull();
    expect(dm.id).not.toBe(lodiDm.id);
  });

  test("next week's fix replaces last week's open one: its Undo lands on the card it was applied from", async () => {
    f = await setup({ rightHand: true });
    await busyWeek(f);
    const post = (slot: Date) =>
      postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: slot.toISOString() });
    const first = (await post(SLOT)) as string;
    const next = new Date(SLOT.getTime() + 7 * DAY);
    await budgetStop(f, new Date(next.getTime() - DAY));
    const second = (await post(next)) as string;
    const budgetOf = async (id: string) => {
      const r = (await cardOf(f, id)).card.rows.find((x) => x.kind === "budget");
      if (r?.kind !== "budget") throw new Error("no budget row");
      return r;
    };
    const [old, fresh] = [await budgetOf(first), await budgetOf(second)];
    expect(fresh.proposalId).not.toBe(old.proposalId);
    const [was] = await f.db
      .select()
      .from(schema.contextProposals)
      .where(eq(schema.contextProposals.id, old.proposalId));
    expect(was?.status).toBe("stale");
    await decideProposal(f.db, f.owner.id, f.org.id, fresh.proposalId, "accept", { pubsub: f.pubsub });
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.messageId, second));
    expect(receipt?.kind).toBe("agent.settings_changed");
  });

  test("telling Lodi to stop it: set_team_week, for the person behind the run", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "para de mandar o resumo da semana",
    });
    const [r] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
    const gateway = createToolGateway({ sources: [createSetupToolSource({ pubsub: f.pubsub })] });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: lodi.id,
      runId: r?.id ?? "",
      channelId: dm.id,
      threadRootId: r?.threadRootId ?? trigger.id,
      triggerMessageId: trigger.id,
    };
    const res = await gateway.invoke(ctx, { toolUseId: "tu_1", name: SET_TEAM_WEEK_TOOL, input: { off: true } });
    expect(res.type).toBe("result");
    expect((await getLodiPrefs(f.db, f.org.id, f.owner.id)).off).toBe(true);
    await gateway.invoke(ctx, {
      toolUseId: "tu_2",
      name: SET_TEAM_WEEK_TOOL,
      input: { card: "week", off: false, day: "monday", hour: 9 },
    });
    expect(await getLodiPrefs(f.db, f.org.id, f.owner.id)).toMatchObject({
      off: false,
      weekOff: false,
      dayOff: true,
      day: 1,
      weekHour: 9,
    });
  });
});

describe("Resumo do dia", () => {
  /** Friday 2026-11-06, 09:00 in São Paulo (UTC-3). */
  const NINE = new Date("2026-11-06T12:00:00Z");
  const cardOf = async (fx: Fixture, messageId: string) => {
    const [m] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    const card = teamWeekCardOf(m?.meta);
    if (!m || !card) throw new Error("no card");
    return { m, card };
  };

  test("every day at its hour, over the last day, for everyone; one card per person and day", async () => {
    const prefs = lodiPrefsOf({ daily: true, hour: 9 });
    expect(prefs).toMatchObject({ dayOff: false, dayHour: 9, weekOff: true });
    expect(lastTeamWeekSlot("day", prefs, ZONE, new Date(NINE.getTime() + HOUR))?.toISOString()).toBe(
      NINE.toISOString(),
    );
    expect(lastTeamWeekSlot("day", prefs, ZONE, new Date(NINE.getTime() - HOUR))?.toISOString()).toBe(
      new Date(NINE.getTime() - DAY).toISOString(),
    );

    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { off: true });
    // On for anyone who never chose.
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + HOUR))).toBe(1);
    await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + 2 * HOUR));
    expect(await jobs(f)).toHaveLength(1);
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + DAY + HOUR))).toBe(1);
    expect((await jobs(f)).map((j) => j.payload)).toEqual([
      { userId: bia.id, slot: NINE.toISOString(), period: "day" },
      { userId: bia.id, slot: new Date(NINE.getTime() + DAY).toISOString(), period: "day" },
    ]);
    await setLodiPrefs(f.db, f.org.id, bia.id, { dayOff: true });
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + 2 * DAY + HOUR))).toBe(0);
  });

  /** `userId` asks `agentId` in a conversation and the run it starts ends as `status`. */
  const ask = async (
    fx: Fixture,
    userId: string,
    at: Date,
    status: "done" | "failed" | "waiting_input",
    over: { channelId?: string; agentId?: string; error?: string; transcript?: Record<string, unknown> } = {},
  ) => {
    const channelId = over.channelId ?? fx.general.id;
    const m = await insertMessage(fx.db, {
      orgId: fx.org.id,
      channelId,
      author: { type: "person", userId },
      body: "@dev faz isso",
      createdAt: at,
    });
    const [r] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: over.agentId ?? fx.agent.id,
        channelId,
        threadRootId: m.id,
        triggerMessageId: m.id,
        trigger: "mention",
        hop: 1,
        status,
        error: over.error ?? null,
        transcript: over.transcript ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    return r?.id ?? "";
  };
  const waits = (fx: Fixture, userId: string, key: string) =>
    notify(
      { db: fx.db, pubsub: fx.pubsub },
      {
        orgId: fx.org.id,
        userIds: [userId],
        kind: "agent_question",
        groupKey: key,
        waiting: true,
        actor: { type: "agent", id: fx.agent.id },
        source: {},
        latest: { text: "Which plan do I use?" },
      },
    );
  const post = (fx: Fixture, userId: string, slot: Date) =>
    postTeamWeek({ db: fx.db, pubsub: fx.pubsub }, fx.org.id, { userId, slot: slot.toISOString(), period: "day" });
  const rings = async (fx: Fixture, messageId: string) =>
    (
      await fx.db
        .select()
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.kind, "notifications.message"),
            sql`${schema.outbox.payload}->>'messageId' = ${messageId}`,
          ),
        )
    ).length > 0;
  /** The row kinds app builds from before `moreRows` word: any other in `rows` would break their card. */
  const FIRST_KINDS = ["approvals", "howto", "budget", "channel", "unanswered", "routine", "stalled"];

  test("what waits on the person, what they asked for that finished, and what is stuck with its cause", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await ask(f, bia.id, new Date(NINE.getTime() - 5 * HOUR), "done");
    await ask(f, bia.id, new Date(NINE.getTime() - 3 * HOUR), "failed", {
      error: "provider_error: down@Claude: the upstream said something private",
    });
    // A day earlier than the card's, and other people's work in the same channel: outside it.
    await ask(f, bia.id, new Date(NINE.getTime() - 2 * DAY), "done");
    await run(f, f.agent.id, new Date(NINE.getTime() - 2 * HOUR), "done");
    await run(f, f.agent.id, new Date(NINE.getTime() - 2 * HOUR), "failed", "stuck");
    await waits(f, bia.id, "question:1");

    const id = await post(f, bia.id, NINE);
    expect(id).not.toBeNull();
    const { m, card } = await cardOf(f, id as string);
    expect(m.body).toBe("Seu resumo do dia está pronto");
    expect(card).toMatchObject({ period: "day", slot: NINE.toISOString(), from: "2026-11-05", to: "2026-11-06" });
    expect(card.stats).toEqual({ done: 1, stuck: 1, waiting: 1, spentNanoUsd: 0, budgetNanoUsd: 0 });
    expect(card.worked).toEqual([{ kind: "runs", agentId: f.agent.id, channelId: f.general.id, count: 1 }]);
    expect(card.moreRows).toEqual([
      {
        id: "waiting",
        kind: "waiting",
        count: 1,
        ids: [expect.any(String)],
        agentId: f.agent.id,
        since: expect.any(String),
      },
      {
        id: `stuck:${f.agent.id}:${f.general.id}`,
        kind: "stuck",
        agentId: f.agent.id,
        channelId: f.general.id,
        dm: false,
        code: "ai",
        count: 1,
        held: false,
      },
    ]);
    // A cause, never what the run or the question said.
    expect(JSON.stringify(card)).not.toContain("private");
    expect(JSON.stringify(card)).not.toContain("Which plan");
    // A build from before reads `rows` alone, and finds only kinds it words.
    expect(card.rows.every((r) => FIRST_KINDS.includes(r.kind))).toBe(true);
    expect(await rings(f, id as string)).toBe(true);
    // A retry of the same job posts no second card, and none of it called a model.
    expect(await post(f, bia.id, NINE)).toBeNull();
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a team busy with other people's asks posts nothing to the 30 who asked for none of it", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const people = [];
    for (let i = 0; i < 30; i++) people.push(await addMember(f.db, f.org.id, "member", `p${i}`));
    for (let i = 0; i < 12; i++) await ask(f, f.owner.id, new Date(NINE.getTime() - (i + 1) * HOUR), "done");
    await ask(f, f.owner.id, new Date(NINE.getTime() - HOUR), "failed", { error: "stuck" });
    for (const p of people) expect(await post(f, p.id, NINE)).toBeNull();
    const cards = await f.db
      .select()
      .from(schema.messages)
      .where(sql`${schema.messages.meta}->'actionCard'->>'kind' = 'team_week'`);
    expect(cards).toEqual([]);
    expect(f.provider.calls).toHaveLength(0);
    // Turned off, nothing either, whatever happened.
    const [bia] = people;
    await ask(f, bia?.id ?? "", new Date(NINE.getTime() - HOUR), "done");
    await setLodiPrefs(f.db, f.org.id, bia?.id ?? "", { dayOff: true });
    expect(await post(f, bia?.id ?? "", NINE)).toBeNull();
  });

  test("said once: the same waiting items and held runs the next day post nothing, a new one does", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await waits(f, bia.id, "question:1");
    const held = await ask(f, bia.id, new Date(NINE.getTime() - 6 * HOUR), "waiting_input", {
      transcript: { waitingForBrain: { code: "plan_limit", since: new Date(NINE.getTime() - 6 * HOUR).toISOString() } },
    });
    // Parked a moment ago: it may go on by itself, so it is not called stuck.
    await ask(f, bia.id, new Date(NINE.getTime() - HOUR), "waiting_input", {
      transcript: { waitingForBrain: { code: "budget", since: new Date(NINE.getTime() - HOUR).toISOString() } },
    });
    const first = (await post(f, bia.id, NINE)) as string;
    const one = (await cardOf(f, first)).card;
    expect(one.moreRows?.map((r) => [r.kind, r.kind === "stuck" && [r.code, r.held, r.count]])).toEqual([
      ["waiting", false],
      ["stuck", ["plan", true, 1]],
    ]);
    expect(one.seen).toContain(`run:${held}`);
    expect(await rings(f, first)).toBe(true);

    // The day after: all of it is still there, none of it new.
    const day = (n: number) => new Date(NINE.getTime() + n * DAY);
    await f.db
      .delete(schema.agentRuns)
      .where(sql`${schema.agentRuns.transcript}->'waitingForBrain'->>'code' = 'budget'`);
    expect(await post(f, bia.id, day(1))).toBeNull();
    // Something of theirs finished: a card, with what still waits on it, and no ring for what was already said.
    await ask(f, bia.id, new Date(day(2).getTime() - HOUR), "done");
    const second = (await post(f, bia.id, day(2))) as string;
    const two = (await cardOf(f, second)).card;
    // It goes on from the last card, so the day that posted none is inside it.
    expect(two.from).toBe("2026-11-06");
    expect(two.stats).toMatchObject({ done: 1, waiting: 1 });
    expect(two.moreRows?.map((r) => r.kind)).toEqual(["waiting", "stuck"]);
    expect(await rings(f, second)).toBe(false);
    // Asked the same day's job again after its window moved: still one card.
    expect(await post(f, bia.id, day(2))).toBeNull();
    // A new thing waiting rings again.
    await waits(f, bia.id, "question:2");
    const third = (await post(f, bia.id, day(3))) as string;
    expect((await cardOf(f, third)).card.moreRows?.[0]).toMatchObject({ kind: "waiting", count: 2 });
    expect(await rings(f, third)).toBe(true);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("only where the reader reads: a private channel they are not in, and someone else's DM, stay off", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    // Bia's own agent works in a private channel she is not in, for someone else.
    const [mine] = await f.db
      .insert(schema.agents)
      .values({
        orgId: f.org.id,
        name: "Lia",
        handle: "lia",
        role: "Research",
        instructions: "",
        model: "claude-sonnet-5-5",
        ownerUserId: bia.id,
      })
      .returning();
    const [hidden] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "diretoria", kind: "channel", visibility: "private" })
      .returning();
    await ask(f, f.owner.id, new Date(NINE.getTime() - HOUR), "failed", {
      channelId: hidden?.id,
      agentId: mine?.id,
      error: "stuck",
    });
    expect(await post(f, bia.id, NINE)).toBeNull();

    // The owner administers and owns Dev. Dev failing in Bia's DM with it is hers to read, not theirs.
    const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, f.agent.id);
    await ask(f, bia.id, new Date(NINE.getTime() - HOUR), "failed", { channelId: dm.id, error: "stuck" });
    const own = (await cardOf(f, (await post(f, f.owner.id, NINE)) as string)).card;
    // The private channel is an administrator's to read, the DM is not. No money on a day's card, and no budget row.
    expect(own.moreRows).toEqual([
      expect.objectContaining({ kind: "stuck", channelId: hidden?.id, agentId: mine?.id }),
    ]);
    expect(own.stats).toMatchObject({ stuck: 1, spentNanoUsd: 0, budgetNanoUsd: 0 });
    expect(await f.db.select().from(schema.contextProposals)).toEqual([]);
    const hers = (await cardOf(f, (await post(f, bia.id, NINE)) as string)).card;
    expect(hers.moreRows).toEqual([
      expect.objectContaining({ kind: "stuck", channelId: dm.id, dm: true, code: "other", count: 1 }),
    ]);
  });

  test("asked of Lodi: set_team_week moves it for the person behind the run", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const lodi = await lodiOf(f);
    const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, lodi.id);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, dm.id, {
      body: "me manda isso todo dia às 9h",
    });
    const [r] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
    const gateway = createToolGateway({ sources: [createSetupToolSource({ pubsub: f.pubsub })] });
    const res = await gateway.invoke(
      {
        db: f.db,
        orgId: f.org.id,
        agentId: lodi.id,
        runId: r?.id ?? "",
        channelId: dm.id,
        threadRootId: r?.threadRootId ?? trigger.id,
        triggerMessageId: trigger.id,
      },
      { toolUseId: "tu_1", name: SET_TEAM_WEEK_TOOL, input: { card: "day", hour: 8 } },
    );
    if (res.type !== "result") throw new Error(res.type);
    expect((res.output as { content: string }).content).toContain("Daily summary: every day at 8:00");
    expect(await getLodiPrefs(f.db, f.org.id, bia.id)).toMatchObject({
      dayOff: false,
      dayHour: 8,
      daily: true,
      hour: 8,
    });
  });
});

test("what Lodi posts unasked is on by default and named on its page in every language", () => {
  expect(LODI_PREFS_DEFAULTS).toMatchObject({ weekOff: false, dayOff: false });
  for (const [code, strings] of Object.entries(STRINGS)) {
    const words = strings as { teamWeek?: { settings?: { label?: string; dayLabel?: string } } };
    const labels = [
      words.teamWeek?.settings?.label ?? en.teamWeek.settings.label,
      words.teamWeek?.settings?.dayLabel ?? en.teamWeek.settings.dayLabel,
    ];
    expect({ code, named: labels.every(Boolean) }).toEqual({ code, named: true });
  }
});
