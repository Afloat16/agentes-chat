import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentUser, Launcher } from "../../runner/agent-users";
import { HOLDS_FILE, Holds, type HoldsSystem, keepScope, lockCommand, statStart } from "../../runner/holds";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

/**
 * `keep_running`'s holds on the computer (ADR 0176), with systemd-inhibit and the processes faked: each lock is a
 * fake process whose command line is kept, alive until the test ends it.
 */

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const AGENT = { id: "a1", handle: "desk" };
const USER: AgentUser = { id: "a1", user: "agent-desk", uid: 20001 };
const LAUNCHER: Launcher = {
  prefix: ["/usr/bin/systemd-run", "--quiet", "--scope", "--collect", "--slice=agents-20001.slice", "--", "/bin/sh"],
  env: { HOME: "/home/agent-desk" },
  home: "/home/agent-desk",
};
const HOLD = "0193f6b4-1111-7000-8000-000000000001";
const OTHER = "0193f6b4-2222-7000-8000-000000000002";
const SLICE = "/agents.slice/agents-20001.slice";

/** Processes by pid: their owner, cgroup and start time; `spawn` makes one per lock. */
function fakeSystem(now = { ms: Date.parse("2026-11-12T12:00:00Z") }) {
  const procs = new Map<number, { uid: number; cgroup: string; started: string; argv?: string[] }>();
  const ran: string[][] = [];
  let next = 5000;
  const populated = new Set<string>();
  const system: HoldsSystem = {
    spawn(argv) {
      const pid = next++;
      procs.set(pid, { uid: 0, cgroup: `${SLICE}/x.scope`, started: String(pid * 10), argv });
      return pid;
    },
    started: (pid) => procs.get(pid)?.started ?? null,
    owner: (pid) => procs.get(pid) ?? null,
    populated: (cgroup) => populated.has(cgroup),
    async run(argv) {
      ran.push(argv);
      // Stopping a hold's scope ends its lock.
      if (argv[1] === "stop") {
        for (const [pid, p] of procs) if (p.argv && argv[2] === keepScope(holdOf(p.argv))) procs.delete(pid);
      }
      return 0;
    },
    now: () => now.ms,
  };
  const holdOf = (argv: string[]) =>
    /--unit=agentes-keep-(.+)$/.exec(argv.find((a) => a.startsWith("--unit=")) ?? "")?.[1] ?? "";
  const locks = () => [...procs.entries()].filter(([, p]) => p.argv);
  /** The command line of the `i`th lock still living. */
  const argv = (i = 0) => locks()[i]?.[1].argv ?? [];
  return { system, procs, ran, populated, now, locks, argv };
}

function setup(fake = fakeSystem()) {
  const home = tempDir("holds-");
  dirs.push(home);
  const ended: [string, string][] = [];
  const browsers: string[] = [];
  const closed: string[] = [];
  const make = () =>
    new Holds({
      home,
      log: () => {},
      system: fake.system,
      onEnded: (id, reason) => ended.push([id, reason]),
      onBrowser: (agentId) => browsers.push(agentId),
      closeBrowser: async (agent) => {
        closed.push(agent.id);
      },
      takeMs: 0,
    });
  return { home, holds: make(), make, ended, browsers, closed, ...fake };
}

