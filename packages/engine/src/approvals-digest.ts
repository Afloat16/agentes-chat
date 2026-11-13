import type { JobDeps } from "./jobs";
import { defineLodiLane } from "./right-hand-lane";

/**
 * "Resumir aprovações esperando": when several approvals wait on one person, the right hand posts one card in their DM
 * that tells the routine ones from the risky ones. It decides nothing and calls no model.
 *
 * The contract with the rest of the server is `approvalsDigestLane` below, and this file is the only wiring that
 * changes to build it:
 * - `APPROVALS_DIGEST_JOB` is queued by whoever publishes a new approval, per person told, with `payload.userId` and
 *   a dedupe key per person and time slot.
 * - `postApprovalsDigest` is that job. It posts nothing when the person turned it off (`readLodiPrefs(...).prefs
 *   .digestOff`) or `lodiFor` says no, and may run twice: `postFromLodi` with `posted`, or `setCardOnMessage` on the
 *   card already there. The card is `{ kind: "approvals", params: { approvalIds, why, digest: true } }`.
 * - `live: true` shows the "Resumir aprovações esperando" switch on the right hand's page and adds `digest` to
 *   `set_team_week`. Until then nobody sees it.
 */

export const APPROVALS_DIGEST_JOB = "approvals_digest.post";

export async function postApprovalsDigest(
  _deps: JobDeps,
  _orgId: string,
  _payload: Record<string, unknown>,
): Promise<void> {}

export const approvalsDigestLane = defineLodiLane({
  switch: "digest",
  live: false,
  jobs: { [APPROVALS_DIGEST_JOB]: postApprovalsDigest },
});
