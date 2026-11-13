import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { coAuthorEnv, coAuthorHooks, coAuthorLines, HOOK_SCRIPT } from "../../runner/co-authors";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import { agentSecrets } from "../../runner/secrets";
import { hasGit, removeDirs, tempDir } from "./helpers";

const NICK = "Co-authored-by: Nick <noreply@agentes.chat>";
const ANA = "Co-authored-by: Ana <583231+ana-gh@users.noreply.github.com>";
const CLAUDE = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

const dirs: string[] = [];
let root = "";
let hooks = "";
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

beforeAll(() => {
  root = tempDir("co-authors-");
  const global = path.join(root, "gitconfig");
  writeFileSync(global, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  // Nobody's own git settings (a global core.hooksPath) reach these repositories.
  process.env.GIT_CONFIG_GLOBAL = global;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  hooks = coAuthorHooks(path.join(root, "home", "git-hooks")) ?? "";
});
afterAll(() => {
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.global;
  if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
  removeDirs([root]);
});
afterEach(() => removeDirs(dirs));

/** A repository with one commit; `git` runs there as the agent (with the lines) or as anyone else. */
function repo(lines: string[] = [NICK, ANA]) {
  const dir = tempDir("co-authors-repo-");
  dirs.push(dir);
  const agentEnv = { ...process.env, ...coAuthorEnv(lines, hooks, process.env) };
  const run = (env: NodeJS.ProcessEnv, args: string[], input?: string) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env, ...(input ? { input } : {}) });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const git = (...args: string[]) => {
    const r = run(agentEnv, args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
    return r.out.trim();
  };
  run(process.env, ["init", "-q"]);
  run(process.env, ["commit", "-q", "--allow-empty", "-m", "first"]);
  const message = () => run(process.env, ["log", "-1", "--format=%B"]).out.trim();
  const hook = (name: string, script: string, where = path.join(dir, ".git", "hooks")) => {
    mkdirSync(where, { recursive: true });
    writeFileSync(path.join(where, name), `#!/bin/sh\n${script}\n`);
    chmodSync(path.join(where, name), 0o755);
  };
  return { dir, git, run, agentEnv, message, hook };
}

describe("the lines a request carries", () => {
  test("only `Co-authored-by: Name <address>` on one line, four at most", () => {
    const agent = { id: "a", handle: "nick" };
    expect(coAuthorLines(agent)).toEqual([]);
    expect(
      coAuthorLines({ ...agent, coAuthors: [NICK, `${NICK}\nSigned-off-by: x <x@x>`, "Nick <a@b>", 7] as never }),
    ).toEqual([NICK]);
    expect(coAuthorLines({ ...agent, coAuthors: [NICK, NICK, NICK, NICK, ANA] })).toHaveLength(4);
  });

  test("the hook folder after whatever `git -c` settings the environment had; nothing without lines", () => {
    expect(coAuthorEnv([], "/h", {})).toEqual({});
    expect(coAuthorEnv([NICK, ANA], "/runner home/git-hooks", {})).toEqual({
      GIT_CONFIG_PARAMETERS: "'core.hooksPath=/runner home/git-hooks'",
      AGENTES_CO_AUTHORS: `${NICK}\n${ANA}`,
    });
    expect(coAuthorEnv([NICK], "/it's", { GIT_CONFIG_PARAMETERS: "'a.b=1'" })).toEqual({
      GIT_CONFIG_PARAMETERS: "'a.b=1' 'core.hooksPath=/it'\\''s'",
      AGENTES_GIT_CONFIG_PARAMETERS: "'a.b=1'",
      AGENTES_CO_AUTHORS: NICK,
    });
  });

  test("every hook git knows is the shim, readable by the agent's processes", () => {
    expect(hooks).not.toBe("");
    for (const name of ["commit-msg", "pre-commit", "pre-push", "reference-transaction", "post-checkout"]) {
      expect(readFileSync(path.join(hooks, name), "utf8")).toBe(HOOK_SCRIPT);
    }
  });
});

