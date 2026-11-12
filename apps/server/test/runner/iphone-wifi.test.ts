import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { RunnerPhone } from "@agenteschat/adapters/machine-protocol";
import { en } from "@agenteschat/i18n";
import { featureKeysEn } from "../../../mobile/src/features/i18n/keys.en";
import { parseDevicectl, tunnelOf, wifiNearby } from "../../runner/apple-devices";
import { AppleTunnels, KEEP_NOTIFICATION, TunnelMissing } from "../../runner/apple-tunnel";
import { type HandlerContext, handleRequest, OP_ROUTES, type RequestScope } from "../../runner/handlers";
import { PhoneManager, REASON_WORDS } from "../../runner/phones";
import { helperEnv, IosHelper, WDA_VERSION } from "../../runner/wda";
import { freePort } from "./fake-usbmuxd";
import { errorCode, removeDirs, tempDir } from "./helpers";

setDefaultTimeout(30_000);

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const FAKE = path.join(import.meta.dir, "fake-phone-tools.mjs");
const FIXTURES = path.join(import.meta.dir, "fixtures", "devicectl");
const fixture = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

/** devicectl's own JSON for an iPhone on the Mac's network (Xcode 26.3, iOS 27), every identifier made up. */
const LISTED = fixture("list-wifi.json");
const TUNNEL = fixture("details-wifi-tunnel.json");
const NO_TUNNEL = fixture("details-wifi-no-tunnel.json");
const UDID = "00008120-000A1B2C3D4E5F60";
const UTUN = { utun5: [{ address: "fd12:3456:789a::2", family: "IPv6" }] };

const device = () => structuredClone(LISTED.result.devices[0]);
const listOf = (...devices: unknown[]) => ({ result: { devices } });
const withConn = (d: ReturnType<typeof device>, conn: Record<string, unknown>) => {
  d.connectionProperties = { ...d.connectionProperties, ...conn };
  return d;
};

test("an iPhone on the Mac's network is offered, never used until picked, then used over Wi-Fi", () => {
  // Not picked: listed as available, and no phone.
  expect(parseDevicectl(LISTED)).toEqual([]);
  expect(wifiNearby(LISTED)).toEqual([{ serial: UDID, model: "iPhone 14", name: "Sam's iPhone", osVersion: "27.0" }]);
  // Picked (by its UDID, spelled either way): a phone over Wi-Fi, and no longer on offer.
  const picked = new Set(["00008120000A1B2C3D4E5F60"]);
  expect(parseDevicectl(LISTED, new Set(), picked)).toEqual([
    {
      platform: "ios",
      serial: UDID,
      kind: "device",
      model: "iPhone 14",
      name: "Sam's iPhone",
      osVersion: "27.0",
      state: "ready",
      transport: "wifi",
    },
  ]);
  expect(wifiNearby(LISTED, picked)).toEqual([]);
  // Picked but off the network: said so, not dropped. Its trust removed: plug it in once.
  const { transportType: _gone, ...away } = device().connectionProperties;
  const offNetwork = { ...device(), connectionProperties: away };
  expect(parseDevicectl(listOf(offNetwork), new Set(), picked)).toEqual([
    expect.objectContaining({ state: "needs_you", reason: "wifi_away", transport: "wifi" }),
  ]);
  expect(wifiNearby(listOf(offNetwork))).toEqual([]);
  const unpaired = withConn(device(), { pairingState: "unpaired" });
  expect(parseDevicectl(listOf(unpaired), new Set(), picked)).toEqual([
    expect.objectContaining({ state: "needs_you", reason: "wifi_untrusted" }),
  ]);
  expect(wifiNearby(listOf(unpaired))).toEqual([]);
  // A cable wins over Wi-Fi; one too old for devicectl isn't offered.
  expect(parseDevicectl(listOf(withConn(device(), { transportType: "wired" })), new Set(), picked)).toEqual([
    expect.objectContaining({ transport: "usb", state: "ready" }),
  ]);
  const old = { ...device(), deviceProperties: { ...device().deviceProperties, osVersionNumber: "16.7.10" } };
  expect(wifiNearby(listOf(old))).toEqual([]);
});

