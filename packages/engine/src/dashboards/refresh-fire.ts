import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { getAgent } from "../agents";
import { type AiStatusDeps, backgroundAiState } from "../ai-status";
import type { Membership } from "../organizations";
import { dashboardRights, viewerOf } from "./access";
import { publishWidgetChanged, widgetEvent } from "./events";
import { holdWidgetForAi } from "./refresh-ledger";
import type { WidgetStatus } from "./types";

const { dashboards, dashboardWidgets } = schema;

/*
 * A widget routine as it fires (ADR 0135 §4, ADR 0053 §6): its widget and board must still be there, its creator
 * must still see the board, and its agent must have an AI to think with; then the widget shows it is being redone.
 * Kept apart from `refresh.ts` so `routines.ts` reads it without an import cycle.
 */

/** A person's change request, as the routine run carries it (`routine_runs.event`). */
export const WIDGET_CHANGE_EVENT = "widget.change";

/**
 * Whether a routine run is a person's ask on a widget ("Ask for a change"): like a manual run, it goes ahead while a
 * person keeps the widget's routine paused on purpose (ADR 0135 §6); only the schedule waits.
 */
export function isWidgetChangeRun(run: { event?: Record<string, unknown> | null }): boolean {
  return run.event?.type === WIDGET_CHANGE_EVENT;
}

type FiringDeps = { db: Database; pubsub?: PubSub; ai?: Omit<AiStatusDeps, "db"> };

/**
 * The widget's agent and why (`AgentAi.reason`) when it has no AI to think with for its build, else null (also when
 * nothing can tell: no `ai`). A build is background work (`backgroundAiState`), as the run's own check reads it.
 */
export async function widgetAgentWithoutAi(deps: FiringDeps, orgId: string, agentId: string) {
  if (!deps.ai) return null;
  const agent = await getAgent(deps.db, orgId, agentId);
  if (!agent || agent.archivedAt) return null;
  const ai = await backgroundAiState({ ...deps.ai, db: deps.db }, agent);
  return ai.state === "no_ai" ? { agent, reason: ai.reason ?? null } : null;
}

export type WidgetFiring =
  | { widget: { widgetId: string; dashboardId: string } }
  /** The widget or its board is gone, or its agent has no AI (the widget says so, `holdWidgetForAi`): the slot passes. */
  | { skip: "deleted" | "no_ai" }
  /** Its creator no longer sees the board: the routine pauses, the widget says why. */
  | { pause: "creator_no_access" };

/** Whether a widget routine's slot runs, for its creator (`creatorId`, whose `membership` it is). */
export async function widgetFiring(
  deps: FiringDeps,
  orgId: string,
  target: { widgetId: string; dashboardId: string },
  creatorId: string,
  membership: Membership,
): Promise<WidgetFiring> {
  const [row] = await deps.db
    .select({ widget: dashboardWidgets, board: dashboards })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(and(eq(dashboardWidgets.orgId, orgId), eq(dashboardWidgets.id, target.widgetId)));
  if (!row || row.board.deletedAt) return { skip: "deleted" };
  if (!dashboardRights(row.board, viewerOf(membership, creatorId)).see) return { pause: "creator_no_access" };
  const without = await widgetAgentWithoutAi(deps, orgId, row.widget.agentId);
  if (without) {
    await holdWidgetForAi(deps, row.widget, row.board, without.reason);
    return { skip: "no_ai" };
  }
  return { widget: { widgetId: row.widget.id, dashboardId: row.widget.dashboardId } };
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
