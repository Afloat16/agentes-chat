import {
  type Dashboard,
  useDashboard,
  useHomeDashboard,
  useRoles,
  type Widget,
  widgetFailureKey,
  widgetWaiting,
  widgetWaitText,
} from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory, useNow, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { HOME } from "./logic";

/** An agent's name and color by id (one that left the team keeps its look on what it made). */
export function useAgentLook(agentId: string | null | undefined): { name: string; color: AgentColorName } {
  const dir = useDirectory();
  const agent = agentId ? dir.anyAgent(agentId) : undefined;
  return { name: agent?.name ?? "", color: agentLook(agent).color };
}

/** A board by id, or My Home (`home`): made the first time it is opened. */
export function useBoard(id: string): {
  board: Dashboard | undefined;
  loading: boolean;
  failed: boolean;
  refetch: () => Promise<unknown>;
} {
  const orgId = useOrgId();
  const home = useHomeDashboard(orgId, id === HOME);
  const one = useDashboard(orgId, id === HOME ? null : id);
  const q = id === HOME ? home : one;
  return { board: q.data, loading: q.isLoading, failed: q.isError && !q.data, refetch: q.refetch };
}

/** The workspace's own roles (not "everyone"), top first: Share's chips and a board's line. */
export function useCustomRoles() {
  const roles = useRoles(useOrgId());
  return useMemo(() => sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))), [roles.data]);
}

/**
 * What a widget says about itself: why it didn't update, what its refresh waits for ("Waiting for Theo's plan to reset
 * at 13:00", "" when nothing does), and when it last updated ("12 min ago"). `now` moves on every minute, so a wait
 * reads as over once its reset passes, and room on the computer is said once it waited long enough.
 */
export function useWidgetWords() {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const now = useNow(60_000);
  const failure = useCallback(
    (w: Pick<Widget, "failure" | "agentId">) => {
      if (!w.failure) return "";
      const name = dir.anyAgent(w.agentId)?.name ?? "";
      if (w.failure.code === "agent_reported") return w.failure.detail || t("widgets.failure.error");
      return t(widgetFailureKey(w.failure.code), { name, detail: w.failure.detail ?? "" });
    },
    [t, dir],
  );
  const wait = useCallback(
    (w: Pick<Widget, "status" | "agentId"> & { wait?: Widget["wait"] }) => {
      const waiting = widgetWaiting({ status: w.status, wait: w.wait ?? null }, now);
      const name = dir.anyAgent(w.agentId)?.name ?? "";
      return waiting ? widgetWaitText(t, i18n.language, waiting, name, new Date(now)) : "";
    },
    [t, i18n.language, dir, now],
  );
  const ago = useCallback((iso: string) => relativeTime(t, i18n.language, iso, new Date(now)), [t, i18n.language, now]);
  return { failure, wait, ago, now, locale: i18n.language };
}
