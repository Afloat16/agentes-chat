import {
  and,
  arrayOverlaps,
  asc,
  count,
  type Database,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  or,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { z } from "zod";
import { audienceSql } from "./audience";
import { decodeCursor, encodeCursor } from "./cursor";
import { ValidationError } from "./errors";
import { cutText, stringsOf } from "./format";
import { PLATFORM_CAP } from "./limits";
import { machineOnline } from "./machines";
import { type Message, parseMentionHandles, receiptsFor } from "./messages";
import { jobOf, jobsOfRun, OPERATOR_JOB_ERROR_MAX, selectJobs, spentColumns, spentOf } from "./operator-jobs";
import { CODE, codeOf, errorText, ms, orgExists, type PageQuery, pageOf, UuidCursor, uuidOf } from "./operator-paging";
import { rightHandReaches } from "./right-hand";
import {
  computerWaitSql,
  KEPT_ON_HOLD,
  NO_AI,
  outageParkedSql,
  passedSql,
  type RunStatus,
  runErrorDetail,
  usageWaitSql,
} from "./runs";
import { type BillingHold, isBillingHold, workRefusal } from "./standing";
import { monthStartUtc, orgDefaultAgentBudget } from "./usage";

/**
 * Runs and conversations for the operator API (ADR 0056): what an agent's run did and why a message did or did not
 * start one. Ids, codes, times and sizes: never what a message says, what a tool was given or answered, a prompt or
 * a transcript. Every field is picked by name, and nothing here writes, because a caller holding only the read
 * token reaches all of it.
 */

const {
  agentBudgetPeriods,
  agentQuestions,
  agentRuns,
  agentRunSteps,
  agents,
  approvals,
  channelMembers,
  channels,
  machines,
  messages,
  organizationMembers,
  organizations,
  outbox,
  routingDecisions,
  secretRequests,
  usageRecords,
} = schema;

/** How much of a run's stored error an answer carries. */
export const OPERATOR_RUN_ERROR_MAX = 500;

/** A time a JSON column holds, when it is one (`codeOf`, `uuidOf`: the same rule). */
function timeOf(v: unknown) {
  const at = typeof v === "string" ? new Date(v) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}
/** A JSON array of names computed in SQL: some drivers hand it over as text. */
const namesOf = (v: unknown) => stringsOf(typeof v === "string" ? JSON.parse(v) : v).filter((k) => CODE.test(k));

// In a select list over one table drizzle writes columns without their table, so in a subquery a bare
// "id" would be the subquery's own: the outer row is named in full.
const RUN_ID = sql.raw(`"agent_runs"."id"`);
const AGENT_ID = sql.raw(`"agents"."id"`);

// ── Runs ─────────────────────────────────────────────────────────────────────

/** A run's status as people read it: what it waits for, or that it ended without a reply. */
export const OPERATOR_RUN_SHOWN = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "waiting_computer",
  "waiting_line",
  "waiting_plan",
  "waiting_budget",
  "waiting_outage",
  "done",
  "no_reply",
  "failed",
  "canceled",
] as const;

const shown = sql<(typeof OPERATOR_RUN_SHOWN)[number]>`(case when ${passedSql} then 'no_reply'
  when ${computerWaitSql} = 'line' then 'waiting_line'
  when ${computerWaitSql} is not null then 'waiting_computer'
  when ${usageWaitSql} = 'budget' then 'waiting_budget'
  when ${usageWaitSql} is not null then 'waiting_plan'
  when ${outageParkedSql} then 'waiting_outage'
  else ${agentRuns.status}::text end)`;

const WAIT = sql`${agentRuns.transcript}->'waitingForBrain'`;

const runColumns = {
  id: agentRuns.id,
  orgId: agentRuns.orgId,
  agentId: agentRuns.agentId,
  channelId: agentRuns.channelId,
  threadRootId: agentRuns.threadRootId,
  triggerMessageId: agentRuns.triggerMessageId,
  replyMessageId: agentRuns.replyMessageId,
  trigger: agentRuns.trigger,
  hop: agentRuns.hop,
  background: agentRuns.background,
  brain: agentRuns.brain,
  model: sql<string | null>`(select s.data->>'model' from ${agentRunSteps} s
    where s.run_id = ${RUN_ID} and s.kind = 'model_call' order by s.seq desc limit 1)`,
  turns: agentRuns.turns,
  status: agentRuns.status,
  shown,
  waitCode: sql<string | null>`coalesce(${WAIT}->>'code', case when ${outageParkedSql} then 'provider_outage' end)`,
  waitSource: sql<string | null>`${WAIT}->>'source'`,
  waitResetsAt: sql<string | null>`${WAIT}->>'resetsAt'`,
  waitingMachineId: agentRuns.waitingMachineId,
  error: agentRuns.error,
  createdAt: ms(agentRuns.createdAt),
  startedAt: agentRuns.startedAt,
  finishedAt: agentRuns.finishedAt,
  heartbeatAt: agentRuns.heartbeatAt,
};

const selectRuns = (db: Database) => db.select(runColumns).from(agentRuns);
type RunRow = Awaited<ReturnType<typeof selectRuns>>[number];

