import { expect, test } from "bun:test";
import type { Approval } from "../src/index";
import { digestGroups } from "../src/lib/approval-card";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-06T12:00:00Z");

const ask = (id: string, over: Partial<Approval> = {}): Approval => ({
  id,
  runId: `run-${id}`,
  agentId: "agent-ada",
  channelId: "c-eng",
  threadId: null,
  messageId: null,
  tool: "notes_create_page",
  scope: "custom:notes:write",
  title: `Create page ${id}`,
  detail: "",
  params: {},
  status: "pending",
  expiresAt: new Date(NOW + HOUR).toISOString(),
  createdAt: new Date(NOW - HOUR).toISOString(),
  decidedByUserId: null,
  decidedAt: null,
  reason: null,
  canDecide: true,
  routine: true,
  ...over,
});

const ids = (list: readonly Approval[]) => list.map((a) => a.id);

test("the routine group is what the server calls routine, still waits and is this person's to decide", () => {
  const items = [
    ask("a"),
    // A harmless name is not enough: only the server's word counts.
    ask("b", { routine: false }),
    ask("c", { routine: undefined }),
    // High risk by every word the app knows, and still the server's word alone decides.
    ask("d", { tool: "merge_pull_request", scope: "github:pr.merge" }),
    ask("e", { canDecide: false }),
    ask("f", { status: "approved" }),
    ask("g", { expiresAt: new Date(NOW - 1).toISOString() }),
    ask("h"),
  ];
  const groups = digestGroups(items, NOW);
  expect(ids(groups.routine)).toEqual(["a", "d", "h"]);
});

test("fewer than two routine ones are no group: each keeps its own card", () => {
  expect(digestGroups([ask("a"), ask("b", { routine: false }), ask("c", { routine: false })], NOW)).toEqual({
    routine: [],
  });
  expect(digestGroups([], NOW)).toEqual({ routine: [] });
});

test("a server that does not tell routine apart gives no group", () => {
  const old = ["a", "b", "c"].map((id) => ask(id, { routine: undefined }));
  expect(digestGroups(old, NOW).routine).toEqual([]);
});