test("the tunnel's address only when it's certain: up, unique local, on one of this Mac's own utun", () => {
  expect(tunnelOf(TUNNEL, UTUN)).toEqual({ address: "fd12:3456:789a::1" });
  // Spelled out in full or in capitals, it's the same address, written the way WDA and a URL take it.
  const spelled = structuredClone(TUNNEL);
  spelled.result.connectionProperties.tunnelIPAddress = "FD12:3456:789A:0:0:0:0:1";
  expect(tunnelOf(spelled, UTUN)).toEqual({ address: "fd12:3456:789a::1" });
  // The phone didn't answer (asleep or locked): devicectl says unavailable and names no transport.
  expect(tunnelOf(NO_TUNNEL, UTUN)).toEqual({ reason: "wifi_asleep" });
  // No utun of this Mac on its /64, the prefix only on Wi-Fi, a link-local or global address: never used.
  expect(tunnelOf(TUNNEL, {})).toEqual({ reason: "tunnel_down" });
  expect(tunnelOf(TUNNEL, { en0: [{ address: "fd12:3456:789a::2", family: "IPv6" }] })).toEqual({
    reason: "tunnel_down",
  });
  expect(tunnelOf(TUNNEL, { utun5: [{ address: "fd12:3456:789b::2", family: "IPv6" }] })).toEqual({
    reason: "tunnel_down",
  });
  for (const address of ["fe80::1", "2001:db8::1", "192.168.1.20", "0.0.0.0", "::", ""]) {
    const other = structuredClone(TUNNEL);
    other.result.connectionProperties.tunnelIPAddress = address;
    expect(tunnelOf(other, { ...UTUN, utun6: [{ address: "fe80::2", family: "IPv6" }] })).toEqual({
      reason: "tunnel_down",
    });
  }
  const unpaired = structuredClone(TUNNEL);
  unpaired.result.connectionProperties.pairingState = "unpaired";
  expect(tunnelOf(unpaired, UTUN)).toEqual({ reason: "wifi_untrusted" });
});

test("the test helper listens on the tunnel address or this Mac's loopback, never on any address", () => {
  const ports = { http: 8100, mjpeg: 9100 };
  expect(helperEnv({ A: "1" }, ports, { tunnel: "fd12:3456:789a::1" })).toEqual({
    A: "1",
    TEST_RUNNER_USE_PORT: "8100",
    TEST_RUNNER_MJPEG_SERVER_PORT: "9100",
    TEST_RUNNER_USE_IP: "fd12:3456:789a::1",
  });
  expect(helperEnv({}, ports, { loopback: true }).TEST_RUNNER_USE_IP).toBe("127.0.0.1");
  for (const tunnel of ["0.0.0.0", "::", "", "Sams-iPhone.coredevice.local"]) {
    expect(() => helperEnv({}, ports, { tunnel })).toThrow();
  }
});

test("every Wi-Fi state has words and a way out on every surface, without semicolons or dashes", () => {
  const reasons = ["wifi_away", "wifi_asleep", "tunnel_down", "wifi_untrusted"] as const;
  const mobile = featureKeysEn.devices.reason as Record<string, string>;
  for (const r of reasons) {
    const said = [REASON_WORDS[r], en.devices.reason[r], en.devices.fix[r], en.devices.iphone.wifiState[r], mobile[r]];
    for (const words of said) {
      expect(typeof words).toBe("string");
      expect(words).not.toMatch(/[;—]/);
    }
    // The runner's words, which agents read, name the cause and what to do.
    expect(REASON_WORDS[r]).toMatch(/\. .+\.$/);
  }
});