test("a program's hold: systemd-inhibit's idle lock as the agent, in a scope named after the hold, waiting on it", async () => {
  const t = setup();
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u7.scope`, started: "777" });
  expect(await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, pid: 4242 })).toEqual({
    held: true,
  });
  expect(t.argv().slice(0, 2)).toEqual(["/usr/bin/systemd-run", `--unit=agentes-keep-${HOLD}`]);
  const inhibit = t.argv().indexOf("/usr/bin/systemd-inhibit");
  // No words of the agent's: every user can list the locks.
  expect(t.argv().slice(inhibit)).toEqual([
    "/usr/bin/systemd-inhibit",
    "--what=idle",
    "--mode=block",
    "--who=agentes.chat",
    "--why=keep_running",
    "/bin/sh",
    "-c",
    'while kill -0 "$0" 2>/dev/null; do sleep 1; done',
    "4242",
  ]);
  expect(t.holds.report()).toEqual({ live: [HOLD], ended: [] });
  // The same hold again with the same bounds takes nothing new.
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, pid: 4242 });
  expect(t.locks()).toHaveLength(1);
});

test("only the agent's own programs, only living ones, and only what a hold can bind to", async () => {
  const t = setup();
  t.procs.set(10, { uid: 20002, cgroup: "/agents.slice/agents-20002.slice/run-u1.scope", started: "1" });
  t.procs.set(11, { uid: 20001, cgroup: "/system.slice/cron.service", started: "1" });
  const start = (req: Record<string, unknown>) =>
    errorCode(() => t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, ...req }));
  expect(await start({ pid: 10 })).toBe("not_allowed");
  expect(await start({ pid: 11 })).toBe("not_allowed");
  expect(await start({ pid: 999 })).toBe("not_found");
  expect(await start({})).toBe("bad_request");
  expect(await start({ until: "2026-11-12T11:00:00Z" })).toBe("bad_request");
  expect(await start({ browser: true })).toBe("browser_closed");
  expect(
    await errorCode(() =>
      t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: "x", until: "2026-11-13T00:00:00Z" }),
    ),
  ).toBe("bad_request");
  expect(t.locks()).toHaveLength(0);
});

test("a program that exits ends its hold, reported once and listed as ended", async () => {
  const t = setup();
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u7.scope`, started: "777" });
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, pid: 4242 });
  // The program goes, and with it the lock that waited on it.
  t.procs.delete(4242);
  for (const [pid] of t.locks()) t.procs.delete(pid);
  t.holds.sweep();
  t.holds.sweep();
  expect(t.ended).toEqual([[HOLD, "exited"]]);
  expect(t.holds.report()).toEqual({ live: [], ended: [{ id: HOLD, reason: "exited" }] });
});

test("a time's hold sleeps until then and ends as expired; the runner ends it itself at its time", async () => {
  const t = setup();
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, until: "2026-11-12T14:00:00Z" });
  expect(t.argv().slice(-2)).toEqual(["/bin/sleep", "7200"]);
  t.now.ms = Date.parse("2026-11-12T14:00:01Z");
  t.holds.sweep();
  expect(t.ended).toEqual([[HOLD, "expired"]]);
  await waitFor(() => t.ran.some((a) => a[1] === "stop" && a[2] === keepScope(HOLD)));
});

test("the browser's hold waits on its slice, keeps it open meanwhile, and a person's Stop closes it", async () => {
  const t = setup();
  t.populated.add(`${SLICE}/agents-20001-browser.slice`);
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, browser: true });
  expect(t.argv().at(-1)).toBe(`/sys/fs/cgroup${SLICE}/agents-20001-browser.slice/cgroup.events`);
  expect(t.holds.kept("a1")).toBe(true);
  expect(t.browsers).toEqual(["a1"]);
  expect(await t.holds.end({ op: "keep.end", holdId: HOLD, stop: true })).toEqual({ ended: true });
  expect(t.locks()).toHaveLength(0);
  expect(t.holds.kept("a1")).toBe(false);
  expect(t.closed).toEqual(["a1"]);
  // Ended on the server's word: nothing to report back.
  expect(t.ended).toEqual([]);
  expect(await t.holds.end({ op: "keep.end", holdId: HOLD })).toEqual({ ended: false });
});