/**
 * The first `limit` runs matching `where`, oldest or newest first. Their ids are found first: a run's row is worked
 * out from its stored transcript (what it waits for), and a sort computes the columns of every row it is given before
 * it keeps a page of them. A transcript is the run's whole conversation: only the page's are read.
 */
async function runsInOrder(db: Database, where: SQL | undefined, order: typeof asc, limit: number) {
  const page = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(where)
    .orderBy(order(runColumns.createdAt), order(agentRuns.id))
    .limit(limit);
  if (page.length === 0) return [];
  const rows = await selectRuns(db).where(
    inArray(
      agentRuns.id,
      page.map((r) => r.id),
    ),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return page.flatMap(({ id }) => byId.get(id) ?? []);
}

const errorCodeOf = (error: string | null) => runErrorDetail(error)?.errorCode ?? null;

function runOf({ error, model, waitCode, waitSource, waitResetsAt, ...run }: RunRow) {
  return {
    ...run,
    model: codeOf(model),
    waitCode: codeOf(waitCode),
    waitSource: codeOf(waitSource),
    waitResetsAt: timeOf(waitResetsAt),
    errorCode: errorCodeOf(error),
    error: errorText(error, OPERATOR_RUN_ERROR_MAX),
  };
}

export type OperatorRun = ReturnType<typeof runOf>;

interface RunFilters {
  agentId?: string;
  channelId?: string;
  threadRootId?: string;
  /** As stored. */
  status?: RunStatus;
  /** Created at or after. */
  from?: Date;
  /** Created before. */
  to?: Date;
}

export interface OperatorRunQuery extends RunFilters, PageQuery {
  /** The app's code of the stored error (`run.no_ai`, `run.provider_rate_limit`…), as each row says it. */
  errorCode?: string;
}

const runsIn = (orgId: string, q: RunFilters) =>
  and(
    eq(agentRuns.orgId, orgId),
    q.agentId ? eq(agentRuns.agentId, q.agentId) : undefined,
    q.channelId ? eq(agentRuns.channelId, q.channelId) : undefined,
    q.threadRootId ? eq(agentRuns.threadRootId, q.threadRootId) : undefined,
    q.status ? eq(agentRuns.status, q.status) : undefined,
    q.from ? gte(agentRuns.createdAt, q.from) : undefined,
    q.to ? lt(agentRuns.createdAt, q.to) : undefined,
  );

/** How many different stored errors a count by error reads, most frequent first. */
export const OPERATOR_RUN_ERROR_TEXTS = 2000;

/**
 * The stored errors of the runs matching `where`, with how many runs hold each. A run's code is worked out from its
 * text in code (`runErrorDetail`), so counting and filtering by code both start from the distinct texts.
 */
async function errorTexts(db: Database, where: SQL | undefined) {
  const rows = await db
    .select({
      error: sql<string>`${agentRuns.error}`,
      runs: count(),
      firstAt: sql<Date>`min(${agentRuns.createdAt})`.mapWith((v: string | Date) => new Date(v)),
      lastAt: sql<Date>`max(${agentRuns.createdAt})`.mapWith((v: string | Date) => new Date(v)),
    })
    .from(agentRuns)
    .where(and(where, isNotNull(agentRuns.error)))
    .groupBy(agentRuns.error)
    .orderBy(desc(count()), asc(agentRuns.error))
    .limit(OPERATOR_RUN_ERROR_TEXTS + 1);
  return { texts: rows.slice(0, OPERATOR_RUN_ERROR_TEXTS), more: rows.length > OPERATOR_RUN_ERROR_TEXTS };
}

/**
 * A workspace's runs, newest first, in keyset pages: each with its status as stored and as people read it, what it
 * waits for, and its error as a code and its first characters. Null: no such workspace.
 */
export async function operatorRuns(db: Database, orgId: string, query: OperatorRunQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  if (!(await orgExists(db, orgId))) return null;
  const where = runsIn(orgId, query);
  let errors: string[] | null = null;
  if (query.errorCode) {
    // ponytail: past OPERATOR_RUN_ERROR_TEXTS different texts in the range the rarest are missed; a stored code
    // column on the run would make this one indexed filter.
    const found = await errorTexts(db, where);
    errors = found.texts.filter((e) => errorCodeOf(e.error) === query.errorCode).map((e) => e.error);
    if (errors.length === 0) return { runs: [], next: null };
  }
  const rows = await runsInOrder(
    db,
    and(
      where,
      errors ? inArray(agentRuns.error, errors) : undefined,
      after
        ? sql`(${runColumns.createdAt}, ${agentRuns.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
        : undefined,
    ),
    desc,
    query.limit + 1,
  );
  const page = pageOf(rows, query.limit, (r) => [r.createdAt, r.id]);
  return { runs: page.items.map(runOf), next: page.next };
}

/** How far back a count by error looks when no start is given. */
export const OPERATOR_RUN_ERRORS_DAYS = 7;

/**
 * How many of a workspace's runs ended with each error code in a range of dates, most frequent first, with the first
 * and the last time each was seen. Null: no such workspace.
 */
export async function operatorRunErrors(db: Database, orgId: string, query: RunFilters & { errorCode?: string }) {
  if (!(await orgExists(db, orgId))) return null;
  const to = query.to ?? new Date();
  const from = query.from ?? new Date(to.getTime() - OPERATOR_RUN_ERRORS_DAYS * 86_400_000);
  const { texts, more } = await errorTexts(db, runsIn(orgId, { ...query, from, to }));
  const byCode = new Map<string, { errorCode: string; runs: number; firstAt: Date; lastAt: Date }>();
  for (const e of texts) {
    const errorCode = errorCodeOf(e.error);
    if (!errorCode || (query.errorCode && errorCode !== query.errorCode)) continue;
    const seen = byCode.get(errorCode);
    if (!seen) byCode.set(errorCode, { errorCode, runs: e.runs, firstAt: e.firstAt, lastAt: e.lastAt });
    else {
      seen.runs += e.runs;
      if (e.firstAt < seen.firstAt) seen.firstAt = e.firstAt;
      if (e.lastAt > seen.lastAt) seen.lastAt = e.lastAt;
    }
  }
  const errors = [...byCode.values()].sort((a, b) => b.runs - a.runs || a.errorCode.localeCompare(b.errorCode));
  return { from, to, errors, more };
}

// ── What an agent asked of people ────────────────────────────────────────────

/** Every table an agent's ask to a person lives in has these columns. */
type AskTable = typeof approvals | typeof agentQuestions | typeof secretRequests;

/**
 * Approvals, questions and requests for a secret matching `where`, at most `limit` of each, oldest first: what kind,
 * its state and its times. Never an approval's title or parameters, a question's text or answer, nor what a secret
 * is for.
 */
async function asksWhere(db: Database, where: (t: AskTable, at: SQL<Date>) => SQL | undefined, limit: number) {
  const approvalAt = ms(approvals.createdAt);
  const questionAt = ms(agentQuestions.createdAt);
  const secretAt = ms(secretRequests.createdAt);
  const [asked, questions, secrets] = await Promise.all([
    db
      .select({
        id: approvals.id,
        runId: approvals.runId,
        agentId: approvals.agentId,
        threadRootId: sql<string | null>`${approvals.threadRootId}`,
        tool: sql<string | null>`${approvals.tool}`,
        status: sql<string>`${approvals.status}::text`,
        createdAt: approvalAt,
        expiresAt: approvals.expiresAt,
        resolvedAt: approvals.decidedAt,
        byUserId: approvals.decidedByUserId,
      })
      .from(approvals)
      .where(where(approvals, approvalAt))
      .orderBy(asc(approvalAt), asc(approvals.id))
      .limit(limit),
    db
      .select({
        id: agentQuestions.id,
        runId: sql<string | null>`${agentQuestions.runId}`,
        agentId: agentQuestions.agentId,
        threadRootId: agentQuestions.threadId,
        tool: sql<string | null>`null`,
        status: sql<string>`${agentQuestions.status}::text`,
        createdAt: questionAt,
        expiresAt: agentQuestions.expiresAt,
        resolvedAt: agentQuestions.answeredAt,
        byUserId: agentQuestions.answeredByUserId,
      })
      .from(agentQuestions)
      .where(where(agentQuestions, questionAt))
      .orderBy(asc(questionAt), asc(agentQuestions.id))
      .limit(limit),
    db
      .select({
        id: secretRequests.id,
        runId: sql<string | null>`${secretRequests.runId}`,
        agentId: secretRequests.agentId,
        threadRootId: secretRequests.threadId,
        tool: sql<string | null>`null`,
        status: sql<string>`${secretRequests.status}::text`,
        createdAt: secretAt,
        expiresAt: secretRequests.expiresAt,
        resolvedAt: secretRequests.deliveredAt,
        byUserId: sql<string | null>`null`,
      })
      .from(secretRequests)
      .where(where(secretRequests, secretAt))
      .orderBy(asc(secretAt), asc(secretRequests.id))
      .limit(limit),
  ]);
  return [
    ...asked.map((a) => ({ kind: "approval" as const, ...a, tool: codeOf(a.tool) })),
    ...questions.map((q) => ({ kind: "question" as const, ...q })),
    ...secrets.map((r) => ({ kind: "secret" as const, ...r })),
  ];
}

/** Oldest first, then by id the way the database orders them. */
const inOrder = (a: [Date, string], b: [Date, string]) =>
  a[0].getTime() - b[0].getTime() || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

// ── One run ──────────────────────────────────────────────────────────────────

/** How many of a run's jobs, and of each kind of ask, its trace lists. */
export const OPERATOR_TRACE_JOBS = 100;
export const OPERATOR_TRACE_ASKS = 100;

const DATA = agentRunSteps.data;
const KIND = agentRunSteps.kind;

// Each fact is read only from the kind of step that writes it: on another kind the same name may hold text.
const stepColumns = {
  seq: agentRunSteps.seq,
  kind: KIND,
  at: agentRunSteps.createdAt,
  toolUseId: sql<string | null>`case when ${KIND} in ('tool_call', 'tool_result') then ${DATA}->>'toolUseId' end`,
  tool: sql<string | null>`case when ${KIND} in ('tool_call', 'tool_result') then ${DATA}->>'name' end`,
  connector: sql<string | null>`case when ${KIND} = 'tool_call' then ${DATA}->>'connector' end`,
  isError: sql<
    boolean | null
  >`case when ${KIND} = 'tool_result' then coalesce(${DATA}->'isError' = 'true'::jsonb, false) end`,
  refusal: sql<string | null>`case when ${KIND} = 'tool_result' then ${DATA}->'data'->>'refusal' end`,
  code: sql<string | null>`case when ${KIND} = 'error' then ${DATA}->>'code'
    when ${KIND} = 'tool_result' then ${DATA}->'data'->>'code' end`,
  reason: sql<string | null>`case when ${KIND} = 'error' then ${DATA}->>'reason' end`,
  model: sql<string | null>`case when ${KIND} = 'model_call' then ${DATA}->>'model' end`,
  stopReason: sql<string | null>`case when ${KIND} = 'model_call' then ${DATA}->>'stopReason' end`,
  // Sizes are measured in the database: the text itself is never read out.
  chars: sql<number | null>`case when ${KIND} = 'tool_call' then length(${DATA}->>'input')
    when ${KIND} = 'tool_result' then length(${DATA}->>'content') end`.mapWith(Number),
  messageId: sql<string | null>`case when ${KIND} = 'message' then ${DATA}->>'messageId' end`,
  records: sql<string[] | null>`case when ${KIND} = 'context'
    then (select jsonb_agg(k) from jsonb_object_keys(${DATA}) k) end`.mapWith(namesOf),
};

/**
 * One run, start to end: its row, its steps in order (which tool, whether it failed, how big its input and its
 * result were, never either of them), what it asked of people, the jobs that started and woke it, what it spent and
 * the computer it is tied to. `beforeSeq` pages back from the end, `limit` steps at a time. Null: no such run.
 */
export async function operatorRunTrace(db: Database, runId: string, query: { limit: number; beforeSeq?: number }) {
  const [run] = await selectRuns(db).where(eq(agentRuns.id, runId));
  if (!run) return null;
  // No index is on the run: the agent's rows since it began are (org, agent, created_at).
  const spent = and(
    eq(usageRecords.orgId, run.orgId),
    eq(usageRecords.agentId, run.agentId),
    gte(usageRecords.createdAt, run.createdAt),
    eq(usageRecords.runId, runId),
  );
  const [steps, counted, asks, jobs, usage, ranOn, agent] = await Promise.all([
    db
      .select(stepColumns)
      .from(agentRunSteps)
      .where(and(eq(agentRunSteps.runId, runId), query.beforeSeq ? lt(agentRunSteps.seq, query.beforeSeq) : undefined))
      .orderBy(desc(agentRunSteps.seq))
      .limit(query.limit),
    db.select({ steps: count() }).from(agentRunSteps).where(eq(agentRunSteps.runId, runId)),
    asksWhere(db, (t) => sql`${t.runId} = ${runId}::uuid`, OPERATOR_TRACE_ASKS),
    selectJobs(db)
      .where(jobsOfRun(runId))
      .orderBy(desc(outbox.createdAt), desc(outbox.id))
      .limit(OPERATOR_TRACE_JOBS + 1),
    db
      .select({
        provider: usageRecords.provider,
        model: usageRecords.model,
        billedTo: usageRecords.billedTo,
        ...spentColumns,
      })
      .from(usageRecords)
      .where(spent)
      .groupBy(usageRecords.provider, usageRecords.model, usageRecords.billedTo)
      .orderBy(asc(usageRecords.provider), asc(usageRecords.model), asc(usageRecords.billedTo))
      .limit(50),
    db
      .select({ machineId: usageRecords.machineId })
      .from(usageRecords)
      .where(and(spent, isNotNull(usageRecords.machineId)))
      .orderBy(desc(usageRecords.createdAt))
      .limit(1),
    db.select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, run.agentId)),
  ]);

  // The run's row doesn't say where it ran: the computer it waits for, else the one its plan's usage names,
  // else its agent's now.
  const tied = run.waitingMachineId
    ? { from: "waiting" as const, id: run.waitingMachineId }
    : ranOn[0]?.machineId
      ? { from: "usage" as const, id: ranOn[0].machineId }
      : agent[0]?.machineId
        ? { from: "agent" as const, id: agent[0].machineId }
        : null;
  const [computer] = tied
    ? await db
        .select({
          id: machines.id,
          name: machines.name,
          kind: machines.kind,
          online: machines.online,
          lastSeenAt: machines.lastSeenAt,
          deletedAt: machines.deletedAt,
        })
        .from(machines)
        .where(and(eq(machines.orgId, run.orgId), eq(machines.id, tied.id)))
    : [];

  const called = new Map<string, Date>();
  const trail = steps.reverse().map(({ toolUseId, ...s }) => {
    if (s.kind === "tool_call" && toolUseId) called.set(toolUseId, s.at);
    const since = s.kind === "tool_result" && toolUseId ? called.get(toolUseId) : undefined;
    return {
      ...s,
      tool: codeOf(s.tool),
      connector: s.connector ? cutText(s.connector, 100) : null,
      refusal: codeOf(s.refusal),
      code: codeOf(s.code),
      reason: codeOf(s.reason),
      model: codeOf(s.model),
      stopReason: codeOf(s.stopReason),
      durationMs: since ? s.at.getTime() - since.getTime() : null,
      messageId: uuidOf(s.messageId),
      records: s.records ?? [],
    };
  });
  const sumOf = (field: keyof typeof spentColumns) => usage.reduce((n, u) => n + u[field], 0);
  return {
    run: runOf(run),
    steps: trail,
    stepCount: counted[0]?.steps ?? 0,
    asks: asks.sort((a, b) => inOrder([a.createdAt, a.id], [b.createdAt, b.id])),
    jobs: jobs.slice(0, OPERATOR_TRACE_JOBS).map(jobOf),
    moreJobs: jobs.length > OPERATOR_TRACE_JOBS,
    usage: {
      ...spentOf({
        calls: sumOf("calls"),
        input: sumOf("input"),
        output: sumOf("output"),
        cacheRead: sumOf("cacheRead"),
        cacheWrite: sumOf("cacheWrite"),
        costNanoUsd: sumOf("costNanoUsd"),
      }),
      byModel: usage.map(spentOf),
    },
    machine:
      tied && computer
        ? {
            id: computer.id,
            name: computer.name,
            kind: computer.kind,
            online: machineOnline(computer),
            lastSeenAt: computer.lastSeenAt,
            from: tied.from,
          }
        : null,
  };
}

// ── A conversation's timeline ────────────────────────────────────────────────

// A message's `meta` is written by the server alone: the names of what it holds say what kind of message it is.
const flagsOf = (meta: Record<string, unknown>) => Object.keys(meta).filter((k) => CODE.test(k));

/** Never `body`: how long it is. */
const messageColumns = {
  id: messages.id,
  at: ms(messages.createdAt),
  threadRootId: messages.threadId,
  authorType: messages.authorType,
  authorUserId: messages.authorUserId,
  authorAgentId: messages.authorAgentId,
  runId: messages.agentRunId,
  hop: messages.hop,
  length: sql<number>`char_length(${messages.body})`.mapWith(Number),
  mentionedAgentIds: messages.mentionedAgentIds,
  mentionedUserIds: messages.mentionedUserIds,
  flags: sql<string[]>`(select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(${messages.meta}) k)`.mapWith(
    namesOf,
  ),
  edited: sql<boolean>`${messages.editedAt} is not null`,
  deleted: sql<boolean>`${messages.deletedAt} is not null`,
};

/**
 * What the router's own code says of a pick, before any step's words: a decision's `reason` starts with these, then
 * holds what a model said about the message, which is never returned.
 */
const ROUTING_MARKERS: ReadonlySet<string> = new Set([
  "follow-up",
  "alone",
  "default",
  "coordinator",
  "talking to",
  "best",
  "last talked to",
  "already answered by another agent",
  "for people",
  "held back",
  "every mentioned agent acts",
]);

function routingMarkers(reason: string | null) {
  const markers: string[] = [];
  for (const part of reason?.split("; ") ?? []) {
    if (!ROUTING_MARKERS.has(part) && !/^referenced only: \d+$/.test(part)) break;
    markers.push(part);
  }
  return markers;
}

const routingColumns = {
  id: routingDecisions.id,
  messageId: routingDecisions.messageId,
  at: ms(routingDecisions.createdAt),
  strategy: routingDecisions.strategy,
  candidates: routingDecisions.candidates,
  needsAgentScore: routingDecisions.needsAgentScore,
  selectedAgentIds: routingDecisions.selectedAgentIds,
  reason: routingDecisions.reason,
  error: routingDecisions.error,
};

const selectRouting = (db: Database) => db.select(routingColumns).from(routingDecisions);
type RoutingRow = Awaited<ReturnType<typeof selectRouting>>[number];

function routingOf({ reason, error, candidates, strategy, ...decision }: RoutingRow) {
  return {
    ...decision,
    strategy: cutText(strategy, 100),
    candidates: candidates.flatMap((c) =>
      uuidOf(c?.agentId) && typeof c.score === "number" ? [{ agentId: c.agentId, score: c.score }] : [],
    ),
    reasonCodes: routingMarkers(reason),
    error: errorText(error, OPERATOR_JOB_ERROR_MAX),
  };
}

/** The longest stretch of a conversation one timeline covers, and how far around a message it looks by default. */
const TIMELINE_MAX_MS = 48 * 3600_000;
const TIMELINE_AROUND_MS = 3 * 3600_000;

export interface OperatorTimelineQuery extends PageQuery {
  /** The conversation; or `messageId`, never both. */
  channelId?: string;
  /** A message: its conversation, around when it was written. */
  messageId?: string;
  from?: Date;
  to?: Date;
}

// A message and the runs it starts are written by one statement, at one instant: at the same time a cause comes
// before what it caused, whatever their ids.
const TIMELINE_ORDER = { message: 0, routing: 1, run: 2, ask: 3 } as const;
/** A page of a timeline ends at this key: `[at (ms), its type's place, id]`. */
const TimelineCursor = z.tuple([z.iso.datetime(), z.number().int().min(0).max(3), z.uuid()]);

/**
 * What happened in one conversation, oldest first, in keyset pages: its messages (who wrote each, how long it is,
 * whom it mentions, never what it says), the routing decisions, the runs started and what agents asked of people.
 * The window is `from` to `to`: by default the 6 hours up to now, or the 3 hours before and after `messageId`.
 * Null: no such workspace, conversation or message.
 */
export async function operatorTimeline(db: Database, orgId: string, query: OperatorTimelineQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, TimelineCursor) : null;
  if (Boolean(query.channelId) === Boolean(query.messageId))
    throw new ValidationError("One of channelId and messageId is required");
  let around: Date | null = null;
  let channelId = query.channelId;
  if (query.messageId) {
    const [message] = await db
      .select({ channelId: messages.channelId, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, query.messageId)));
    if (!message) return null;
    around = message.createdAt;
    channelId = message.channelId;
  }
  if (!channelId) return null;
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, channelId)));
  if (!channel) return null;

  const to = query.to ?? new Date((around ?? new Date()).getTime() + (around ? TIMELINE_AROUND_MS : 0));
  const from = query.from ?? new Date((around ?? to).getTime() - (around ? 1 : 2) * TIMELINE_AROUND_MS);
  if (from >= to) throw new ValidationError("from must be before to");
  if (to.getTime() - from.getTime() > TIMELINE_MAX_MS)
    throw new ValidationError("from and to are 48 hours apart at most");

  // The range is on the stored time itself, never on an expression of it: `messages` is partitioned by it.
  type Rows = { orgId: unknown; channelId: unknown; createdAt: unknown; id: unknown };
  const within = (type: keyof typeof TIMELINE_ORDER) => (t: Rows, at: SQL<Date>) => {
    const place = TIMELINE_ORDER[type];
    const past = !after
      ? undefined
      : place === after[1]
        ? sql`(${at}, ${t.id}) > (${after[0]}::timestamptz, ${after[2]}::uuid)`
        : place > after[1]
          ? sql`${at} >= ${after[0]}::timestamptz`
          : sql`${at} > ${after[0]}::timestamptz`;
    return and(
      sql`${t.orgId} = ${orgId}::uuid`,
      sql`${t.channelId} = ${channelId}::uuid`,
      sql`${t.createdAt} >= ${from.toISOString()}::timestamptz`,
      sql`${t.createdAt} < ${to.toISOString()}::timestamptz`,
      past,
    );
  };
  const more = query.limit + 1;
  const [written, decisions, runs, asks] = await Promise.all([
    db
      .select(messageColumns)
      .from(messages)
      .where(within("message")(messages, messageColumns.at))
      .orderBy(asc(messageColumns.at), asc(messages.id))
      .limit(more),
    selectRouting(db)
      .where(within("routing")(routingDecisions, routingColumns.at))
      .orderBy(asc(routingColumns.at), asc(routingDecisions.id))
      .limit(more),
    runsInOrder(db, within("run")(agentRuns, runColumns.createdAt), asc, more),
    asksWhere(db, within("ask"), more),
  ]);
  const events = [
    ...written.map((m) => ({ type: "message" as const, ...m })),
    ...decisions.map((d) => ({ type: "routing" as const, ...routingOf(d) })),
    ...runs.map((r) => ({ type: "run" as const, at: r.createdAt, ...runOf(r) })),
    ...asks.map((a) => ({ type: "ask" as const, at: a.createdAt, ...a })),
  ].sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      TIMELINE_ORDER[a.type] - TIMELINE_ORDER[b.type] ||
      inOrder([a.at, a.id], [b.at, b.id]),
  );
  const page = events.slice(0, query.limit);
  const last = page.at(-1);
  const next =
    events.length > query.limit && last
      ? encodeCursor([last.at.toISOString(), TIMELINE_ORDER[last.type], last.id])
      : null;
  return { channelId, from, to, events: page, next };
}

