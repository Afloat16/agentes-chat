import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gte, isNull, rowsOf, schema, sql } from "@agenteschat/db";
import { listApprovals } from "./approvals";
import { editContextItem, howToSql } from "./context/items";
import { LEARN_DEFAULTS } from "./context/learn";
import { NO_CHANNEL_REASON, OVER_BUDGET_REASON, proposeSettings } from "./context/proposals";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { cutText } from "./format";
import { commentIssue } from "./issues";
import { getMessage, postPersonMessage } from "./messages";
import { maySql } from "./permissions";
import { pushStrings } from "./push-messages";
import { knownZonesSql, type LodiPrefs, lodiPrefsOf, lodiPrefsSql, readLodiPrefs, zoneSql } from "./right-hand-prefs";
import { lodiFor, postFromLodi, setCardOnMessage } from "./right-hand-proactive";
import { createRoutine, type RoutineDeps } from "./routines";
import { localDate, nextOccurrence, type ScheduleRule } from "./rrule";
import { openOrg } from "./standing";
import { taskSeenSql } from "./task-access";

/**
 * "Semana da equipe" (ADR 0137 §9): once a week Lodi posts one card in each admin's DM with it, from what the server
 * already stores (runs, approvals, budgets, channels, unanswered questions, requests repeated by hand, stalled steps),
 * with no model call. Each row is a fix applied as whoever clicks, through the paths the other cards use: a settings
 * proposal (budget, a channel), the approvals list, a routine, a message to Lodi or to a task's conversation.
 * "Resumo do dia" is the same card over a day, for everyone. When each comes is the person's own choice
 * (`right-hand-prefs.ts`).
 */

const { agents, contextItems, contextProposals, organizationSettings, outbox } = schema;

export const TEAM_WEEK_JOB = "team_week.post";
/**
 * The day's card is queued under a kind of its own. A server of the version before the two cards has no handler for
 * it, so while both versions run it fails that job instead of reading it as a week's card.
 */
export const TEAM_DAY_JOB = "team_day.post";
export const TEAM_WEEK_CARD = "team_week";
/** The tool through which a person tells Lodi to stop the card or move it. */
export const SET_TEAM_WEEK_TOOL = "set_team_week";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** A slot missed for longer (the server was down) waits for the next week: a Friday card on Sunday is noise. */
const POST_WINDOW_MS = 6 * HOUR_MS;
/** Steps of a task that moved for this long are stalled. */
const STALL_MS = 4 * HOUR_MS;
/** A request typed by hand on this many days of the week is a routine waiting to be made. */
const REPEAT_DAYS = 3;
/** Questions left unanswered in one channel before it is worth an agent. */
const UNANSWERED_MIN = 3;
const MAX_ROWS = 6;
const NANO = 1_000_000_000;

/** "Resumo do dia" or "Semana da equipe". */
export type TeamWeekPeriod = "day" | "week";

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** What a card looks back on. */
export const teamWeekSpan = (period: TeamWeekPeriod) => (period === "day" ? DAY_MS : WEEK_MS);

/**
 * The latest slot of that card at or before `now`, within one span. `timezone` is the one its hour is in: the
 * person's own for the day's, the workspace's for the week's.
 */
export function lastTeamWeekSlot(
  period: TeamWeekPeriod,
  prefs: Pick<LodiPrefs, "day" | "weekHour" | "dayHour">,
  timezone: string,
  now: Date,
): Date | null {
  const times = [`${String(period === "day" ? prefs.dayHour : prefs.weekHour).padStart(2, "0")}:00`];
  const rule: ScheduleRule =
    period === "day"
      ? { freq: "daily", times, timezone }
      : { freq: "weekly", byWeekday: [WEEKDAYS[prefs.day] as string], times, timezone };
  const at = nextOccurrence(rule, new Date(now.getTime() - teamWeekSpan(period)));
  return at && at.getTime() <= now.getTime() ? at : null;
}

const localHour = (at: Date, timezone: string) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(at));

/** 0 = Sunday … 6 = Saturday, where `at` falls in that time zone. */
const localWeekday = (at: Date, timezone: string) => new Date(`${localDate(at, timezone)}T00:00:00Z`).getUTCDay();