/** A Mac with fake Xcode tools, and a manager watching it. */
function rig(state: Record<string, unknown>, ios?: (env: NodeJS.ProcessEnv, root: string) => IosHelper) {
  const root = tempDir("iphone-wifi-");
  dirs.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  for (const tool of ["xcrun", "xcode-select"]) {
    writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${tool} "$@"\n`, {
      mode: 0o755,
    });
  }
  const stateFile = path.join(root, "state.json");
  const logFile = path.join(root, "log");
  const setState = (next: Record<string, unknown>) => writeFileSync(stateFile, JSON.stringify(next));
  setState(state);
  const env = { PATH: bin, HOME: root, FAKE_PHONE_STATE: stateFile, FAKE_PHONE_LOG: logFile };
  const sent: RunnerPhone[][] = [];
  const manager = new PhoneManager({
    log: () => {},
    onChange: (phones) => sent.push(phones),
    lockDir: path.join(root, "locks"),
    env,
    ios: ios ? ios(env, root) : null,
    platform: "darwin",
    home: root,
    dirs: [],
    adbServer: async () => null,
    settleMs: 0,
    caffeinate: false,
  });
  const calls = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as string[])
      : [];
  return { root, bin, env, manager, sent, calls, setState };
}

test("phone.wifi: lists what's on offer, a pick is kept on the Mac, and forgetting it lets it go", async () => {
  const r = rig({ devicectl: LISTED });
  const offer = [{ serial: UDID, model: "iPhone 14", name: "Sam's iPhone", osVersion: "27.0" }];
  expect(await r.manager.wifi({ action: "list" })).toEqual({ available: offer });
  expect(r.manager.list()).toEqual([]);
  // Only an iPhone on offer can be picked; anything else is refused in words.
  expect(await errorCode(() => r.manager.wifi({ action: "allow", serial: "00008120-0000000000000000" }))).toBe(
    "phone_missing",
  );
  expect(await errorCode(() => r.manager.wifi({ action: "allow" }))).toBe("bad_request");
  expect(await errorCode(() => r.manager.wifi({ action: "connect", serial: UDID }))).toBe("bad_request");
  expect(await r.manager.wifi({ action: "allow", serial: UDID })).toEqual({ available: [] });
  expect(r.manager.list()).toEqual([expect.objectContaining({ serial: UDID, transport: "wifi", state: "ready" })]);
  expect(JSON.parse(readFileSync(path.join(r.root, "iphones-wifi.json"), "utf8"))).toEqual([
    "00008120000A1B2C3D4E5F60",
  ]);
  // Another runner of this Mac's user reads the same pick.
  const again = new PhoneManager({
    log: () => {},
    onChange: () => {},
    lockDir: path.join(r.root, "locks"),
    env: r.env,
    ios: null,
    platform: "darwin",
    home: r.root,
    dirs: [],
    adbServer: async () => null,
    caffeinate: false,
  });
  await again.poll();
  expect(again.list().map((p) => p.transport)).toEqual(["wifi"]);
  // Held, it keeps its tunnel up; let go, the keeper stops.
  const holder = { runId: "run-1", agentId: "agent-lia", userId: "user-rui", since: "" };
  const io = { folder: r.root, resolve: async (p: string) => p, signal: new AbortController().signal };
  await r.manager.handle({ op: "phone.claim", platform: "ios", serial: UDID, holder }, io);
  const keeperCall = () => r.calls().find((c) => c.includes("observe"));
  for (let i = 0; i < 100 && !keeperCall(); i++) await Bun.sleep(20);
  const keeper = keeperCall() as string[];
  expect(keeper.slice(1, 8)).toEqual(["devicectl", "device", "notification", "observe", "--device", UDID, "--name"]);
  expect(keeper).toContain(KEEP_NOTIFICATION);
  // A real iPhone's log is read over its cable only.
  expect(
    await errorCode(() => r.manager.handle({ op: "phone.logs", platform: "ios", serial: UDID, holder, lines: 10 }, io)),
  ).toBe("unsupported");
  // Forgotten: let go at once, back on offer, and the pick is gone.
  expect(await r.manager.wifi({ action: "forget", serial: UDID })).toEqual({ available: offer });
  expect(r.manager.list()).toEqual([]);
  expect(JSON.parse(readFileSync(path.join(r.root, "iphones-wifi.json"), "utf8"))).toEqual([]);
  await r.manager.stop();
  await again.stop();
});

test("phone.wifi goes to the process that keeps the phones, and is never agent work", async () => {
  expect(OP_ROUTES["phone.wifi"]).toBe("machine");
  const r = rig({ devicectl: LISTED });
  const ctx: HandlerContext = {
    workspaceReal: r.root,
    exec: false,
    token: "agm_x",
    // Paused or not, a person's pick on the Mac isn't agent work.
    paused: () => true,
    phones: r.manager,
  };
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  expect(await handleRequest(ctx, { op: "phone.wifi", action: "list" }, scope)).toEqual({
    available: [expect.objectContaining({ serial: UDID })],
  });
  expect(await handleRequest({ ...ctx, phones: undefined }, { op: "phone.wifi", action: "list" }, scope)).toEqual({
    available: [],
  });
  await r.manager.stop();
});

test("the tunnel's address is read from devicectl and checked; a phone that doesn't answer is a reason", async () => {
  const r = rig({ details: TUNNEL });
  const xcrun = path.join(r.bin, "xcrun");
  const tunnels = new AppleTunnels({ env: r.env, log: () => {}, interfaces: () => UTUN });
  expect(await tunnels.address(xcrun, UDID)).toBe("fd12:3456:789a::1");
  r.setState({ details: NO_TUNNEL });
  const asleep = await tunnels.address(xcrun, UDID).catch((e: unknown) => e);
  expect(asleep).toBeInstanceOf(TunnelMissing);
  expect(asleep).toMatchObject({ reason: "wifi_asleep", code: "phone_not_ready", message: REASON_WORDS.wifi_asleep });
  // devicectl failing is a phone that didn't answer, never a guess at an address.
  r.setState({});
  expect(await tunnels.address(xcrun, UDID).catch((e: TunnelMissing) => e.reason)).toBe("wifi_asleep");
  // A keeper that loses the tunnel while held: the tunnel dropped.
  r.setState({ observeEnds: true });
  const release = tunnels.hold(xcrun, UDID);
  for (let i = 0; i < 100 && !r.calls().some((c) => c.includes("observe")); i++) await Bun.sleep(20);
  await Bun.sleep(300);
  expect(await tunnels.address(xcrun, UDID).catch((e: TunnelMissing) => e.reason)).toBe("tunnel_down");
  release();
  tunnels.stopAll();
});

/** IPv6 loopback stands in for the tunnel address, where this machine has it (a container may not). */
const ipv6 = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  (s as unknown as EventEmitter).once("error", () => resolve(false));
  s.listen(0, "::1", () => s.close(() => resolve(true)));
});
const AT = ipv6 ? "::1" : "127.0.0.1";

test("over Wi-Fi the helper runs on the tunnel address and is reached there; without one it doesn't start", async () => {
  const [http, mjpeg] = [await freePort(), await freePort()];
  let address: string | null = AT;
  let held = 0;
  const fakeTunnels = {
    hold: () => {
      held++;
      return () => {
        held--;
      };
    },
    address: async () => {
      if (address === null) throw new TunnelMissing("wifi_asleep");
      return address;
    },
    stopAll: () => {},
  } as unknown as AppleTunnels;
  let helper: IosHelper | null = null;
  const r = rig({ devicectl: LISTED }, (env, root) => {
    mkdirSync(
      path.join(root, ".agentes-runner", "wda", "src", `WebDriverAgent-${WDA_VERSION}`, "WebDriverAgent.xcodeproj"),
      {
        recursive: true,
      },
    );
    helper = new IosHelper({
      home: root,
      env,
      log: () => {},
      teams: async () => [{ id: "A1B2C3D4E5", name: "Sam Rivera", free: true }],
      screenLocked: async () => false,
      wifi: () => true,
      tunnels: fakeTunnels,
      devicePorts: { http, mjpeg },
    });
    return helper;
  });
  const xcrun = path.join(r.bin, "xcrun");
  const ios = helper as unknown as IosHelper;
  // Built for the phone first (the fake's xcodebuild), then run: listening on the tunnel address alone.
  const run = await ios.run("device", UDID, xcrun);
  expect(r.calls().find((c) => c[0] === "wda-listen")).toEqual(["wda-listen", AT, String(http)]);
  expect(run.client.base).toBe(ipv6 ? `http://[::1]:${http}` : `http://127.0.0.1:${http}`);
  expect(run.mjpegHost).toBe(AT);
  expect(await run.client.ready()).toBe(true);
  expect(held).toBe(1);
  ios.stop(UDID);
  expect(held).toBe(0);
  // No tunnel address for certain: it refuses in words, says why on the phone, and keeps no tunnel.
  address = null;
  const refused = await ios.run("device", UDID, xcrun).catch((e: unknown) => e);
  expect(refused).toMatchObject({ code: "phone_not_ready", message: REASON_WORDS.wifi_asleep });
  expect(ios.need(UDID, null)).toEqual({ state: "needs_you", reason: "wifi_asleep" });
  expect(held).toBe(0);
  ios.stopAll();
  await r.manager.stop();
});
