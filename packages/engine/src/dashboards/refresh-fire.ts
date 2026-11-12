import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import type { Membership } from "../organizations";
import { dashboardRights, viewerOf } from "./access";
import { publishWidgetChanged, widgetEvent } from "./events";
import type { WidgetStatus, WidgetWaitView } from "./types";

const { agentRuns, dashboards, dashboardWidgets, routineRuns } = schema;

/*
 * A widget routine as it fires (ADR 0135 §4, ADR 0053 §6): its widget and board must still be there, and its creator
 * must still see the board; then the widget shows it is being redone, and what its run waits on, if anything. Kept
 * apart from `refresh.ts` so `routines.ts` and the executor read it without an import cycle.
 */

/** A widget's refresh run that waits, with what it waits on. */
export interface WidgetRunWait extends WidgetWaitView {
  runId: string;
  waitId: string | null;
}

/** What the open refresh runs of these widget routines wait on, by routine (none: at work, or not open). One query. */
export async function widgetRunWaits(db: Executor, routineIds: readonly string[]): Promise<Map<string, WidgetRunWait>> {
  const out = new Map<string, WidgetRunWait>();
  if (routineIds.length === 0) return out;
  const rows = await db
    .select({
      routineId: routineRuns.routineId,
      runId: agentRuns.id,
      code: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'code'`,
      source: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'source'`,
      resetsAt: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'resetsAt'`,
      waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
      machineId: agentRuns.waitingMachineId,
    })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        inArray(routineRuns.routineId, [...routineIds]),
        isNull(routineRuns.finishedAt),
        eq(agentRuns.status, "waiting_input"),
      ),
    );
  for (const r of rows) {
    const budget = r.code === "budget" || (r.code === "usage_pause" && r.source === "budget");
    const view: WidgetWaitView | null =
      r.code === "plan_limit" || r.code === "budget" || r.code === "usage_pause"
        ? { code: r.code, source: budget ? "budget" : "plan", resetsAt: r.resetsAt }
        : r.machineId && r.code !== "busy"
          ? { code: "computer", source: null, resetsAt: null }
          : null;
    if (view) out.set(r.routineId, { ...view, runId: r.runId, waitId: r.waitId });
  }
  return out;
}

/**
 * A widget's refresh run started or stopped waiting (its plan, its budget, its computer): the widget's viewers read it
 * again, so it says what holds it, or that it updates. Any other background run: nothing.
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
