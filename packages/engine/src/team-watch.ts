import { and, type Database, desc, eq, gt, inArray, isNull, lt, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import type { Agent } from "./agents";
import { backgroundAiState } from "./ai-status";
import type { JobDeps } from "./jobs";
import {
  inboxVisible,
  type NotificationDeps,
  type NotificationKind,
  type NotificationSource,
  notify,
  remindNotifications,
  resolveNotifications,
  rewriteNotification,
} from "./notifications";
import { can, getMembership, type Membership } from "./organizations";
import { maySql, type RolePermission } from "./permissions";
import { personLocale } from "./requester";
import { defineLodiLane, liveLodiSwitches } from "./right-hand-lane";
import { knownZonesSql, lodiPrefsSql, zoneSql } from "./right-hand-prefs";
import { lodiFor, lodiSwitches, saidKey, saidOnce } from "./right-hand-proactive";
import { lastGoodRun, outsideRoutineFailure, routineResumeKey } from "./routine-ledger";
import { ROUTINE_FATIGUE_LIMIT } from "./routine-state";
import { resumeRoutineBySystem } from "./routines";
import { openOrg } from "./standing";
import { DEFAULT_AGENT_BUDGET_NANO_USD, monthStartUtc } from "./usage";

/**
 * "Cuidar da equipe": the right hand looks for what stops the team and acts. It calls no model.
 *
 * - It fixes what is safe by itself, silently (the audit log says so): a scheduled routine that paused itself as
 *   `failing` for causes outside it is resumed once those passed (`resumeCleared`), and a routine's first failure for
 *   such a cause gets one more try before anyone is told (`routine-ledger.ts`).
 * - It tells the one person who can fix the rest, through "Esperando você" (`team_watch`), once, with the cause and
 *   the one way out: an AI sign-in that ended, an app, a mailbox or a database to reconnect, a budget used up or
 *   about to be, a computer gone while agents wait for it (`tellProblems`).
 * - It reminds a person, once a day and never twice of the same thing, of what they left unread there for hours
 *   (`remindUnread`).
 *
 * The contract with the rest of the server is `teamWatchLane` below: the server reads the jobs, the sweep and the
 * switch from it, so nothing else is wired by hand.
 * - `enqueueTeamWatches` runs on the worker's `rightHand` tick, every 10 minutes, for every workspace at once. It
 *   queues `TEAM_WATCH_JOB` (payload `{}`, the organization on the job) only for open workspaces that have the right
 *   hand, whose `organization_settings.team_watch` is on (no row counts as on) and that have something to look at.
 * - `runTeamWatch` is that job. It reads the switch again and may run twice: every step is once-only by a key.
 */

export const TEAM_WATCH_JOB = "team_watch.check";

/** What it tells, by cause (`latest.reason`, worded by `notifications.teamWatch.<cause>`). */
export const TEAM_WATCH_CAUSES = [
  "sign_in",
  "connector",
  "mailbox",
  "database",
  "budget_out",
  "budget_low",
  "computer",
] as const;
export type TeamWatchCause = (typeof TEAM_WATCH_CAUSES)[number];

/** A sign-in, an app or a mailbox is told once it stayed wrong this long: a blip tells nobody. */
export const TELL_GRACE_MS = 20 * 60_000;
/** A brought computer is told once it has been gone this long with work waiting for it. */
export const OFFLINE_GRACE_MS = 30 * 60_000;
/** The share of a month's budget from which it is "about to end", when the month's pace would end it early. */
export const BUDGET_LOW_RATIO = 0.8;
/** New rows a person gets from it in a day, whatever is wrong. */
export const TEAM_WATCH_DAILY_ROWS = 3;
/** How many things a row names. The rest are counted. */
const MAX_NAMES = 3;
/** A paused routine is looked at from this long after its pause (an outage needs time to pass) and for a day. */
export const ROUTINE_RESUME_AFTER_MS = 30 * 60_000;
const RESUME_WITHIN_MS = 24 * 3600_000;
/** What waits on a person unread this long is reminded once, in their daytime. */
export const UNANSWERED_MS = 4 * 3600_000;
const DAY_STARTS = 9;
const DAY_ENDS = 18;
/** The asks it reminds of: what blocks an agent until this person answers. */
const REMINDED_KINDS: NotificationKind[] = ["approval", "agent_question", "secret_request"];
/** From this many approvals waiting, the digest of approvals is the reminder. */
const DIGEST_FROM = 3;

const {
  agentBudgetPeriods,
  agentRuns,
  agents,
  connectorConnections,
  dbConnections,
  machineAccounts,
  machines,
  mailAccounts,
  notifications,
  organizationSettings,
  outbox,
  routineRuns,
  routines,
} = schema;

/** A budget's month, as `agent_budget_periods.period_start` holds it. */
const periodOf = (now: Date) => monthStartUtc(now).toISOString().slice(0, 10);

// ── The sweep ─────────────────────────────────────────────────────────────────

/** An ask left unread for hours and not reminded yet, over `notifications n`. */
const unreadAsk = (at: SQL) => sql`n.waiting and n.done_at is null and n.read_at is null
  and (n.snoozed_until is null or n.snoozed_until <= ${at})
  and n.kind in (${sql.join(
    REMINDED_KINDS.map((k) => sql`${k}`),
    sql`, `,
  )})
  and n.created_at < (${at} - make_interval(secs => ${UNANSWERED_MS / 1000}))
  and n.latest->>'reminder' is null`;

/** The person's own clock (their zone, else the workspace's, else UTC), over `organization_members m` and settings `s`. */
const localClock = (at: SQL) =>
  sql`(${at} at time zone ${zoneSql(sql`m.timezone`, zoneSql(sql`s.timezone`, sql`'UTC'`))})`;
const daytime = (at: SQL) => sql`extract(hour from ${localClock(at)})::int between ${DAY_STARTS} and ${DAY_ENDS - 1}`;

/**
 * Queues one check for each open workspace that has the right hand, "Cuidar da equipe" on and something to look at:
 * an open row of its own (to close once fixed), a candidate problem, a routine it may resume, an ask to remind of.
 * One job per workspace and 10-minute window. Returns how many it queued.
 */
export async function enqueueTeamWatches(db: Database, now: Date = new Date()): Promise<number> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const ago = (ms: number) => sql`(${at} - make_interval(secs => ${ms / 1000}))`;
  const budget = sql`coalesce(a.monthly_budget_nano_usd, s.default_agent_budget_nano_usd,
    ${DEFAULT_AGENT_BUDGET_NANO_USD}::bigint)`;
  // ponytail: a workspace with a standing problem is checked every 10 minutes until it is fixed (about ten small
  // queries each time). If the outbox shows that as load, widen the window for problems that did not change.
  const orgs = rowsOf<{ id: string }>(
    await db.execute(sql`with ${knownZonesSql}
      select organizations.id from organizations
      left join organization_settings s on s.org_id = organizations.id
      where ${openOrg} and coalesce(s.team_watch, true)
        and exists (select 1 from agents a where a.org_id = organizations.id and a.builtin = 'right_hand'
          and a.archived_at is null)
        and (
          exists (select 1 from notifications n where n.org_id = organizations.id and n.kind = 'team_watch'
            and n.done_at is null)
          or exists (select 1 from machine_accounts ma where ma.org_id = organizations.id
            and ma.status = 'signed_out' and ma.created_by is not null and ma.updated_at < ${ago(TELL_GRACE_MS)})
          or exists (select 1 from connector_connections c where c.org_id = organizations.id
            and c.status = 'needs_reconnect' and c.revoked_at is null and c.updated_at < ${ago(TELL_GRACE_MS)})
          or exists (select 1 from mail_accounts ml where ml.org_id = organizations.id
            and ml.status = 'needs_reconnect' and ml.revoked_at is null and ml.created_by_user_id is not null
            and ml.updated_at < ${ago(TELL_GRACE_MS)})
          or exists (select 1 from db_connections d where d.org_id = organizations.id
            and d.status = 'needs_reconnect' and d.revoked_at is null)
          or exists (select 1 from machines mc where mc.org_id = organizations.id and mc.kind = 'connected'
            and mc.deleted_at is null and coalesce(mc.last_seen_at, mc.updated_at) < ${ago(OFFLINE_GRACE_MS)}
            and exists (select 1 from agent_runs r where r.waiting_machine_id = mc.id))
          or exists (select 1 from agent_budget_periods b join agents a on a.id = b.agent_id
            where b.org_id = organizations.id and b.period_start = ${periodOf(now)}::date and a.archived_at is null
              and ${budget} > 0 and b.spent_nano_usd >= ${BUDGET_LOW_RATIO}::numeric * ${budget})
          or exists (select 1 from routines rt where rt.org_id = organizations.id and not rt.active
            and rt.paused_reason = 'failing' and rt.trigger_type = 'schedule' and rt.deleted_at is null
            and rt.updated_at < ${ago(ROUTINE_RESUME_AFTER_MS)} and rt.updated_at > ${ago(RESUME_WITHIN_MS)})
          or exists (select 1 from notifications n
            join organization_members m on m.org_id = n.org_id and m.user_id = n.user_id
            where n.org_id = organizations.id and ${unreadAsk(at)} and ${daytime(at)})
        )`),
  );
  if (orgs.length === 0) return 0;
  const queued = await db
    .insert(outbox)
    .values(
      orgs.map((o) => ({
        orgId: o.id,
        kind: TEAM_WATCH_JOB,
        payload: {},
        dedupeKey: `${TEAM_WATCH_JOB}:${o.id}:${Math.floor(now.getTime() / 600_000)}`,
        maxAttempts: 3,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: outbox.id });
  return queued.length;
}

// ── The job ───────────────────────────────────────────────────────────────────

/** One look at a workspace: what it may fix, what it tells, what it reminds of. Nothing with the switch off. */
export async function runTeamWatch(deps: JobDeps, orgId: string, now: Date = new Date()): Promise<void> {
  const { db } = deps;
  if (!(await lodiSwitches(db, orgId)).teamWatch) return;
  const lodi = await lodiFor(db, orgId);
  if (!lodi) return;
  const inbox: NotificationDeps = { db, pubsub: deps.pubsub, now: () => now };
  await resumeCleared(deps, orgId, lodi, now);
  await tellProblems(inbox, orgId, lodi, now);
  await remindUnread(inbox, orgId, now);
}

// ── Fixes ─────────────────────────────────────────────────────────────────────

/**
 * Scheduled routines that paused themselves as `failing`: one whose last failures were all for causes outside it
 * (`outsideRoutineFailure`) and whose agent can think now is resumed, once between two good runs. A routine that
 * fails for its own reasons, or pauses again after this, stays paused: its pause notice already told its people.
 */
async function resumeCleared(deps: JobDeps, orgId: string, lodi: Agent, now: Date): Promise<number> {
  const { db } = deps;
  const paused = await db
    .select({ id: routines.id, agentId: routines.agentId })
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        eq(routines.active, false),
        eq(routines.pausedReason, "failing"),
        eq(routines.triggerType, "schedule"),
        isNull(routines.deletedAt),
        lt(routines.updatedAt, new Date(now.getTime() - ROUTINE_RESUME_AFTER_MS)),
        gt(routines.updatedAt, new Date(now.getTime() - RESUME_WITHIN_MS)),
      ),
    );
  let resumed = 0;
  for (const r of paused) {
    const lastGood = await lastGoodRun(db, r.id);
    const failures = await db
      .select({ code: routineRuns.code, error: agentRuns.error })
      .from(routineRuns)
      .leftJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
      .where(
        and(
          eq(routineRuns.routineId, r.id),
          eq(routineRuns.status, "failed"),
          gt(routineRuns.finishedAt, new Date(lastGood)),
        ),
      )
      .orderBy(desc(routineRuns.finishedAt))
      .limit(ROUTINE_FATIGUE_LIMIT);
    if (failures.length < ROUTINE_FATIGUE_LIMIT || !failures.every((f) => outsideRoutineFailure(f.code, f.error)))
      continue;
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, r.agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)));
    if (!agent) continue;
    const ai = await backgroundAiState({ db, gateway: deps.gateway, machines: deps.machines ?? null }, agent);
    // Not passed yet: looked at again on the next check, for a day.
    if (ai.state !== "ready") continue;
    if (!(await saidOnce(db, orgId, routineResumeKey(r.id, lastGood)))) continue;
    if (await resumeRoutineBySystem(deps, orgId, r.id, { type: "agent", id: lodi.id })) resumed++;
  }
  return resumed;
}

