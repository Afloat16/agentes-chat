import type { Database } from "@agenteschat/db";
import type { JobDeps } from "./jobs";
import { defineLodiLane, type LodiPromptContext } from "./right-hand-lane";

/**
 * "Dar boas-vindas a quem entra": one message from the right hand to each person who joins a workspace, once, and
 * what it keeps in mind while they are new. The greeting calls no model.
 *
 * The contract with the rest of the server is `welcomeLane` below: the server reads the job, the prompt block and the
 * switch from it, so nothing else is wired by hand.
 * - `WELCOME_JOB` is queued where a person becomes a member, in that transaction, with `payload.userId` and one
 *   dedupe key per workspace and person, so nobody is greeted twice.
 * - `postWelcome` is that job. It posts nothing when the workspace turned it off (`lodiSwitches(...).welcomePeople`)
 *   or `lodiFor` says no, and may run twice (`postFromLodi` with `posted`).
 * - `newcomerBlock` is a block of the right hand's prompt in its DM with `ctx.personId`, or "". It is read on every
 *   turn there: keep it to one indexed query.
 * - `live` shows the "Dar boas-vindas a quem entra" switch on the right hand's page and adds it to
 *   `update_workspace`. False keeps it off both.
 */

export const WELCOME_JOB = "right_hand.welcome";

export async function postWelcome(_deps: JobDeps, _orgId: string, _payload: Record<string, unknown>): Promise<void> {}

export async function newcomerBlock(_db: Database, _ctx: LodiPromptContext): Promise<string> {
  return "";
}

export const welcomeLane = defineLodiLane({
  switch: "welcomePeople",
  live: false,
  jobs: { [WELCOME_JOB]: postWelcome },
  promptBlock: newcomerBlock,
});
