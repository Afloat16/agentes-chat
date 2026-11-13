import type { Database } from "@agenteschat/db";
import type { JobDeps } from "./jobs";
import { defineLodiLane, type LodiPromptContext } from "./right-hand-lane";

/**
 * "Lembrar o que combinamos": the right hand follows a task it handed over to its end, says once when one is stuck,
 * and keeps what it and a person agreed on with a time as a reminder.
 *
 * The contract with the rest of the server is `followLane` below, and this file is the only wiring that changes to
 * build it:
 * - `TASK_CHECK_JOB` is queued where a task is handed to an agent for a person, with `runAt` a day later and a dedupe
 *   key per hand-over and look.
 * - `checkHandedTask` is that job. It may run twice (`saidOnce` before it tells anything) and calls no model itself.
 * - `keepingWordBlock` is a block of the right hand's prompt in its DM with `ctx.personId`, or "" (always "" when
 *   that person turned reminders off: `readLodiPrefs(...).prefs.remindOff`). It is read on every turn there: keep it
 *   to one indexed query.
 * - `live: true` shows the "Lembrar o que combinamos" switch on the right hand's page and adds `reminders` to
 *   `set_team_week`. Until then nobody sees it.
 */

export const TASK_CHECK_JOB = "right_hand.task_check";

export async function checkHandedTask(
  _deps: JobDeps,
  _orgId: string,
  _payload: Record<string, unknown>,
): Promise<void> {}

export async function keepingWordBlock(_db: Database, _ctx: LodiPromptContext): Promise<string> {
  return "";
}

export const followLane = defineLodiLane({
  switch: "reminders",
  live: false,
  jobs: { [TASK_CHECK_JOB]: checkHandedTask },
  promptBlock: keepingWordBlock,
});