// ── Tells ─────────────────────────────────────────────────────────────────────

/** One thing wrong: what it is, which time it is wrong (`episode`), and who may fix it. */
interface Problem {
  cause: TeamWatchCause;
  id: string;
  name: string;
  /** The same thing wrong again later is another episode, told again. */
  episode: string;
  since: Date;
  /** Whose it is to fix, when they still may (`needs`). Else the first person who may `orElse`, else nobody. */
  to: string | null;
  needs?: RolePermission;
  orElse?: RolePermission;
}

/**
 * Kinds that already tell a person the same thing, by cause: with such a row of theirs since the problem began, the
 * right hand adds none of its own.
 */
const SAID_ELSEWHERE: Partial<Record<TeamWatchCause, SQL>> = {
  sign_in: sql`(${notifications.kind} = 'run_failed' and ${notifications.latest}->>'reason' = 'not_logged_in')`,
  budget_out: sql`(${notifications.kind} in ('run_failed', 'routine_failed', 'widget_failed')
    and ${notifications.latest}->>'reason' = 'budget_exceeded')`,
  computer: sql`(${notifications.kind} in ('routine_stalled', 'device.waiting')
    or (${notifications.kind} = 'run_failed' and ${notifications.latest}->>'reason' = 'machine_offline'))`,
};