// ── Why a message did or did not start a run ─────────────────────────────────

/** How many agents an explanation lists: the ones the message concerns first, then the conversation's others. */
export const OPERATOR_EXPLAIN_AGENTS = 50;

export const OPERATOR_EXPLAIN_VERDICTS = [
  "run",
  "joined",
  "answered_question",
  "mission_suggestion",
  "kept_on_hold",
  "no_ai",
  "platform_cap",
  "blocked",
  "referenced_only",
  "nobody_picked",
  "picked_not_started",
  "job_pending",
  "job_failed",
  "not_routed",
] as const;

export const OPERATOR_EXPLAIN_SKIPS = [
  "workspace_deleting",
  "workspace_paused",
  "never_queued",
  "direct_conversation",
  "hop_limit",
  "no_candidates",
  "unknown",
] as const;

/**
 * Why a message did or did not start a run, from what is stored: the runs it started, joined or resumed, the
 * routing decision, the agents it names and the job that routes it. What isn't stored is worked out as things are
 * now and kept apart (`now`, `skipped`): each agent's state in the conversation, whether its author may talk to it,
 * the workspace's standing. `maxHops`: the server's hop limit. Null: no such message.
 */
export async function operatorExplainMessage(db: Database, messageId: string, options: { maxHops: number }) {
  // Every partition's primary key: a message can be stored at another time than its id says.
  const [message]: Message[] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message) return null;
  const { orgId, channelId, meta } = message;
  const person = message.authorType === "person" ? message.authorUserId : null;
  const typed = parseMentionHandles(message.body);
  const [receipts, taken, decisions, channel, workspace, posted, namedAgents, namedPeople, budget] = await Promise.all([
    receiptsFor(db, orgId, [message]),
    // A run already at work that took it, whoever sent it there (the router, an agent's mention): it still waits in
    // the run's inbox, or a step says the run read it. Only the insert's own steering is on the message.
    selectRuns(db)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.channelId, channelId),
          gte(agentRuns.createdAt, new Date(message.createdAt.getTime() - 86_400_000)),
          lt(agentRuns.createdAt, message.createdAt),
          sql`(${messageId}::uuid = any(${agentRuns.pendingMessageIds}) or exists (
            select 1 from ${agentRunSteps} s where s.run_id = ${RUN_ID} and s.kind = 'context'
              and s.data->'steeredMessageIds' @> ${JSON.stringify([messageId])}::jsonb))`,
        ),
      )
      .limit(OPERATOR_EXPLAIN_AGENTS),
    selectRouting(db).where(eq(routingDecisions.messageId, messageId)),
    db.select({ kind: channels.kind }).from(channels).where(eq(channels.id, channelId)),
    db
      .select({
        state: organizations.standing,
        reason: organizations.standingReason,
        notice: organizations.standingNotice,
        deletionDueAt: organizations.deletionDueAt,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId)),
    selectJobs(db).where(eq(outbox.dedupeKey, `message.posted:${messageId}`)),
    typed.length === 0
      ? []
      : db
          .select({ id: agents.id, handle: agents.handle, previousHandles: agents.previousHandles })
          .from(agents)
          .where(
            and(
              eq(agents.orgId, orgId),
              or(inArray(agents.handle, typed), arrayOverlaps(agents.previousHandles, typed)),
            ),
          )
          .limit(OPERATOR_EXPLAIN_AGENTS),
    typed.length === 0
      ? []
      : db
          .select({ userId: organizationMembers.userId, handle: organizationMembers.handle })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.handle, typed)))
          .limit(OPERATOR_EXPLAIN_AGENTS),
    orgDefaultAgentBudget(db, orgId),
  ]);
  const receipt = receipts.get(messageId);
  const handled = receipt?.handled ?? [];
  const routing = decisions[0] ? routingOf(decisions[0]) : null;
  const known = new Set([
    ...namedAgents.flatMap((a) => [a.handle, ...a.previousHandles]),
    ...namedPeople.flatMap((p) => p.handle ?? []),
  ]);

  const concerned = [
    ...new Set([
      ...handled.map((h) => h.agentId),
      ...taken.map((r) => r.agentId),
      ...message.mentionedAgentIds,
      ...namedAgents.map((a) => a.id),
      ...(receipt?.seenBy ?? []),
    ]),
  ].slice(0, OPERATOR_EXPLAIN_AGENTS);
  const inConversation = sql`exists (select 1 from ${channelMembers} cm
    where cm.agent_id = ${AGENT_ID} and cm.channel_id = ${channelId}::uuid)`;
  const [listed, answering] = await Promise.all([
    db
      .select({
        agentId: agents.id,
        name: agents.name,
        handle: agents.handle,
        archived: sql<boolean>`${agents.archivedAt} is not null`,
        held: sql<boolean>`${agents.operatorHoldAt} is not null`,
        inChannel: sql<boolean>`(${inConversation} or ${rightHandReaches(sql`${agents}`, sql`${channelId}::uuid`)})`,
        autoReply: sql<boolean | null>`(select cm.auto_reply from ${channelMembers} cm
          where cm.agent_id = ${AGENT_ID} and cm.channel_id = ${channelId}::uuid limit 1)`,
        mayTalk: (person
          ? audienceSql("agents", sql`${person}::text`, { channelId: sql`${channelId}::uuid` })
          : sql`null`) as SQL<boolean | null>,
        // Every agent has a budget (`effectiveAgentBudget`): its own, else the workspace's default.
        overBudget: sql<boolean>`(coalesce((
          select bp.spent_nano_usd from ${agentBudgetPeriods} bp where bp.agent_id = ${AGENT_ID}
            and bp.period_start = ${monthStartUtc(new Date()).toISOString().slice(0, 10)}::date), 0)
          >= coalesce(${agents.monthlyBudgetNanoUsd}, ${budget}::bigint))`,
      })
      .from(agents)
      .where(
        and(eq(agents.orgId, orgId), or(concerned.length ? inArray(agents.id, concerned) : undefined, inConversation)),
      )
      .orderBy(
        concerned.length ? desc(sql`${agents.id} = any(${`{${concerned.join(",")}}`}::uuid[])`) : asc(agents.id),
        asc(agents.createdAt),
      )
      .limit(OPERATOR_EXPLAIN_AGENTS),
    handled.length === 0
      ? []
      : selectRuns(db).where(
          and(
            eq(agentRuns.orgId, orgId),
            inArray(
              agentRuns.id,
              handled.map((h) => h.runId),
            ),
          ),
        ),
  ]);

  const steered = new Set([...stringsOf(meta.steeredRunIds), ...taken.map((r) => r.id)]);
  const referenced = new Set(receipt?.referenced ?? []);
  const named = new Set(namedAgents.map((a) => a.id));
  const explained = listed.map(({ agentId, name, handle, ...now }) => {
    const row =
      answering.find((r) => r.id === handled.find((h) => h.agentId === agentId)?.runId) ??
      taken.find((r) => r.agentId === agentId);
    const run = row ? runOf(row) : null;
    return {
      agentId,
      name,
      handle,
      named: named.has(agentId),
      mentioned: message.mentionedAgentIds.includes(agentId),
      referenced: referenced.has(agentId),
      candidate: routing?.candidates.some((c) => c.agentId === agentId) ?? false,
      score: routing?.candidates.find((c) => c.agentId === agentId)?.score ?? null,
      selected: routing?.selectedAgentIds.includes(agentId) ?? false,
      outcome: !run
        ? ("none" as const)
        : run.triggerMessageId === messageId
          ? ("run" as const)
          : steered.has(run.id)
            ? ("joined" as const)
            : ("answered_question" as const),
      run,
      now,
    };
  });

  const standing = workspace[0];
  const billingHold =
    standing && !standing.deletionDueAt && isBillingHold(standing) ? (standing.reason as BillingHold) : null;
  const job = posted[0] ? jobOf(posted[0]) : null;
  const outcomes = new Set(explained.map((a) => a.outcome));
  const flags = flagsOf(meta);
  const verdict: (typeof OPERATOR_EXPLAIN_VERDICTS)[number] = outcomes.has("run")
    ? "run"
    : outcomes.has("joined")
      ? "joined"
      : outcomes.has("answered_question")
        ? "answered_question"
        : flags.includes("missionSuggestion")
          ? "mission_suggestion"
          : routing?.strategy === KEPT_ON_HOLD
            ? "kept_on_hold"
            : decisions[0]?.error === NO_AI
              ? "no_ai"
              : decisions[0]?.error === PLATFORM_CAP
                ? "platform_cap"
                : (receipt?.blocked.length ?? 0) > 0
                  ? "blocked"
                  : referenced.size > 0
                    ? "referenced_only"
                    : routing
                      ? routing.selectedAgentIds.length > 0
                        ? "picked_not_started"
                        : "nobody_picked"
                      : job?.status === "pending" || job?.status === "processing"
                        ? "job_pending"
                        : job?.status === "failed"
                          ? "job_failed"
                          : "not_routed";
  // The router's own exits store nothing: which of them the message would meet as things are now.
  const candidates = explained.filter(
    (a) => a.now.inChannel && a.now.autoReply && !a.now.archived && !a.now.held && a.now.mayTalk !== false,
  );
  const skipped: (typeof OPERATOR_EXPLAIN_SKIPS)[number] | null =
    verdict !== "not_routed"
      ? null
      : standing?.deletionDueAt
        ? "workspace_deleting"
        : // The router goes on in one case only: a person's message while the workspace waits for its first plan.
          workRefusal(standing) && !(billingHold === "payment" && message.authorType === "person")
          ? "workspace_paused"
          : !job
            ? "never_queued"
            : channel[0]?.kind === "dm"
              ? "direct_conversation"
              : message.hop >= options.maxHops
                ? "hop_limit"
                : person && candidates.length === 0
                  ? "no_candidates"
                  : "unknown";

  return {
    message: {
      id: message.id,
      orgId,
      channelId,
      channelKind: channel[0]?.kind ?? null,
      at: message.createdAt,
      threadRootId: message.threadId,
      authorType: message.authorType,
      authorUserId: message.authorUserId,
      authorAgentId: message.authorAgentId,
      runId: message.agentRunId,
      hop: message.hop,
      length: [...message.body].length,
      mentionedAgentIds: message.mentionedAgentIds,
      mentionedUserIds: message.mentionedUserIds,
      flags,
      edited: message.editedAt !== null,
      deleted: message.deletedAt !== null,
    },
    verdict,
    skipped,
    handles: {
      agentIds: namedAgents.map((a) => a.id),
      userIds: namedPeople.map((p) => p.userId),
      // How many, never which: a handle nobody here has is a word of the message.
      unknown: typed.filter((h) => !known.has(h)).length,
    },
    agents: explained,
    routing,
    workspace: {
      standing: standing?.state ?? "active",
      billingHold,
      deleting: Boolean(standing?.deletionDueAt),
    },
    postedJob: job,
  };
}
