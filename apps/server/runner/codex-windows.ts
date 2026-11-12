import { mkdirSync } from "node:fs";
import path from "node:path";
import { accountEnv } from "./accounts";
import { type CliRun, envValue, findOnWindowsPath, isFile, resolveCommand, windowsShellLine } from "./executors";
import { jsonLines, type UsageProbe } from "./plan-usage";

/**
 * Codex on Windows (ADR 0032 "Codex", ADR 0053 §3): how it starts there, and the sandbox a `plan` or `work` turn runs
 * in.
 *
 * - It starts as the native `codex.exe`, found on the PATH, never in the current folder (`findOnWindowsPath`); npm's
 *   `codex.cmd` as the `codex.exe` behind it. Nothing goes through cmd.exe then: its line stops at 8,191 characters
 *   and expands `%NAME%` even in quotes.
 * - The sandbox is MXC (Microsoft Execution Containers, Windows 11 24H2 and later): Windows' own isolation, no setup,
 *   no network, writes in the agent's folders. Codex picks no sandbox on Windows by itself, and its other two hold
 *   less (`unelevated` keeps the network out only through proxy variables) or need an administrator's setup that
 *   several Codex homes (each AI account's folder, ADR 0041) can't share (`elevated`). A computer without MXC
 *   doesn't run `plan` or `work` turns: they fail with `windows_sandbox`. A `chat` turn needs none: with no sandbox,
 *   Codex refuses every command of its own there, and the turn stops at the first one anyway.
 * - Nothing asks on Windows (`approvalPolicy: never`): the command policy reads POSIX shells, not the PowerShell Codex
 *   runs its commands in, so the sandbox is the whole limit, as for `codex exec` everywhere.
 */