/** Everything wrong in the workspace now, from stored rows only. */
async function problemsOf(db: Database, orgId: string, now: Date): Promise<Problem[]> {
  const stale = new Date(now.getTime() - TELL_GRACE_MS);
  const out: Problem[] = [];
  const at = (d: Date) => String(d.getTime());

  // A plan's sign-in ended while an agent thinks with it: only whose plan it is hears it.
  const accounts = await db
    .select({
      id: machineAccounts.id,
      name: machineAccounts.label,
      by: machineAccounts.createdBy,
      since: machineAccounts.updatedAt,
    })
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        eq(machineAccounts.status, "signed_out"),
        lt(machineAccounts.updatedAt, stale),
        sql`(${machineAccounts.shared} or exists (select 1 from agents a where a.org_id = ${orgId}
          and a.brain_account_id = ${machineAccounts.id} and a.archived_at is null))`,
      ),
    );
  for (const a of accounts) out.push({ cause: "sign_in", ...a, episode: at(a.since), to: a.by });

  const connectors = await db
    .select({
      id: connectorConnections.id,
      name: connectorConnections.label,
      by: connectorConnections.createdByUserId,
      since: connectorConnections.updatedAt,
    })
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.orgId, orgId),
        eq(connectorConnections.status, "needs_reconnect"),
        isNull(connectorConnections.revokedAt),
        lt(connectorConnections.updatedAt, stale),
      ),
    );
  for (const c of connectors)
    out.push({
      cause: "connector",
      ...c,
      episode: at(c.since),
      to: c.by,
      needs: "manage_connectors",
      orElse: "manage_connectors",
    });

  // A mailbox is its owner's alone: nobody else hears of it, not even its address.
  const mailboxes = await db
    .select({
      id: mailAccounts.id,
      address: mailAccounts.address,
      label: mailAccounts.label,
      by: mailAccounts.createdByUserId,
      since: mailAccounts.updatedAt,
    })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.orgId, orgId),
        eq(mailAccounts.status, "needs_reconnect"),
        isNull(mailAccounts.revokedAt),
        lt(mailAccounts.updatedAt, stale),
      ),
    );
  for (const m of mailboxes)
    out.push({
      cause: "mailbox",
      id: m.id,
      name: m.address || m.label,
      episode: at(m.since),
      since: m.since,
      to: m.by,
    });

  // A refused password does not heal by itself, and its row keeps no time of the refusal: told at the next look.
  const databases = await db
    .select({
      id: dbConnections.id,
      name: dbConnections.label,
      by: dbConnections.createdByUserId,
      since: dbConnections.updatedAt,
    })
    .from(dbConnections)
    .where(
      and(eq(dbConnections.orgId, orgId), eq(dbConnections.status, "needs_reconnect"), isNull(dbConnections.revokedAt)),
    );
  for (const d of databases)
    out.push({
      cause: "database",
      ...d,
      episode: at(d.since),
      to: d.by,
      needs: "manage_connectors",
      orElse: "manage_connectors",
    });

  // A month's budget used up stops the agent. One at 80% is told only when the month's pace would end it early.
  const period = periodOf(now);
  const monthStart = monthStartUtc(now).getTime();
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsed = Math.max((now.getTime() - monthStart) / (monthEnd - monthStart), 0.001);
  const [settings] = await db
    .select({ budget: organizationSettings.defaultAgentBudgetNanoUsd })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  const spends = await db
    .select({
      id: agents.id,
      name: agents.name,
      owner: agents.ownerUserId,
      budget: agents.monthlyBudgetNanoUsd,
      spent: agentBudgetPeriods.spentNanoUsd,
    })
    .from(agentBudgetPeriods)
    .innerJoin(agents, eq(agents.id, agentBudgetPeriods.agentId))
    .where(
      and(eq(agentBudgetPeriods.orgId, orgId), eq(agentBudgetPeriods.periodStart, period), isNull(agents.archivedAt)),
    );
  for (const a of spends) {
    const budget = a.budget ?? settings?.budget ?? DEFAULT_AGENT_BUDGET_NANO_USD;
    if (budget <= 0 || a.spent < BUDGET_LOW_RATIO * budget) continue;
    const usedUp = a.spent >= budget;
    if (!usedUp && a.spent / elapsed <= budget) continue;
    out.push({
      cause: usedUp ? "budget_out" : "budget_low",
      id: a.id,
      name: a.name,
      // Raised and used up again in the same month is told again.
      episode: `${period}:${budget}`,
      since: new Date(monthStart),
      to: a.owner,
      needs: "manage_agents",
      orElse: "manage_agents",
    });
  }

  // A computer a person brought, gone while runs wait for it. The workspace's own computers are the operator's.
  const offline = await db
    .select({
      id: machines.id,
      name: machines.name,
      by: machines.pairedByUserId,
      seen: machines.lastSeenAt,
      at: machines.updatedAt,
    })
    .from(machines)
    .where(
      and(
        eq(machines.orgId, orgId),
        eq(machines.kind, "connected"),
        isNull(machines.deletedAt),
        sql`coalesce(${machines.lastSeenAt}, ${machines.updatedAt}) < ${new Date(now.getTime() - OFFLINE_GRACE_MS).toISOString()}::timestamptz`,
        sql`exists (select 1 from agent_runs r where r.waiting_machine_id = ${machines.id})`,
      ),
    );
  for (const m of offline) {
    const since = m.seen ?? m.at;
    out.push({ cause: "computer", id: m.id, name: m.name, episode: at(since), since, to: m.by, orElse: "configure" });
  }
  return out;
}

