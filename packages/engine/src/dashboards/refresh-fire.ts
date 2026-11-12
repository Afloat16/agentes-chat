import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNotNull, isNull, or, schema, sql } from "@agenteschat/db";
import type { ModelScope } from "../brains/select";
import type { Membership } from "../organizations";
import { waitModel } from "../task-manager";
import { mayContinuePause } from "../usage-pause";
import { dashboardRights, viewerOf } from "./access";
import { publishWidgetChanged, widgetEvent } from "./events";
import type { WidgetStatus, WidgetWaitView } from "./types";

const { agentRuns, agents, dashboards, dashboardWidgets, routineRuns, routines } = schema;

/*
 * A widget routine as it fires (ADR 0135 §4, ADR 0053 §6): its widget and board must still be there, and its creator
 * must still see the board; then the widget shows it is being redone, and what its run waits on, if anything. Kept
 * apart from `refresh.ts` so `routines.ts` and the executor read it without an import cycle.
 */

/** A widget's refresh run that waits, with what it waits on and who may let a pause go on (`mayContinueWidgetWait`). */
export interface WidgetRunWait extends WidgetWaitView {
  runId: string;
  waitId: string | null;
  orgId: string;
  triggerMessageId: string;
  ownerUserId: string | null;
  routineId: string;
  routineCreatorId: string | null;
}

const USAGE_CODES: readonly string[] = ["plan_limit", "budget", "usage_pause"];
const SCOPES: readonly string[] = ["model", "region", "off", "inactive"];

/**
 * What the open refresh runs of these widget routines wait on, by routine (none: at work, or not open). One query. The
 * head of a computer's line asking it for room (`running` with its computer kept) still waits for room.
 */
