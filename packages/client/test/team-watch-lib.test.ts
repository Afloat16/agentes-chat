import { expect, test } from "bun:test";
import type { AppNotification } from "../src/api/types";
import { openTarget, sortWaiting, teamWatchOf, waitingCardOf } from "../src/lib/notifications";
import { soundForNotification } from "../src/lib/sounds";

const notice = (latest: AppNotification["latest"], extra: Partial<AppNotification> = {}): AppNotification => ({
  id: "n1",
  kind: "team_watch",
  waiting: true,
  actors: [{ type: "agent", id: "lodi" }],
  count: 1,
  source: {},
  latest,
  readAt: null,
  doneAt: null,
  snoozedUntil: null,
  createdAt: "2026-11-11T15:00:00.000Z",
  updatedAt: "2026-11-11T15:00:00.000Z",
  ...extra,
});

test("the right hand's notice is worded by its cause, with the first names and how many more", () => {
  const n = notice({ reason: "connector", names: ["Slack", "Notion", "Linear"], text: "stored" }, { count: 5 });
  expect(teamWatchOf(n)).toEqual({
    cause: "connector",
    words: { key: "notifications.teamWatch.connector", values: { names: "Slack, Notion, Linear +2" } },
    text: "stored",
  });
  expect(teamWatchOf(notice({ reason: "sign_in", names: ["Work"] }))?.words?.values).toEqual({ names: "Work" });
  expect(teamWatchOf({ ...n, kind: "approval" })).toBeNull();
});

test("a cause this build does not know keeps the server's own sentence", () => {
  const n = notice({ reason: "something_new", names: ["X"], text: "Something new is wrong. Fix it in Settings" });
  expect(teamWatchOf(n)).toMatchObject({
    cause: null,
    words: null,
    text: "Something new is wrong. Fix it in Settings",
  });
  expect(openTarget(n)).toBeNull();
  expect(waitingCardOf(n)).toMatchObject({ title: "Something new is wrong. Fix it in Settings", action: "open" });
});

test("it opens where it is fixed", () => {
  const section = (name: string): unknown => ({ to: "/org/$orgId/settings/$section", params: { section: name } });
  const open = (n: AppNotification): unknown => openTarget(n);
  expect(open(notice({ reason: "sign_in", names: ["Work"] }))).toEqual(section("usage"));
  for (const reason of ["connector", "mailbox", "database"])
    expect(open(notice({ reason, names: ["X"] }))).toEqual(section("connectors"));
  expect(open(notice({ reason: "budget_out", names: ["Dev"] }, { source: { agentId: "a1" } }))).toEqual({
    to: "/org/$orgId/agents/$agentId",
    params: { agentId: "a1" },
  });
  expect(open(notice({ reason: "budget_low", names: ["Dev", "Ada"] }, { count: 2 }))).toEqual(section("usage"));
  expect(open(notice({ reason: "computer", names: ["Mac"] }, { source: { machineId: "m1" } }))).toEqual({
    to: "/org/$orgId/settings/computers/$machineId",
    params: { machineId: "m1" },
  });
  expect(open(notice({ reason: "computer", names: ["Mac", "PC"] }, { count: 2 }))).toEqual(section("computers"));
});

test("it waits after what an agent asks, sounds once when it waits, and a budget about to end is quiet", () => {
  const found = notice({ reason: "sign_in", names: ["Work"] });
  const question = { ...found, id: "n2", kind: "agent_question" as const, updatedAt: "2026-11-11T10:00:00.000Z" };
  expect(sortWaiting([found, question]).map((n) => n.id)).toEqual(["n2", "n1"]);
  expect(soundForNotification(found, false)).toBe("attention");
  expect(soundForNotification({ ...found, waiting: false }, false)).toBeNull();
});

test("a build from before the kind shows the stored sentence and opens nothing", () => {
  // What `waitingCardOf` and `openTarget` do for any kind they have no case for, as installed builds run them.
  const unknown = {
    ...notice({ reason: "sign_in", names: ["Work"], text: "AI sign-in ended: Work. Sign in again in Settings" }),
    kind: "kind_of_a_newer_server",
  } as unknown as AppNotification;
  expect(waitingCardOf(unknown).title).toBe("AI sign-in ended: Work. Sign in again in Settings");
  expect(openTarget(unknown)).toBeNull();
});