const toldKey = (userId: string, p: Problem) => `team_watch.told:${userId}:${p.cause}:${p.id}:${p.episode}`;

/** The names a row shows: the first ones, then how many more ("Slack, Notion, Linear +2"). */
export const teamWatchNames = (names: readonly string[]) =>
  names.slice(0, MAX_NAMES).join(", ") + (names.length > MAX_NAMES ? ` +${names.length - MAX_NAMES}` : "");

/**
 * Tells each problem to the one person who can fix it: one open row per person and cause, listing all of that cause
 * that is theirs, rewritten in place as the list changes and done once it is empty. A new row comes only for a problem
 * this person was never told (`toldKey`), so one put away with "Feito" does not return, and at most
 * `TEAM_WATCH_DAILY_ROWS` new rows a person a day.
 */
async function tellProblems(deps: NotificationDeps, orgId: string, lodi: Agent, now: Date): Promise<void> {
  const { db } = deps;
  const problems = await problemsOf(db, orgId, now);
  const members = new Map<string, Membership | null>();
  const memberOf = async (userId: string) => {
    if (!members.has(userId)) members.set(userId, await getMembership(db, userId, orgId));
    return members.get(userId) ?? null;
  };
  const firsts = new Map<RolePermission, string | null>();
  const firstWhoMay = async (permission: RolePermission) => {
    if (!firsts.has(permission)) {
      const [row] = rowsOf<{ user_id: string }>(
        await db.execute(sql`select m.user_id from organization_members m where m.org_id = ${orgId}
          and ${maySql(sql`m.org_id`, sql`m.user_id`, permission)}
          order by (m.role = 'owner') desc, m.created_at asc limit 1`),
      );
      firsts.set(permission, row?.user_id ?? null);
    }
    return firsts.get(permission) ?? null;
  };

  // Who each problem is told to, by person and cause.
  const groups = new Map<string, { userId: string; cause: TeamWatchCause; problems: Problem[] }>();
  for (const p of problems) {
    const own = p.to ? await memberOf(p.to) : null;
    const userId = own && (!p.needs || can(own, p.needs)) ? p.to : p.orElse ? await firstWhoMay(p.orElse) : null;
    if (!userId) continue;
    const key = `${userId}:${p.cause}`;
    const group = groups.get(key) ?? { userId, cause: p.cause, problems: [] };
    group.problems.push(p);
    groups.set(key, group);
  }

  const causeOf = (row: { latest: Record<string, unknown> }) => String(row.latest.reason ?? "");
  const open = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, orgId), eq(notifications.kind, "team_watch"), isNull(notifications.doneAt)));
  // What is no longer wrong leaves by itself.
  const fixed = open.filter((r) => !groups.has(`${r.userId}:${causeOf(r)}`));
  if (fixed.length) await resolveNotifications(deps, orgId, { ids: fixed.map((r) => r.id) });

  for (const g of groups.values()) {
    g.problems.sort((a, b) => a.since.getTime() - b.since.getTime());
    const keys = g.problems.map((p) => saidKey(orgId, toldKey(g.userId, p)));
    const told = new Set(
      (await db.select({ key: outbox.dedupeKey }).from(outbox).where(inArray(outbox.dedupeKey, keys))).map(
        (r) => r.key,
      ),
    );
    let fresh = g.problems.filter((_, i) => !told.has(keys[i] as string));
    const markTold = async (list: Problem[]) => {
      for (const p of list) await saidOnce(db, orgId, toldKey(g.userId, p));
    };
    const names = g.problems.map((p) => p.name);
    const only = g.problems.length === 1 ? g.problems[0] : undefined;
    const source: NotificationSource = {
      ...(only && g.cause.startsWith("budget_") ? { agentId: only.id } : {}),
      ...(only && g.cause === "computer" ? { machineId: only.id } : {}),
      ...(only && g.cause === "sign_in" ? { accountId: only.id } : {}),
    };
    const latest = {
      reason: g.cause,
      names: names.slice(0, MAX_NAMES),
      text: serverText(await personLocale(db, g.userId), `notifications.teamWatch.${g.cause}`, {
        names: teamWatchNames(names),
      }),
    };
    const row = open.find((r) => r.userId === g.userId && causeOf(r) === g.cause);
    if (row) {
      if (row.count !== names.length || row.latest.text !== latest.text)
        await rewriteNotification(deps, row.id, { count: names.length, source, latest, unread: fresh.length > 0 });
      await markTold(fresh);
      continue;
    }
    if (fresh.length === 0) continue;
    // Another notice of theirs already says it: that one told them.
    const elsewhere = SAID_ELSEWHERE[g.cause];
    if (elsewhere) {
      const said: Problem[] = [];
      for (const p of fresh) {
        const [other] = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.orgId, orgId),
              eq(notifications.userId, g.userId),
              elsewhere,
              gt(notifications.createdAt, p.since),
            ),
          )
          .limit(1);
        if (other) said.push(p);
      }
      await markTold(said);
      fresh = fresh.filter((p) => !said.includes(p));
      if (fresh.length === 0) continue;
    }
    const [today] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, g.userId),
          eq(notifications.kind, "team_watch"),
          gt(notifications.createdAt, new Date(now.getTime() - 24 * 3600_000)),
        ),
      );
    // Over the day's rows: it waits, untold, for a later look.
    if ((today?.n ?? 0) >= TEAM_WATCH_DAILY_ROWS) continue;
    const first = fresh[0] as Problem;
    const [made] = await notify(deps, {
      orgId,
      userIds: [g.userId],
      kind: "team_watch",
      groupKey: `team_watch:${g.cause}:${first.id}:${first.episode}`,
      // A budget about to end stops nothing yet: a plain row, which reaches no device.
      waiting: g.cause !== "budget_low",
      actor: { type: "agent", id: lodi.id },
      source,
      latest,
    });
    if (made && names.length > 1) await rewriteNotification(deps, made.id, { count: names.length, source, latest });
    await markTold(fresh);
  }
}