/** The Monday of the local week `at` falls in: one card per person per week, whatever day they move it to. */
export function weekKey(at: Date, timezone: string) {
  const day = new Date(`${localDate(at, timezone)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** One job per person and day, and one per person and week: the key a second enqueue of the same card runs into. */
export const teamWeekJobKey = (orgId: string, userId: string, period: TeamWeekPeriod, slot: Date, timezone: string) =>
  `${TEAM_WEEK_JOB}:${orgId}:${userId}:${period === "day" ? `day:${localDate(slot, timezone)}` : weekKey(slot, timezone)}`;

/**
 * The cards of one person whose slot just passed. The week's is an administrator's. The day's is anyone's, in their
 * own time zone, and is left out on the day the week's card comes: that one says the day too.
 */
export function dueTeamWeeks(
  prefs: LodiPrefs,
  who: { admin: boolean; timezone: string; dayTimezone: string },
  now: Date,
): { period: TeamWeekPeriod; slot: Date; timezone: string }[] {
  const fresh = (slot: Date | null): slot is Date => !!slot && now.getTime() - slot.getTime() <= POST_WINDOW_MS;
  const weekly = who.admin && !prefs.weekOff;
  const due: ReturnType<typeof dueTeamWeeks> = [];
  const week = weekly ? lastTeamWeekSlot("week", prefs, who.timezone, now) : null;
  if (fresh(week)) due.push({ period: "week", slot: week, timezone: who.timezone });
  const day = prefs.dayOff ? null : lastTeamWeekSlot("day", prefs, who.dayTimezone, now);
  if (fresh(day) && !(weekly && localWeekday(day, who.timezone) === prefs.day))
    due.push({ period: "day", slot: day, timezone: who.dayTimezone });
  return due;
}

// --- The card ------------------------------------------------------------------------------------------------

export type TeamWeekRow =
  /** Approvals of one agent waiting for this person: "Ver e aprovar" opens them on the card. */
  | { id: string; kind: "approvals"; agentId: string; approvalIds: string[]; since: string }
  /** It stopped at its monthly budget: a settings proposal to raise it, applied with Undo. */
  | { id: string; kind: "budget"; agentId: string; proposalId: string; stops: number; from: number; to: number }
  /** In no channel, so nobody talked to it: a settings proposal to add it to one. */
  | { id: string; kind: "channel"; agentId: string; proposalId: string; channelId: string }
  /** People's questions nobody answered in a channel: Lodi is asked for an agent for them. */
  | { id: string; kind: "unanswered"; channelId: string; count: number }
  /** The same request typed on several days: a daily routine at the hour it was asked. */
  | {
      id: string;
      kind: "routine";
      agentId: string;
      /** Where it was asked: a channel, or the person's DM with the agent (`dm`). */
      channelId: string;
      dm: boolean;
      text: string;
      count: number;
      hour: number;
    }
  /**
   * A how-to of the person's own agent reused past the bar that no person vouched for yet (ADR 0167): "Virar skill?"
   * confirms it (`editContextItem` confirmed), and the day's pass makes it a skill.
   */
  | { id: string; kind: "howto"; agentId: string; itemId: string; title: string; uses: number }
  /** Steps of a task waiting on another step for hours: its agent is told to go on with them in parallel. */
  | {
      id: string;
      kind: "stalled";
      issueId: string;
      number: number;
      title: string;
      steps: number[];
      onNumber: number;
      hours: number;
      agentId: string | null;
    };

export type TeamWeekHighlight =
  | { kind: "runs"; agentId: string; channelId: string; count: number }
  | { kind: "tasks"; agentId: string; count: number };

export interface TeamWeekCard {
  kind: typeof TEAM_WEEK_CARD;
  forUserId: string;
  /** "Resumo do dia" (`day`) or the week's (absent on cards from before it). */
  period?: "day" | "week";
  /** The week's first and last day, `YYYY-MM-DD` in the workspace's time zone. */
  from: string;
  to: string;
  timezone: string;
  stats: { done: number; stuck: number; waiting: number; spentNanoUsd: number; budgetNanoUsd: number };
  worked: TeamWeekHighlight[];
  rows: TeamWeekRow[];
  /** The settings proposals on its rows: their receipts (Undo) live on this message. */
  proposalIds: string[];
  /** Rows applied here (the routine made, the message sent), by row id. */
  done: Record<string, { byUserId: string; at: string; routineId?: string }>;
  /** "Agora não". */
  dismissedAt: string | null;
}

export function teamWeekCardOf(meta: Record<string, unknown> | null | undefined): TeamWeekCard | null {
  const c = meta?.actionCard as Partial<TeamWeekCard> | undefined;
  return c?.kind === TEAM_WEEK_CARD && typeof c.forUserId === "string" && Array.isArray(c.rows)
    ? (c as TeamWeekCard)
    : null;
}

interface Window {
  orgId: string;
  userId: string;
  rightHandId: string;
  start: Date;
  end: Date;
  timezone: string;
  /**
   * An administrator's card counts the whole team's runs and the workspace's spend; anyone else's only runs where they
   * read and no money (absent: an administrator's).
   */
  admin?: boolean;
}

/** Lowercase words without accents, mentions or punctuation: how two requests are told the same. */
export function requestKey(body: string) {
  const words = body
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/@[\w.-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  return words.length >= 2 ? words.slice(0, 6).join(" ") : null;
}

/** The week's card for this person, or null when there is nothing to say (or no team yet). */
export async function buildTeamWeek(
  db: Database,
  w: Window,
): Promise<Omit<TeamWeekCard, "done" | "dismissedAt"> | null> {
  const start = w.start.toISOString();
  const end = w.end.toISOString();
  const team = rowsOf<{ id: string; created_at: string | Date; budget: number | string | null }>(
    await db.execute(sql`select id, created_at, monthly_budget_nano_usd as budget from agents
      where org_id = ${w.orgId} and builtin is null and archived_at is null and deleted_at is null`),
  );
  if (team.length === 0) return null;
  const teamIds = new Set(team.map((a) => a.id));
  const [settings] = await db
    .select({ budget: organizationSettings.defaultAgentBudgetNanoUsd })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, w.orgId));
  const defaultBudget = Number(settings?.budget ?? 50 * NANO);
  const [lodi] = await db
    .select({ budget: agents.monthlyBudgetNanoUsd })
    .from(agents)
    .where(eq(agents.id, w.rightHandId));
  const budgetOf = (b: number | string | null | undefined) => (b == null ? defaultBudget : Number(b));
  const visible = sql`(c.visibility = 'public' or exists (select 1 from channel_members vm
    where vm.channel_id = c.id and vm.user_id = ${w.userId})
    or (c.kind = 'channel' and ${maySql(w.orgId, sql`${w.userId}::text`, "administrator")}))`;
  const teamRuns = sql`r.org_id = ${w.orgId} and r.created_at >= ${start}::timestamptz and r.created_at < ${end}::timestamptz
    and r.agent_id in (select id from agents where org_id = ${w.orgId} and builtin is null)`;
  const admin = w.admin !== false;

  const [counts] = rowsOf<{ done: number | string; failed: number | string }>(
    await db.execute(sql`select count(*) filter (where r.status = 'done') as done,
      count(*) filter (where r.status = 'failed') as failed from agent_runs r
      ${admin ? sql`` : sql`join channels c on c.id = r.channel_id`}
      where ${teamRuns} ${admin ? sql`` : sql`and ${visible}`}`),
  );
  const monthStart = new Date(Date.UTC(w.end.getUTCFullYear(), w.end.getUTCMonth(), 1)).toISOString();
  const [spent] = rowsOf<{ n: number | string | null }>(
    await db.execute(sql`select coalesce(sum(cost_nano_usd), 0) as n from usage_records
      where org_id = ${w.orgId} and created_at >= ${monthStart}::timestamptz`),
  );

  // Funcionou: the agents that did the most where this person can read, and tasks agents closed.
  const busiest = rowsOf<{ agent_id: string; channel_id: string; n: number | string }>(
    await db.execute(sql`select r.agent_id, r.channel_id, count(*) as n from agent_runs r
      join channels c on c.id = r.channel_id and c.kind = 'channel' and c.archived_at is null
      where ${teamRuns} and r.status = 'done' and ${visible}
      group by r.agent_id, r.channel_id order by n desc limit 2`),
  );
  const closed = rowsOf<{ agent_id: string; n: number | string }>(
    await db.execute(sql`select assignee_id as agent_id, count(*) as n from issues
      where org_id = ${w.orgId} and status = 'done' and assignee_type = 'agent'
        and updated_at >= ${start}::timestamptz and updated_at < ${end}::timestamptz
        and ${taskSeenSql("issues", sql`${w.userId}::text`)}
      group by assignee_id order by n desc limit 1`),
  );
  const worked: TeamWeekHighlight[] = [
    ...busiest
      .filter((b) => Number(b.n) >= 3)
      .map((b) => ({ kind: "runs" as const, agentId: b.agent_id, channelId: b.channel_id, count: Number(b.n) })),
    ...closed
      .filter((c) => teamIds.has(c.agent_id) && Number(c.n) >= 2)
      .map((c) => ({ kind: "tasks" as const, agentId: c.agent_id, count: Number(c.n) })),
  ];

  const rows: TeamWeekRow[] = [];
  const proposalIds: string[] = [];

  // Waiting for this person: one row per agent, the longest waiting first.
  const waiting = (await listApprovals(db, w.userId, w.orgId, { status: "pending", limit: 200 })).filter(
    (a) => a.canDecide,
  );
  const byAgent = new Map<string, typeof waiting>();
  for (const a of waiting) byAgent.set(a.agentId, [...(byAgent.get(a.agentId) ?? []), a]);
  for (const [agentId, list] of [...byAgent].sort((a, b) => oldest(a[1]).localeCompare(oldest(b[1]))).slice(0, 2))
    rows.push({
      id: `approvals:${agentId}`,
      kind: "approvals",
      agentId,
      approvalIds: list.slice(0, 10).map((a) => a.id),
      since: oldest(list),
    });

  // Stopped at the budget: raise it by half (whole dollars), through the settings card's own proposal. A run at the
  // budget parks (its `budget_wait` note; still waiting: `waitingForBrain`, cleared on resume) rather than failing.
  const stops = rowsOf<{ agent_id: string; n: number | string }>(
    await db.execute(sql`select agent_id, count(distinct run_id) as n from (
        select r.agent_id, r.id::text as run_id from agent_runs r
        where ${teamRuns} and (r.error = 'budget_exceeded' or (r.status = 'waiting_input'
          and r.transcript->'waitingForBrain'->>'code' = 'budget'))
        union all
        select m.author_agent_id, coalesce(m.meta->'usageWait'->>'runId', m.id::text) from messages m
        where m.org_id = ${w.orgId} and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
          and m.meta->>'bodyCode' = 'budget_wait'
          and m.author_agent_id in (select id from agents where org_id = ${w.orgId} and builtin is null)
      ) s group by agent_id order by n desc limit 2`),
  );
  // A budget is the workspace's money: only an administrator's card offers to raise it.
  for (const s of admin ? stops : []) {
    const agent = team.find((a) => a.id === s.agent_id);
    if (!agent) continue;
    const from = budgetOf(agent.budget);
    const to = Math.max(Math.ceil((from * 1.5) / NANO), Math.ceil(from / NANO) + 5) * NANO;
    const id = await settingsProposal(db, w, s.agent_id, "budget", { field: "budget", to });
    if (id) {
      rows.push({
        id: `budget:${s.agent_id}`,
        kind: "budget",
        agentId: s.agent_id,
        proposalId: id,
        stops: Number(s.n),
        from,
        to,
      });
      proposalIds.push(id);
    }
  }

  // In no channel for a day or more: #general (else the oldest public channel).
  const lonely = rowsOf<{ id: string }>(
    await db.execute(sql`select a.id from agents a
      where a.org_id = ${w.orgId} and a.builtin is null and a.archived_at is null and a.deleted_at is null
        and a.created_at < ${new Date(w.end.getTime() - 24 * HOUR_MS).toISOString()}::timestamptz
        and not exists (select 1 from channel_members cm join channels c on c.id = cm.channel_id
          and c.kind = 'channel' and c.archived_at is null and c.deleted_at is null where cm.agent_id = a.id)
      order by a.created_at limit 2`),
  );
  const [home] = lonely.length
    ? rowsOf<{ id: string }>(
        await db.execute(sql`select id from channels where org_id = ${w.orgId} and kind = 'channel'
          and visibility = 'public' and archived_at is null and deleted_at is null
          order by (name = 'general') desc, created_at limit 1`),
      )
    : [];
  const homeId = home?.id;
  for (const a of homeId ? lonely : []) {
    if (!homeId) break;
    const id = await settingsProposal(db, w, a.id, "channel_add", {
      field: "channel_add",
      channelId: homeId,
      to: true,
    });
    if (id) {
      rows.push({ id: `channel:${a.id}`, kind: "channel", agentId: a.id, proposalId: id, channelId: homeId });
      proposalIds.push(id);
    }
  }

  // People's questions nobody answered within a day, where this person can read: the channel with the most.
  const [unanswered] = rowsOf<{ channel_id: string; n: number | string }>(
    await db.execute(sql`select q.channel_id, count(*) as n from messages q
      join channels c on c.id = q.channel_id and c.kind = 'channel' and c.archived_at is null and c.deleted_at is null
      where q.org_id = ${w.orgId} and q.author_type = 'person' and q.deleted_at is null
        and q.created_at >= ${start}::timestamptz
        and q.created_at < ${new Date(w.end.getTime() - 2 * HOUR_MS).toISOString()}::timestamptz
        and position('?' in q.body) > 0 and ${visible}
        and not exists (select 1 from messages a where a.org_id = q.org_id and a.channel_id = q.channel_id
          and a.deleted_at is null and a.created_at > q.created_at and a.created_at < q.created_at + interval '1 day'
          and a.author_user_id is distinct from q.author_user_id
          and ((q.thread_id is null and (a.thread_id = q.id
                or (a.thread_id is null and a.created_at < q.created_at + interval '30 minutes')))
            or (q.thread_id is not null and a.thread_id = q.thread_id)))
      group by q.channel_id having count(*) >= ${UNANSWERED_MIN} order by n desc limit 1`),
  );
  if (unanswered)
    rows.push({
      id: `unanswered:${unanswered.channel_id}`,
      kind: "unanswered",
      channelId: unanswered.channel_id,
      count: Number(unanswered.n),
    });

  const repeat = await repeatedRequest(db, w, teamIds);
  if (repeat) rows.push(repeat);

  const stalled = await stalledSteps(db, w);
  if (stalled) rows.push(stalled);
  rows.push(...(await provenHowTos(db, w)));

  const stats = {
    done: Number(counts?.done ?? 0),
    stuck: Number(counts?.failed ?? 0),
    waiting: waiting.length,
    // The workspace's money is the administrators' to read.
    spentNanoUsd: admin ? Number(spent?.n ?? 0) : 0,
    budgetNanoUsd: admin ? team.reduce((sum, a) => sum + budgetOf(a.budget), budgetOf(lodi?.budget)) : 0,
  };
  if (stats.done === 0 && stats.stuck === 0 && rows.length === 0) return null;
  return {
    kind: TEAM_WEEK_CARD,
    forUserId: w.userId,
    from: localDate(w.start, w.timezone),
    to: localDate(new Date(w.end.getTime() - 1), w.timezone),
    timezone: w.timezone,
    stats,
    worked,
    rows: rows.slice(0, MAX_ROWS),
    proposalIds,
  };
}

const oldest = (list: { createdAt: string }[]) => list.map((a) => a.createdAt).sort()[0] ?? "";

/**
 * A fresh settings proposal by Lodi for this person; null when the line can't be made or this person can't decide it
 * (the card only offers what its reader applies). The same fix still open on an earlier week's card goes stale there:
 * a decision records its receipt (Undo) on the oldest card that lists the proposal, and last week's amount may be
 * outdated. Proposals Lodi made in a conversation stay as they are.
 */
async function settingsProposal(
  db: Database,
  w: Window,
  agentId: string,
  field: "budget" | "channel_add",
  line: { field: typeof field; to: unknown; channelId?: string },
) {
  await db.execute(sql`update context_proposals p set status = 'stale', decided_at = now()
    where p.org_id = ${w.orgId} and p.agent_id = ${agentId} and p.proposed_by_agent_id = ${w.rightHandId}
      and p.requested_by_user_id = ${w.userId} and p.status = 'pending' and p.target = 'agent_settings'
      and p.settings @> ${JSON.stringify([{ field }])}::jsonb
      and exists (select 1 from messages m where m.org_id = p.org_id and m.author_agent_id = p.proposed_by_agent_id
        and m.meta->'actionCard'->>'kind' = ${TEAM_WEEK_CARD}
        and m.meta->'actionCard'->'proposalIds' @> jsonb_build_array(p.id::text))`);
  const { proposals } = await proposeSettings(
    { db },
    {
      orgId: w.orgId,
      agentId: w.rightHandId,
      targets: [{ agentId, lines: [line] }],
      rationale: field === "budget" ? OVER_BUDGET_REASON : NO_CHANNEL_REASON,
      requesterId: w.userId,
    },
  );
  const [p] = proposals;
  if (p && !p.canDecide) {
    // Not on the card: a row nobody sees would only pile up, one a day on a "Resumo do dia".
    await db.delete(contextProposals).where(eq(contextProposals.id, p.id));
    return null;
  }
  return p?.id ?? null;
}

/** The same request this person typed to one agent on `REPEAT_DAYS` days or more, with no routine doing it. */
async function repeatedRequest(db: Database, w: Window, teamIds: Set<string>): Promise<TeamWeekRow | null> {
  const sent = rowsOf<{
    body: string;
    created_at: string | Date;
    channel_id: string;
    kind: string;
    dm_key: string | null;
    mentioned: string[] | string | null;
  }>(
    await db.execute(sql`select m.body, m.created_at, m.channel_id, c.kind, c.dm_key, m.mentioned_agent_ids as mentioned
      from messages m join channels c on c.id = m.channel_id
      where m.org_id = ${w.orgId} and m.author_user_id = ${w.userId} and m.deleted_at is null and m.thread_id is null
        and m.created_at >= ${w.start.toISOString()}::timestamptz and m.created_at < ${w.end.toISOString()}::timestamptz
        and c.archived_at is null and (c.kind = 'dm' or (c.kind = 'channel' and cardinality(m.mentioned_agent_ids) = 1))
      order by m.created_at desc limit 500`),
  );
  const groups = new Map<
    string,
    { agentId: string; channelId: string; dm: boolean; text: string; days: Set<string>; hours: number[] }
  >();
  for (const m of sent) {
    const mentioned = typeof m.mentioned === "string" ? m.mentioned.replace(/[{}]/g, "").split(",") : m.mentioned;
    const agentId =
      m.kind === "dm"
        ? (m.dm_key
            ?.split("|")
            .find((p) => p.startsWith("a:"))
            ?.slice(2) ?? null)
        : (mentioned?.[0] ?? null);
    if (!agentId || !teamIds.has(agentId) || (m.kind === "dm" && !m.dm_key?.includes(`u:${w.userId}`))) continue;
    const key = requestKey(m.body);
    if (!key) continue;
    const at = new Date(m.created_at);
    const id = `${agentId}|${m.channel_id}|${key}`;
    const g = groups.get(id) ?? {
      agentId,
      channelId: m.channel_id,
      dm: m.kind === "dm",
      // Newest first: the latest wording.
      text: m.body.replace(/\s+/g, " ").trim().slice(0, 300),
      days: new Set<string>(),
      hours: [],
    };
    g.days.add(localDate(at, w.timezone));
    g.hours.push(localHour(at, w.timezone));
    groups.set(id, g);
  }
  const best = [...groups.values()]
    .filter((g) => g.days.size >= REPEAT_DAYS)
    .sort((a, b) => b.days.size - a.days.size)[0];
  if (!best) return null;
  const made = rowsOf<{ prompt: string }>(
    await db.execute(sql`select prompt from routines where org_id = ${w.orgId} and agent_id = ${best.agentId}`),
  );
  const key = requestKey(best.text);
  if (made.some((r) => requestKey(r.prompt) === key)) return null;
  return {
    id: `routine:${best.agentId}:${best.channelId}`,
    kind: "routine",
    agentId: best.agentId,
    channelId: best.channelId,
    dm: best.dm,
    text: best.text,
    count: best.days.size,
    hour: mode(best.hours),
  };
}

const mode = (list: number[]) => {
  const n = new Map<number, number>();
  for (const x of list) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 9;
};

/**
 * A task whose steps wait for hours while another step is in progress or in review (a reviewer rejecting step 1
 * while steps 2 to 4 wait on it): the one stalled the longest.
 */
async function stalledSteps(db: Database, w: Window): Promise<TeamWeekRow | null> {
  const [s] = rowsOf<{
    id: string;
    number: number;
    title: string;
    assignee_type: string | null;
    assignee_id: string | null;
    steps: number[] | string;
    on_number: number | null;
    on_agent: string | null;
    moved: string | Date;
  }>(
    await db.execute(sql`select p.id, p.number, p.title, p.assignee_type, p.assignee_id,
        array_agg(s.number order by s.number) filter (where s.status = 'todo') as steps,
        (array_agg(s.number order by s.number) filter (where s.status in ('in_progress', 'in_review') or s.blocked is not null))[1] as on_number,
        (array_agg(s.assignee_id order by s.number) filter (where s.assignee_type = 'agent' and (s.status in ('in_progress', 'in_review') or s.blocked is not null)))[1] as on_agent,
        max(s.updated_at) as moved
      from issues p join issues s on s.parent_issue_id = p.id and s.org_id = p.org_id
        and ${taskSeenSql("s", sql`${w.userId}::text`)}
      where p.org_id = ${w.orgId} and p.status not in ('done', 'canceled')
        and ${taskSeenSql("p", sql`${w.userId}::text`)}
      group by p.id
      having count(*) filter (where s.status = 'todo') >= 2
        and count(*) filter (where s.status in ('in_progress', 'in_review') or s.blocked is not null) >= 1
        and max(s.updated_at) < ${new Date(w.end.getTime() - STALL_MS).toISOString()}::timestamptz
      order by max(s.updated_at) limit 1`),
  );
  if (!s || s.on_number == null) return null;
  const steps = typeof s.steps === "string" ? s.steps.replace(/[{}]/g, "").split(",").map(Number) : s.steps;
  return {
    id: `stalled:${s.id}`,
    kind: "stalled",
    issueId: s.id,
    number: s.number,
    title: s.title.slice(0, 120),
    steps,
    onNumber: s.on_number,
    hours: Math.floor((w.end.getTime() - new Date(s.moved).getTime()) / HOUR_MS),
    agentId: s.assignee_type === "agent" ? s.assignee_id : s.on_agent,
  };
}

/** How many proven how-tos one card offers to make skills, at most. */
const HOWTOS_SHOWN = 3;

/**
 * The person's own agents' how-tos reused at least `LEARN_DEFAULTS.skillAfter` times that are still untrusted, so the
 * day's pass can't make them skills (ADR 0167), the most reused first.
 */
async function provenHowTos(db: Database, w: Window): Promise<TeamWeekRow[]> {
  const rows = await db
    .select({
      id: contextItems.id,
      agentId: contextItems.agentId,
      title: contextItems.title,
      content: contextItems.content,
      uses: contextItems.recurrence,
    })
    .from(contextItems)
    .innerJoin(agents, eq(agents.id, contextItems.agentId))
    .where(
      and(
        eq(contextItems.orgId, w.orgId),
        eq(agents.ownerUserId, w.userId),
        isNull(agents.archivedAt),
        eq(contextItems.status, "active"),
        isNull(contextItems.supersededBy),
        howToSql(),
        eq(contextItems.trust, "low"),
        eq(contextItems.disputed, false),
        gte(contextItems.recurrence, LEARN_DEFAULTS.skillAfter),
      ),
    )
    .orderBy(desc(contextItems.recurrence))
    .limit(HOWTOS_SHOWN);
  return rows.map((r) => ({
    id: `howto:${r.id}`,
    kind: "howto" as const,
    agentId: r.agentId ?? "",
    itemId: r.id,
    title: cutText(r.title || r.content, 120),
    uses: r.uses,
  }));
}

// --- When it goes out ------------------------------------------------------------------------------------------

/** How many jobs one insert carries: well under the statement's limit of parameters. */
const ENQUEUE_BATCH = 1000;

interface NearTeamWeek {
  org_id: string;
  user_id: string;
  team_week: unknown;
  tz: string;
  day_tz: string;
  admin: boolean;
}

/**
 * The members a card may be due for at `now`, in open workspaces with a team and Lodi: who is within the hours after
 * their slot and has no job for that card yet (the dedupe keys of `teamWeekJobKey`, rebuilt here, each looked up by the
 * unique index). So a member comes back on the tick after their slot and not again that day, and a tick reads only
 * who it may queue. Who administers is asked only for those, on the day a week's card may be due.
 */
export async function nearTeamWeeks(db: Database, now: Date): Promise<NearTeamWeek[]> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const window = POST_WINDOW_MS / HOUR_MS;
  const tz = sql`z.tz`;
  const dayTz = sql`z.day_tz`;
  const hoursSince = (hour: unknown, zone: unknown) =>
    sql`((extract(hour from ${at} at time zone ${zone})::int - ${hour} + 24) % 24)`;
  // The slot on that zone's clock: its date is the one in the day's key, its week's Monday the one in the week's.
  const slotClock = (hour: unknown, zone: unknown) =>
    sql`((${at} at time zone ${zone}) - make_interval(hours => ${hoursSince(hour, zone)}))`;
  const queued = (key: unknown) =>
    sql`exists (select 1 from outbox o
      where o.dedupe_key = ${TEAM_WEEK_JOB}::text || ':' || m.org_id::text || ':' || m.user_id::text || ':' || ${key})`;
  const dayKey = sql`'day:' || to_char(${slotClock(lodiPrefsSql.dayHour, dayTz)}, 'YYYY-MM-DD')`;
  const weekKeySql = sql`to_char(date_trunc('week', ${slotClock(lodiPrefsSql.weekHour, tz)}), 'YYYY-MM-DD')`;
  const weekday = (moment: unknown) => sql`extract(dow from ${moment} at time zone ${tz})::int`;
  const weekly = sql`(not ${lodiPrefsSql.weekOff}
    and ${lodiPrefsSql.day} in (${weekday(at)}, ${weekday(sql`(${at} - make_interval(hours => ${window}))`)}))`;
  return rowsOf<NearTeamWeek>(
    await db.execute(sql`with ${knownZonesSql}
      select org_id, user_id, team_week, tz, day_tz, admin from (
        select near.*, case when near.weekly
          then ${maySql(sql`near.org_id`, sql`near.user_id`, "administrator")} else false end as admin
        from (
          select m.org_id, m.user_id, m.team_week, ${tz} as tz, ${dayTz} as day_tz, ${weekly} as weekly,
            not ${lodiPrefsSql.dayOff} and ${hoursSince(lodiPrefsSql.dayHour, dayTz)} <= ${window}
              and not ${queued(dayKey)} as day_near,
            ${weekly} and ${hoursSince(lodiPrefsSql.weekHour, tz)} <= ${window}
              and not ${queued(weekKeySql)} as week_near
          from organization_members m
          join organizations on organizations.id = m.org_id and ${openOrg}
          left join organization_settings s on s.org_id = m.org_id
          cross join lateral (select ${zoneSql(sql`s.timezone`, sql`'UTC'`)} as tz,
            ${zoneSql(sql`m.timezone`, zoneSql(sql`s.timezone`, sql`'UTC'`))} as day_tz) z
          where exists (select 1 from agents a where a.org_id = m.org_id and a.builtin is null
              and a.archived_at is null and a.deleted_at is null)
            and exists (select 1 from agents a where a.org_id = m.org_id and a.builtin = 'right_hand')
        ) near where day_near or week_near
      ) due where day_near or (admin and week_near)`),
  );
}

/**
 * Queues the cards whose slot just passed: the day's for everyone who has it on, the week's for administrators
 * (dedupe: one per person and day, one per person and week). Returns how many it queued.
 *
 * Every member of every workspace has the day's card on unless they stopped it, so the statement picks who may be due
 * (`nearTeamWeeks`), the exact slot is worked out here for those alone, and they are queued a batch per statement.
 */
export async function enqueueTeamWeeks(db: Database, now = new Date()) {
  const jobs = (await nearTeamWeeks(db, now)).flatMap((d) =>
    dueTeamWeeks(lodiPrefsOf(d.team_week), { admin: d.admin, timezone: d.tz, dayTimezone: d.day_tz }, now).map(
      ({ period, slot, timezone }) => ({
        orgId: d.org_id,
        kind: period === "day" ? TEAM_DAY_JOB : TEAM_WEEK_JOB,
        payload: { userId: d.user_id, slot: slot.toISOString(), period },
        dedupeKey: teamWeekJobKey(d.org_id, d.user_id, period, slot, timezone),
        maxAttempts: 4,
      }),
    ),
  );
  let queued = 0;
  for (let i = 0; i < jobs.length; i += ENQUEUE_BATCH) {
    const rows = await db
      .insert(outbox)
      .values(jobs.slice(i, i + ENQUEUE_BATCH))
      .onConflictDoNothing()
      .returning({ id: outbox.id });
    queued += rows.length;
  }
  return queued;
}

/**
 * The job: builds this person's card and posts it in their DM with Lodi. Returns the message id, or null (none in a
 * workspace closed to changes since it was queued).
 */
export async function postTeamWeek(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  payload: { userId?: unknown; slot?: unknown; period?: unknown },
) {
  const { db } = deps;
  const userId = typeof payload.userId === "string" ? payload.userId : null;
  const slot = typeof payload.slot === "string" ? new Date(payload.slot) : null;
  if (!userId || !slot || Number.isNaN(slot.getTime())) return null;
  // Someone who left gets none. Any other failure is the job's to retry: ending here would spend the day's key.
  const member = await readLodiPrefs(db, orgId, userId).catch((error) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!member) return null;
  const { prefs, admin } = member;
  // A job queued before cards named their period carries none: the one card that person then got.
  const period: TeamWeekPeriod =
    payload.period === "day" || payload.period === "week" ? payload.period : admin && !prefs.weekOff ? "week" : "day";
  if (period === "week" ? !admin || prefs.weekOff : prefs.dayOff) return null;
  const lodi = await lodiFor(db, orgId, userId);
  if (!lodi) return null;
  const timezone = period === "day" ? member.dayTimezone : member.timezone;
  const start = new Date(slot.getTime() - teamWeekSpan(period));
  const posted = async (tx: Executor) =>
    rowsOf<{ id: string }>(
      await tx.execute(sql`select id from messages where org_id = ${orgId} and author_agent_id = ${lodi.id}
        and meta->'actionCard'->>'kind' = ${TEAM_WEEK_CARD} and meta->'actionCard'->>'forUserId' = ${userId}
        and meta->'actionCard'->>'from' = ${localDate(start, timezone)}
        and coalesce(meta->'actionCard'->>'period', 'week') = ${period} limit 1`),
    ).length > 0;
  // A retry after the card went out builds nothing: building again would stale the proposals that card shows.
  if (await posted(db)) return null;
  const built = await buildTeamWeek(db, { orgId, userId, rightHandId: lodi.id, start, end: slot, timezone, admin });
  if (!built) return null;
  const card: TeamWeekCard = { ...built, period, done: {}, dismissedAt: null };
  const [settings] = await db
    .select({ mode: organizationSettings.mode })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  // A personal workspace's week is the person's own with their agents (ADR 0159), not a team's.
  const week = settings?.mode === "personal" ? "teamWeekReadyPersonal" : "teamWeekReady";
  return postFromLodi(deps, orgId, userId, {
    bodyCode: TEAM_WEEK_CARD,
    bodyParams: { from: card.from, to: card.to, ...(period === "day" ? { period } : {}) },
    // Only this person reads it: the push and the conversation list say it in their language.
    body: (locale) => pushStrings(locale)[period === "day" ? "teamDayReady" : week],
    meta: { actionCard: card },
    push: true,
    posted,
    lodi,
  });
}

// --- What a person does with it --------------------------------------------------------------------------------

/**
 * A row applied from the card as `actorId` (only the person it is for: it lives in their DM), or "Agora não"
 * (`dismiss`). Settings and approvals rows go through their own paths; here the routine is made, Lodi is asked for an
 * agent, or the task's agent is told to go on (`text`: the person's own words, in their language). Returns the card.
 */
export async function actOnTeamWeek(
  deps: RoutineDeps,
  actorId: string,
  orgId: string,
  messageId: string,
  input: { dismiss: true } | { rowId: string; text?: string },
): Promise<TeamWeekCard> {
  const { db } = deps;
  const message = await getMessage(db, orgId, messageId);
  const card = message ? teamWeekCardOf(message.meta) : null;
  if (!message || !card) throw new NotFoundError("Card not found");
  if (card.forUserId !== actorId) throw new ForbiddenError("This card is someone else's");
  const next: TeamWeekCard = { ...card, done: { ...(card.done ?? {}) } };
  if ("dismiss" in input) next.dismissedAt = new Date().toISOString();
  else {
    const row = card.rows.find((r) => r.id === input.rowId);
    if (!row) throw new NotFoundError("Row not found");
    if (next.done[row.id]) throw new ConflictError("Already done", "team_week.done");
    const text = input.text?.trim().slice(0, 2000) ?? "";
    const done: TeamWeekCard["done"][string] = { byUserId: actorId, at: new Date().toISOString() };
    if (row.kind === "routine") {
      const routine = await createRoutine(deps, actorId, orgId, {
        agentId: row.agentId,
        prompt: row.text,
        name: row.text.slice(0, 60),
        target: row.dm ? { type: "dm" } : { type: "channel", channelId: row.channelId },
        trigger: {
          type: "schedule",
          rule: { freq: "daily", times: [`${String(row.hour).padStart(2, "0")}:00`], timezone: card.timezone },
        },
        report: "always",
      });
      done.routineId = routine.id;
    } else if (row.kind === "unanswered") {
      if (!text) throw new ValidationError("Say what to ask");
      await postPersonMessage({ db, pubsub: deps.pubsub }, actorId, orgId, message.channelId, { body: text });
    } else if (row.kind === "stalled") {
      if (!text) throw new ValidationError("Say what to tell its agent");
      await commentIssue({ db, pubsub: deps.pubsub }, { type: "person", userId: actorId }, orgId, row.issueId, text);
    } else if (row.kind === "howto") {
      // The person vouches for it (ADR 0167): trusted and verified, the day's pass makes it the agent's skill.
      await editContextItem(db, actorId, orgId, row.itemId, { confirmed: true });
    } else throw new ValidationError("This row is applied on its own card", "team_week.own_path");
    next.done[row.id] = done;
  }
  await setCardOnMessage(deps, orgId, messageId, next);
  return next;
}