/** Where npm puts the native Codex for each Windows CPU (`@openai/codex`'s platform packages). */
const NPM_TARGETS: Record<string, { pkg: string; triple: string }> = {
  x64: { pkg: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" },
  arm64: { pkg: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc" },
};

/**
 * The `codex.exe` npm's `codex.cmd` runs (through `node` and the package's launcher): in the platform package, nested
 * in `@openai/codex` as a global install puts it, or beside it, or in the package's own `vendor` folder. It finds its
 * helpers (the sandbox's, the code mode host, `rg`) next to itself, so it works started directly. Null: laid out
 * some other way.
 */
export function codexExeBehindShim(shim: string, arch: string = process.arch, exists = isFile): string | null {
  const target = NPM_TARGETS[arch];
  if (!target) return null;
  const dir = path.win32.dirname(shim);
  const main = path.win32.join(dir, "node_modules", "@openai", "codex");
  const exes = [
    path.win32.join(main, "node_modules", "@openai", target.pkg),
    path.win32.join(dir, "node_modules", "@openai", target.pkg),
    main,
  ].map((pkg) => path.win32.join(pkg, "vendor", target.triple, "bin", "codex.exe"));
  return exes.find((exe) => exists(exe)) ?? null;
}

/** cmd.exe's longest line (8,191 characters), with room to spare. */
const CMD_LINE_MAX = 8000;

/** How `codex` starts, or why it can't (`missing`: not installed). */
export type CodexLaunch = CliRun | { error: string; missing?: true };

/**
 * How `codex <args>` starts. Elsewhere: its full path on the PATH, as before. On Windows: found on the PATH, never in
 * the current folder; a `codex.exe` as it is; npm's `codex.cmd` as the `codex.exe` behind it (with what npm's
 * launcher tells it, how it was installed). A launcher laid out some other way goes through cmd.exe, only with our own
 * words in it (paths, ids and settings: nothing cmd.exe would read, `%`, `!` or a line break) and within its line.
 */
export function codexLaunch(
  args: readonly string[],
  opts: {
    bin?: string;
    pathList?: string;
    platform?: NodeJS.Platform;
    arch?: string;
    pathExt?: string;
    exists?: (file: string) => boolean;
  } = {},
): CodexLaunch {
  const platform = opts.platform ?? process.platform;
  const bin = opts.bin ?? "codex";
  if (platform !== "win32") return { file: resolveCommand(bin, opts.pathList), args: [...args] };
  const exists = opts.exists ?? isFile;
  const found = findOnWindowsPath(
    bin,
    opts.pathList ?? envValue(process.env, "PATH", platform) ?? "",
    opts.pathExt ?? envValue(process.env, "PATHEXT", platform),
    exists,
  );
  if (!found) return { error: "Codex is not installed on this computer.", missing: true };
  if (/\.(?:exe|com)$/i.test(found)) return { file: found, args: [...args] };
  if (!/\.(?:cmd|bat)$/i.test(found)) {
    return {
      error: `Codex here starts through ${path.win32.basename(found)}, which agents can't run. Install it with npm or OpenAI's installer.`,
    };
  }
  const exe = codexExeBehindShim(found, opts.arch ?? process.arch, exists);
  if (exe) return { file: exe, args: [...args], env: { CODEX_MANAGED_BY_NPM: "1" } };
  const launcher = "Codex here starts through a launcher agents can't hand this turn to";
  if (args.some((a) => /[%!\r\n]/.test(a))) {
    return { error: `${launcher} (its settings have a % or ! in them). Install Codex with npm or OpenAI's installer.` };
  }
  const run = windowsShellLine(found, args);
  if ((run.args.at(-1) ?? "").length > CMD_LINE_MAX) {
    return { error: `${launcher} (its settings are too long for it). Install Codex with npm or OpenAI's installer.` };
  }
  return run;
}

/**
 * A `plan` or `work` turn's `-c` overrides on Windows: MXC, explicitly, so a sandbox the computer's own Codex config
 * names (`unelevated`) never stands in for it, and a computer where it stopped working fails closed. Unified exec off:
 * multi-line commands through it were reported writing outside the folders on Windows while the same command in the
 * sandbox was refused, and the plain shell tool covers what a turn runs.
 */
export const CODEX_WINDOWS_CONFIG = ['windows.sandbox="mxc"', "features.unified_exec=false"];

/** What a `plan` or `work` turn says where Windows can't hold Codex's commands. */
export const WINDOWS_SANDBOX_MESSAGE =
  "This computer can't isolate Codex's commands: agents that think with Codex on Windows need Windows 11 24H2 or newer, with Microsoft Execution Containers (MXC). Update Windows there, or choose another way for this agent to think.";

/**
 * A thread's first prompt on Windows when it runs on `codex exec`: its instructions lead it, on stdin, as the plan
 * router's do (`codexRoute`). A command line can't carry them there (32,767 characters, 8,191 through cmd.exe).
 */
export const codexStdinPrompt = (instructions: string, prompt: string) =>
  instructions.trim() ? `${instructions.trim()}\n\n${prompt}` : prompt;

/**
 * `windowsSandbox/readiness` on a short-lived `codex app-server` that prefers MXC: `ready`, another state, `unknown`
 * (the request failed: an older Codex), or null (no answer).
 */
export function probeWindowsSandbox(p: UsageProbe): Promise<string | null> {
  return jsonLines(
    p,
    ["app-server", "-c", "features.prefer_mxc=true"],
    (send) => send({ id: 1, method: "initialize", params: { clientInfo: { name: "agentes_runner", version: "1" } } }),
    (msg, send) => {
      if (msg.id === 1) {
        if (!msg.result || typeof msg.result !== "object") return null;
        send({ method: "initialized" });
        send({ id: 2, method: "windowsSandbox/readiness" });
      } else if (msg.id === 2) {
        const status = (msg.result as { status?: unknown } | undefined)?.status;
        return typeof status === "string" ? status : "unknown";
      }
      return undefined;
    },
  );
}

/** How long a "no MXC here" is kept before asking again (Windows may have been updated meanwhile). */
export const WINDOWS_MXC_RETRY_MS = 10 * 60_000;

const mxcChecks = new Map<string, { ok: boolean; at: number }>();

/**
 * Whether MXC holds Codex's commands on this computer: `probeWindowsSandbox` in an empty Codex home of the runner's,
 * so none of the person's config answers for it (a sandbox it names reads `ready` too). Codex prefers MXC there only
 * where Windows has it and nothing forbids it (a managed `allow_mxc = false`), so `ready` is MXC. Kept per Codex
 * version: a yes for as long as the runner runs, a no for `WINDOWS_MXC_RETRY_MS`. Null: Codex didn't answer.
 */
export async function windowsMxcReady(input: {
  runnerHome: string;
  version: string;
  command?: string[];
  probe?: (p: UsageProbe) => Promise<string | null>;
  now?: () => number;
}): Promise<boolean | null> {
  const now = input.now ?? Date.now;
  const command = input.command ?? ["codex"];
  const key = `${command.join(" ")}@${input.version}`;
  const kept = mxcChecks.get(key);
  if (kept && (kept.ok || now() - kept.at < WINDOWS_MXC_RETRY_MS)) return kept.ok;
  const home = path.join(input.runnerHome, "brain", "codex-windows-check");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const status = await (input.probe ?? probeWindowsSandbox)({ command, cwd: home, env: accountEnv("codex", home) });
  if (status === null) return null;
  const ok = status === "ready";
  mxcChecks.set(key, { ok, at: now() });
  return ok;
}
