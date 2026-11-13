import type { Database } from "@agenteschat/db";
import type { JobDeps } from "./jobs";
import { defineLodiLane } from "./right-hand-lane";

/**
 * "Cuidar da equipe": the right hand looks for what stops the team (an AI sign-in that ended, an app, a mailbox or a
 * database to reconnect, a budget about to end, a computer gone) and tells the one person who can fix it, through
 * "Esperando você". It calls no model.
 *
 * The contract with the rest of the server is `teamWatchLane` below: the server reads the jobs, the sweep and the
 * switch from it, so nothing else is wired by hand.
 * - `enqueueTeamWatches` runs on the worker's `rightHand` tick, every 10 minutes, for every workspace at once. It
 *   queues `TEAM_WATCH_JOB` (payload `{}`, the organization on the job) only for open workspaces that have the right
 *   hand, whose `organization_settings.team_watch` is on (no row counts as on: `coalesce(s.team_watch, true)`) and
 *   that have something to look at, and returns how many it queued. One dedupe key per workspace and window.
 * - `runTeamWatch` is that job. It reads the switch again (`lodiSwitches`) and may run twice.
 * - `live` shows the "Cuidar da equipe" switch on the right hand's page and offers it to the right hand's tools.
 *   False keeps it off both.
 * Helpers: `lodiFor`, `saidOnce`, `lodiSwitches` (`right-hand-proactive.ts`). For a person's own switches, hours and
 * time zone in SQL: `lodiPrefsSql`, `knownZonesSql` and `zoneSql` (`right-hand-prefs.ts`).
 */

export const TEAM_WATCH_JOB = "team_watch.check";

export async function enqueueTeamWatches(_db: Database, _now: Date = new Date()): Promise<number> {
  return 0;
}

export async function runTeamWatch(_deps: JobDeps, _orgId: string): Promise<void> {}

export const teamWatchLane = defineLodiLane({
  switch: "teamWatch",
  live: false,
  jobs: { [TEAM_WATCH_JOB]: (deps, orgId) => runTeamWatch(deps, orgId) },
  sweep: enqueueTeamWatches,
});