// ── Reminders ─────────────────────────────────────────────────────────────────

/**
 * One reminder a day for what a person left unread in "Esperando você" for hours (an approval, an agent's question, a
 * secret to give), in their own daytime: the oldest comes back on top and goes to their devices once, saying how many
 * still wait, and every one of them is marked reminded, so none is ever reminded twice. Approvals are left to the
 * digest of approvals for who has it on with enough of them waiting.
 */
async function remindUnread(deps: NotificationDeps, orgId: string, now: Date): Promise<number> {
  const { db } = deps;
  const at = sql`${now.toISOString()}::timestamptz`;
  const people = rowsOf<{ user_id: string; day: string; digest_off: boolean }>(
    await db.execute(sql`with ${knownZonesSql}
      select distinct n.user_id, to_char(${localClock(at)}, 'YYYY-MM-DD') as day,
        ${lodiPrefsSql.digestOff} as digest_off
      from notifications n
      join organization_members m on m.org_id = n.org_id and m.user_id = n.user_id
      left join organization_settings s on s.org_id = n.org_id
      where n.org_id = ${orgId} and ${unreadAsk(at)} and ${daytime(at)}`),
  );
  let reminded = 0;
  for (const p of people) {
    const mine = and(inboxVisible(orgId, p.user_id, now), eq(notifications.waiting, true));
    let rows = await db
      .select({ id: notifications.id, kind: notifications.kind, groupKey: notifications.groupKey })
      .from(notifications)
      .where(
        and(
          mine,
          isNull(notifications.readAt),
          inArray(notifications.kind, REMINDED_KINDS),
          lt(notifications.createdAt, new Date(now.getTime() - UNANSWERED_MS)),
          sql`${notifications.latest}->>'reminder' is null`,
        ),
      )
      .orderBy(notifications.createdAt);
    // Marked as reminded with no push: the digest's, and all but the one the reminder brings back.
    const quiet: string[] = [];
    if (liveLodiSwitches().includes("digest") && !p.digest_off) {
      const [pending] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(mine, eq(notifications.kind, "approval")));
      if ((pending?.n ?? 0) >= DIGEST_FROM) {
        quiet.push(...rows.filter((r) => r.kind === "approval").map((r) => r.id));
        rows = rows.filter((r) => r.kind !== "approval");
      }
    }
    const first = rows[0];
    const once = first ? await saidOnce(db, orgId, `team_watch.remind:${p.user_id}:${p.day}`) : false;
    if (once) quiet.push(...rows.slice(1).map((r) => r.id));
    if (quiet.length)
      await db
        .update(notifications)
        .set({ latest: sql`${notifications.latest} || '{"reminder": true}'::jsonb` })
        .where(inArray(notifications.id, quiet));
    if (!first || !once) continue;
    reminded += await remindNotifications(
      deps,
      orgId,
      first.groupKey,
      { reminder: true, still: rows.length },
      `team_watch:${p.day}`,
      [p.user_id],
    );
  }
  return reminded;
}

export const teamWatchLane = defineLodiLane({
  switch: "teamWatch",
  live: true,
  jobs: { [TEAM_WATCH_JOB]: (deps, orgId) => runTeamWatch(deps, orgId) },
  sweep: enqueueTeamWatches,
});