describe.skipIf(!hasGit)("git in the agent's processes", () => {
  test("a commit ends with the lines once, after the CLI's own trailer; amending adds nothing", () => {
    const r = repo();
    r.git("commit", "-q", "--allow-empty", "-m", "Fix login");
    expect(r.message()).toBe(`Fix login\n\n${NICK}\n${ANA}`);
    r.git("commit", "-q", "--allow-empty", "-m", `Add c\n\nBody.\n\n${CLAUDE}`);
    expect(r.message()).toBe(`Add c\n\nBody.\n\n${CLAUDE}\n${NICK}\n${ANA}`);
    // The agent wrote one itself, in other capitals: it stays alone.
    r.git("commit", "-q", "--allow-empty", "-m", "Add d\n\nCo-Authored-By: Nick <noreply@agentes.chat>");
    expect(r.message()).toBe(`Add d\n\nCo-Authored-By: Nick <noreply@agentes.chat>\n${ANA}`);
    r.git("commit", "-q", "--amend", "--allow-empty", "--no-edit");
    expect(r.message()).toBe(`Add d\n\nCo-Authored-By: Nick <noreply@agentes.chat>\n${ANA}`);
    // A merge commit is the agent's too.
    r.git("checkout", "-q", "-b", "side");
    r.git("commit", "-q", "--allow-empty", "-m", "side");
    r.git("checkout", "-q", "-");
    r.git("merge", "-q", "--no-ff", "side", "-m", "Merge side");
    expect(r.message()).toBe(`Merge side\n\n${NICK}\n${ANA}`);
  });

  test("the repository's own hooks run first and still refuse; a husky folder keeps working", () => {
    const r = repo([NICK]);
    r.hook("commit-msg", 'git interpret-trailers --in-place --trailer "Change-Id: I1" "$1"');
    r.git("commit", "-q", "--allow-empty", "-m", "Gerrit");
    expect(r.message()).toBe(`Gerrit\n\nChange-Id: I1\n${NICK}`);
    r.hook("commit-msg", "echo refused by the repository >&2; exit 1");
    const refused = r.run(r.agentEnv, ["commit", "-q", "--allow-empty", "-m", "Nope"]);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("refused by the repository");
    r.hook("commit-msg", "exit 0");
    r.hook("pre-commit", "echo lint failed >&2; exit 1");
    expect(r.run(r.agentEnv, ["commit", "-q", "--allow-empty", "-m", "Nope"]).out).toContain("lint failed");
    // husky: the repository's own core.hooksPath, hooks that find their helpers by their own path.
    const husky = path.join(r.dir, ".husky", "_");
    r.hook("h", 'echo "husky $(basename "$0") ran" >&2', husky);
    r.hook("commit-msg", '. "$(dirname "$0")/h"', husky);
    r.git("config", "core.hooksPath", ".husky/_");
    const out = r.run(r.agentEnv, ["commit", "-q", "--allow-empty", "-m", "Husky"]);
    expect(out.out).toContain("husky commit-msg ran");
    expect(r.message()).toBe(`Husky\n\n${NICK}`);
  });

  test("hooks that read stdin get it; a linked worktree uses the repository's hooks", () => {
    const r = repo([NICK]);
    const remote = tempDir("co-authors-remote-");
    dirs.push(remote);
    spawnSync("git", ["init", "-q", "--bare", remote], { env: process.env });
    r.hook("pre-push", `cat > "${path.join(r.dir, "pushed.txt")}"`);
    r.git("push", "-q", remote, "HEAD:refs/heads/main");
    expect(readFileSync(path.join(r.dir, "pushed.txt"), "utf8")).toContain("refs/heads/main");
    r.hook("post-commit", `echo seen > "${path.join(r.dir, "seen.txt")}"`);
    const wt = path.join(tempDir("co-authors-wt-"), "tree");
    dirs.push(path.dirname(wt));
    r.git("worktree", "add", "-q", "-b", "wt", wt);
    const inTree = spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "In a worktree"], {
      cwd: wt,
      env: r.agentEnv,
      encoding: "utf8",
    });
    expect(inTree.status).toBe(0);
    expect(readFileSync(path.join(r.dir, "seen.txt"), "utf8").trim()).toBe("seen");
    const log = spawnSync("git", ["log", "-1", "--format=%B"], { cwd: wt, env: process.env, encoding: "utf8" });
    expect(log.stdout.trim()).toBe(`In a worktree\n\n${NICK}`);
  });

  test("someone else's commits picked again credit nobody new; git outside the agent's processes adds nothing", () => {
    const r = repo([NICK]);
    const theirs = (branch: string, file: string, message: string) => {
      r.run(process.env, ["checkout", "-q", "-b", branch, "main"]);
      writeFileSync(path.join(r.dir, file), `${message}\n`);
      r.run(process.env, ["add", file]);
      r.run(process.env, ["commit", "-q", "-m", message]);
      r.run(process.env, ["checkout", "-q", "main"]);
    };
    theirs("picked", "a.txt", "Their fix");
    theirs("older", "b.txt", "Their older work");
    r.git("commit", "-q", "--allow-empty", "-m", "Mine");
    r.git("cherry-pick", "picked");
    expect(r.message()).toBe("Their fix");
    r.git("rebase", "-q", "main", "older");
    expect(r.message()).toBe("Their older work");
    r.run(process.env, ["commit", "-q", "--allow-empty", "-m", "By a person"]);
    expect(r.message()).toBe("By a person");
  });
});

describe.skipIf(!hasGit)("what the agent's commands get", () => {
  const scope = (): RequestScope => ({ signal: new AbortController().signal, output: () => {} });
  const dev = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };

  test("work that carries the lines commits with them; the same command without them doesn't", async () => {
    const ws = tempDir();
    const home = tempDir("runner-home-");
    dirs.push(ws, home);
    const ctx = { workspaceReal: ws, exec: true, token: "agm_x", secretsDir: path.join(home, "secrets") };
    const exec = (repo: string, agent: typeof dev & { coAuthors?: string[] }) => {
      const command = `git init -q ${repo} && cd ${repo} && git commit -q --allow-empty -m Fix && git log -1 --format=%B`;
      return handleRequest(ctx, { agent, op: "exec", command, timeoutSeconds: 30, stream: false }, scope()) as Promise<{
        stdout: string;
      }>;
    };
    expect((await exec("one", { ...dev, coAuthors: [NICK] })).stdout.trim()).toBe(`Fix\n\n${NICK}`);
    expect(readFileSync(path.join(home, "git-hooks", "commit-msg"), "utf8")).toBe(HOOK_SCRIPT);
    expect((await exec("two", dev)).stdout.trim()).toBe("Fix");
    // Nothing for a request without lines, not even an empty answer to keep.
    expect(await agentSecrets(ctx.secretsDir, dev)).toBeNull();
  });
});