export async function widgetRunWaits(db: Executor, routineIds: readonly string[]): Promise<Map<string, WidgetRunWait>> {
  const out = new Map<string, WidgetRunWait>();
  if (routineIds.length === 0) return out;
  const wait = (field: string) =>
    sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>${sql.raw(`'${field}'`)}`;
  const rows = await db
    .select({
      routineId: routineRuns.routineId,
      routineCreatorId: routines.createdByUserId,
      runId: agentRuns.id,
      orgId: agentRuns.orgId,
      triggerMessageId: agentRuns.triggerMessageId,
      ownerUserId: agents.ownerUserId,
      status: agentRuns.status,
      machineId: agentRuns.waitingMachineId,
      code: wait("code"),
      source: wait("source"),
      resetsAt: wait("resetsAt"),
      waitId: wait("waitId"),
      scope: wait("scope"),
      plan: wait("plan"),
      model: wait("model"),
      roomSince: sql<string | null>`${agentRuns.transcript}->>'roomWaitSince'`,
      outageAt: sql<string | null>`${agentRuns.transcript}->'outage'->>'at'`,
    })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(
      and(
        inArray(routineRuns.routineId, [...routineIds]),
        isNull(routineRuns.finishedAt),
        or(
          eq(agentRuns.status, "waiting_input"),
          and(eq(agentRuns.status, "running"), isNotNull(agentRuns.waitingMachineId)),
        ),
      ),
    );
  const at = (ms: string | null) => (ms && Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null);
  for (const r of rows) {
    const usage = r.status === "waiting_input" && USAGE_CODES.includes(r.code ?? "");
    const scope = usage && r.code === "plan_limit" && SCOPES.includes(r.scope ?? "") ? (r.scope as ModelScope) : null;
    const base = { source: null, resetsAt: null, scope: null, model: null, since: null, canContinue: false };
    const view: WidgetWaitView | null = usage
      ? {
          ...base,
          code: r.code as "plan_limit" | "budget" | "usage_pause",
          source: r.code === "budget" || (r.code === "usage_pause" && r.source === "budget") ? "budget" : "plan",
          resetsAt: r.resetsAt,
          scope,
          model: scope ? waitModel({ scope, model: r.model, ...(r.plan ? { plan: r.plan } : {}) }) : null,
        }
      : r.machineId
        ? r.status === "running" || r.code === "busy"
          ? { ...base, code: "busy", since: at(r.roomSince) }
          : { ...base, code: "computer" }
        : !r.code && at(r.outageAt)
          ? { ...base, code: "outage", resetsAt: at(r.outageAt) }
          : null;
    if (view)
      out.set(r.routineId, {
        ...view,
        runId: r.runId,
        waitId: r.waitId,
        orgId: r.orgId,
        triggerMessageId: r.triggerMessageId,
        ownerUserId: r.ownerUserId,
        routineId: r.routineId,
        routineCreatorId: r.routineCreatorId,
      });
  }
  return out;
}

/** Whether `userId` may press Continue now on a widget's paused refresh: Continuar agora's people (`mayContinuePause`). */
export const mayContinueWidgetWait = (db: Executor, userId: string, membership: Membership, wait: WidgetRunWait) =>
  mayContinuePause(db, userId, membership, {
    run: { orgId: wait.orgId, triggerMessageId: wait.triggerMessageId },
    // A routine's run is asked by its brief, its creator's: `mayStopRun` reads that message itself.
    requester: null,
    ownerUserId: wait.ownerUserId,
    routineId: wait.routineId,
    routineCreatorId: wait.routineCreatorId,
  });

/**
 * A widget's refresh run started or stopped waiting (its plan, its budget, its computer, its AI provider): the widget's
 * viewers read it again, so it says what holds it, or that it updates. Any other background run: nothing.
 */
export async function widgetRunWaitChanged(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; background: boolean },
) {
  if (!run.background || !deps.pubsub) return;
  const [row] = await deps.db
    .select({ widget: dashboardWidgets, board: dashboards })
    .from(routineRuns)
    .innerJoin(dashboardWidgets, eq(dashboardWidgets.routineId, routineRuns.routineId))
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(and(eq(routineRuns.orgId, run.orgId), eq(routineRuns.agentRunId, run.id)));
  if (!row) return;
  await publishWidgetChanged(deps.pubsub, row.board, widgetEvent(row.widget, row.widget.status as WidgetStatus));
}

/** A person's change request, as the routine run carries it (`routine_runs.event`). */
export const WIDGET_CHANGE_EVENT = "widget.change";

/**
 * Whether a routine run is a person's ask on a widget ("Ask for a change"): like a manual run, it goes ahead while a
 * person keeps the widget's routine paused on purpose (ADR 0135 §6); only the schedule waits.
 */
export function isWidgetChangeRun(run: { event?: Record<string, unknown> | null }): boolean {
  return run.event?.type === WIDGET_CHANGE_EVENT;
}

export type WidgetFiring =
  | { widget: { widgetId: string; dashboardId: string } }
  /** The widget or its board is gone: the slot passes. */
  | { skip: "deleted" }
  /** Its creator no longer sees the board: the routine pauses, the widget says why. */
  | { pause: "creator_no_access" };

/** Whether a widget routine's slot runs, for its creator (`creatorId`, whose `membership` it is). */
export async function widgetFiring(
  db: Database,
  orgId: string,
  target: { widgetId: string; dashboardId: string },
  creatorId: string,
  membership: Membership,
): Promise<WidgetFiring> {
  const [row] = await db
    .select({ widgetId: dashboardWidgets.id, dashboardId: dashboardWidgets.dashboardId, board: dashboards })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(and(eq(dashboardWidgets.orgId, orgId), eq(dashboardWidgets.id, target.widgetId)));
  if (!row || row.board.deletedAt) return { skip: "deleted" };
  if (!dashboardRights(row.board, viewerOf(membership, creatorId)).see) return { pause: "creator_no_access" };
  return { widget: { widgetId: row.widgetId, dashboardId: row.dashboardId } };
}

/** The refresh starts: the widget is `updating` (its last data stays on screen), or `building` while it has none. */
export async function widgetRunStarting(deps: { db: Database; pubsub?: PubSub }, orgId: string, widgetId: string) {
  const [row] = await deps.db
    .update(dashboardWidgets)
    .set({
      status: sql`case when ${dashboardWidgets.spec} is null then 'building' else 'updating' end`,
      updatedAt: new Date(),
    })
    .where(and(eq(dashboardWidgets.orgId, orgId), eq(dashboardWidgets.id, widgetId)))
    .returning({
      id: dashboardWidgets.id,
      status: dashboardWidgets.status,
      dashboardId: dashboardWidgets.dashboardId,
      draft: dashboardWidgets.draft,
      createdByUserId: dashboardWidgets.createdByUserId,
    });
  if (!row) return;
  const [board] = await deps.db.select().from(dashboards).where(eq(dashboards.id, row.dashboardId));
  if (board) {
    await publishWidgetChanged(deps.pubsub, board, widgetEvent(row, row.status as WidgetStatus)).catch(() => {});
  }
}