test("a person's Stop signals the program as the agent, then SIGKILL only if that same process is still there", async () => {
  const t = setup();
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u7.scope`, started: "777" });
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, pid: 4242 });
  await t.holds.end({ op: "keep.end", holdId: HOLD, stop: true });
  expect(t.ran[0]).toEqual(["/usr/sbin/runuser", "-u", "agent-desk", "--", "/bin/kill", "-TERM", "4242"]);
  // Another process took the pid: nothing is signaled.
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u8.scope`, started: "999" });
  const before = t.ran.length;
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: OTHER, pid: 4242 });
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u9.scope`, started: "1000" });
  await t.holds.end({ op: "keep.end", holdId: OTHER, stop: true });
  expect(t.ran.slice(before).some((a) => a.includes("-TERM"))).toBe(false);
});

test("holds outlive the runner: one restarted goes on with those still living and reports those that ended", async () => {
  const t = setup();
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u7.scope`, started: "777" });
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, pid: 4242 });
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: OTHER, until: "2026-11-13T12:00:00Z" });
  expect(JSON.parse(readFileSync(path.join(t.home, HOLDS_FILE), "utf8")).holds).toHaveLength(2);
  // While no runner ran, the program's lock went.
  t.procs.delete(t.locks()[0]?.[0] ?? 0);
  const again = t.make();
  expect(again.report()).toEqual({ live: [OTHER], ended: [{ id: HOLD, reason: "exited" }] });
});

test("after the computer restarts no hold is left, and none is reported ended: the server takes a time's again", async () => {
  const t = setup();
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, until: "2026-11-13T12:00:00Z" });
  const file = path.join(t.home, HOLDS_FILE);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), boot: "a-boot-before" }));
  expect(t.make().report()).toEqual({ live: [], ended: [] });
});

test("a different time takes the lock again, the old one first", async () => {
  const t = setup();
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, until: "2026-11-12T14:00:00Z" });
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, until: "2026-11-12T16:00:00Z" });
  expect(t.locks()).toHaveLength(1);
  expect(t.argv().at(-1)).toBe("14400");
  expect(t.ran.some((a) => a[1] === "stop")).toBe(true);
});

test("another agent can't take or reach a hold", async () => {
  const t = setup();
  await t.holds.start(AGENT, USER, LAUNCHER, { op: "keep.start", holdId: HOLD, until: "2026-11-12T14:00:00Z" });
  const other = { id: "a2", user: "agent-ops", uid: 20002 };
  expect(
    await errorCode(() =>
      t.holds.start({ id: "a2", handle: "ops" }, other, LAUNCHER, {
        op: "keep.start",
        holdId: HOLD,
        until: "2026-11-12T15:00:00Z",
      }),
    ),
  ).toBe("not_allowed");
});

test("statStart reads the start time past a name with spaces and parentheses", () => {
  // Field n holds `f<n>`: the pid is field 1, the name field 2, the state field 3.
  const rest = Array.from({ length: 40 }, (_, i) => `f${i + 4}`).join(" ");
  expect(statStart(`123 (my (odd) bot) S ${rest}`)).toBe("f22");
});

// The lock's own commands, run for real (systemd-inhibit and the scope left out): each ends when what it holds does.
test("the program's wait ends with the program", async () => {
  const program = Bun.spawn(["/bin/sleep", "30"]);
  const [, , , , , ...wait] = lockCommand({ uid: 1, pid: { pid: program.pid, started: "" } }, Date.now());
  const waiting = Bun.spawn(wait);
  let done = false;
  void waiting.exited.then(() => {
    done = true;
  });
  await Bun.sleep(1200);
  expect(done).toBe(false);
  program.kill("SIGKILL");
  await waitFor(() => done, 5000);
});

test("the browser's wait ends a few looks after its slice is empty", async () => {
  const dir = tempDir("cg-");
  dirs.push(dir);
  const events = path.join(dir, "cgroup.events");
  spawnSync("/bin/sh", ["-c", `printf 'populated 1\\nfrozen 0\\n' > ${events}`]);
  const wait = lockCommand({ uid: 1, browser: true }, Date.now()).slice(5);
  wait[3] = events;
  const waiting = Bun.spawn(wait);
  let done = false;
  void waiting.exited.then(() => {
    done = true;
  });
  await Bun.sleep(2500);
  expect(done).toBe(false);
  spawnSync("/bin/sh", ["-c", `printf 'populated 0\\nfrozen 0\\n' > ${events}`]);
  await waitFor(() => done, 12_000);
});
