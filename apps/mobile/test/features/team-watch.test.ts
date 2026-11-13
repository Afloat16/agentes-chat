import { expect, test } from "bun:test";
import { notificationHref, notificationWebPath } from "../../src/features/links/logic";
import { notification } from "./fixtures";

const found = (reason: string, source = {}) =>
  notification({ kind: "team_watch", waiting: true, source, latest: { reason, names: ["X"], text: "stored" } });

test("what the right hand found opens where it is fixed", () => {
  expect(notificationHref(found("sign_in"))).toBe("/ai-accounts");
  for (const reason of ["connector", "mailbox"]) expect(notificationHref(found(reason))).toBe("/connectors");
  expect(notificationHref(found("budget_out", { agentId: "a1" }))).toBe("/agent/a1");
  expect(notificationHref(found("budget_low"))).toBe("/usage");
  expect(notificationHref(found("computer", { machineId: "m1" }))).toBe("/settings/devices/m1");
  expect(notificationHref(found("computer"))).toBe("/settings/devices");
});

test("a database is reconnected on the web: no screen here, so the tap opens its page there", () => {
  const n = found("database");
  expect(notificationHref(n)).toBeNull();
  expect(notificationWebPath(n, "o1")).toBe("/org/o1/settings/connectors");
});

test("a cause this build does not know opens nothing, here or on the web", () => {
  const n = found("something_new");
  expect(notificationHref(n)).toBeNull();
  expect(notificationWebPath(n, "o1")).toBeNull();
});
