#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync, mkdirSync, realpathSync, rmSync, rmdirSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function noSymlinks(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing symlink in task path: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === dirname(current)) break;
  }
}

function privateDirectory(path: string): void {
  noSymlinks(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid!()) {
    throw new Error(`Expected an owned 0700 directory: ${path}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: bun prepare.ts --mode reuse|worktree --base <commit-ish> --task <lowercase-label>");
    console.log("Prints a shell environment-file path. Ownership must be established before --mode reuse.");
    return;
  }
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!["--mode", "--base", "--task"].includes(key) || key in options || !value || value.startsWith("--")) {
      throw new Error("Expected --mode reuse|worktree --base <commit-ish> --task <lowercase-label>");
    }
    options[key] = value;
  }
  const mode = options["--mode"];
  const baseRef = options["--base"];
  const task = options["--task"];
  if (!["reuse", "worktree"].includes(mode) || !baseRef || !task || !/^[a-z][a-z0-9-]{0,39}$/.test(task)) {
    throw new Error("Provide a mode, explicit committed base, and a lowercase task label (1–40 characters).");
  }

  const repository = realpathSync(git(process.cwd(), ["rev-parse", "--show-toplevel"]));
  const common = realpathSync(git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const base = git(repository, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
  if (mode === "reuse" && base !== git(repository, ["rev-parse", "HEAD"])) {
    throw new Error("Reuse requires the selected checkout's current HEAD; use worktree for another base.");
  }
  const mainRecord = git(repository, ["worktree", "list", "--porcelain", "-z"])
    .split("\0").find(record => record.startsWith("worktree "));
  if (!mainRecord) throw new Error("No main checkout was found for the shared Cargo target.");
  const mainCheckout = realpathSync(mainRecord.slice("worktree ".length));
  const state = process.env.XDG_STATE_HOME || (process.env.HOME && join(process.env.HOME, ".local/state"));
  if (!state || !isAbsolute(state)) throw new Error("HOME/XDG_STATE_HOME must resolve to an absolute state root.");
  const stateRoot = resolve(state);
  const repoKey = `tessera-${createHash("sha256").update(common).digest("hex").slice(0, 12)}`;
  const id = `${task}-${randomBytes(6).toString("hex")}`;
  const parents = ["agent-worktrees", "agent-runs", "agent-artifacts"].map(kind => join(stateRoot, kind, repoKey));
  for (const parent of parents) privateDirectory(parent);
  const source = mode === "worktree" ? join(parents[0], id) : repository;
  const run = join(parents[1], id);
  const evidence = join(parents[2], id);
  const allocated: string[] = [];
  let sourceAllocated = false;
  let worktreeAdded = false;

  try {
    // Non-recursive mkdir claims a fresh path; never reuse or clear a prior run.
    mkdirSync(run, { mode: 0o700 });
    allocated.push(run);
    mkdirSync(evidence, { mode: 0o700 });
    allocated.push(evidence);
    if (mode === "worktree") {
      mkdirSync(source, { mode: 0o700 });
      sourceAllocated = true;
      git(repository, ["worktree", "add", "--quiet", "--detach", source, base]);
      worktreeAdded = true;
    }
    for (const child of ["home", "data", "state", "cache", "tmp", "notebooks", "profiles", "downloads", "bin", "dist", "logs", "tools"]) {
      mkdirSync(join(run, child), { mode: 0o700 });
    }
    const policy = dirname(dirname(fileURLToPath(import.meta.url)));
    const environment = {
      TASK_ID: id, TASK_BASE: base, TASK_SOURCE: source, TASK_RUN: run,
      TASK_EVIDENCE: evidence, TASK_MAIN: mainCheckout, TASK_TARGET: join(mainCheckout, "target"),
      TASK_POLICY: policy, TASK_BIN: join(run, "bin/tessera"), TASK_DIST: join(run, "dist"),
      TASK_OWNS_WORKTREE: mode === "worktree" ? "yes" : "no",
    };
    const runtimeEnvironment = {
      HOME: join(run, "home"), XDG_DATA_HOME: join(run, "data"),
      XDG_STATE_HOME: join(run, "state"), XDG_CACHE_HOME: join(run, "cache"),
      TMPDIR: join(run, "tmp"), TMP: join(run, "tmp"), TEMP: join(run, "tmp"),
    };
    const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const envFile = join(run, "env.sh");
    const exports = Object.entries(environment).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
    const runtimeArgs = Object.entries(runtimeEnvironment).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
    writeFileSync(envFile, exports + `\n\ntask_run() {\n  env ${runtimeArgs} "$@"\n}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(join(run, "context.json"), JSON.stringify({
      ...environment, runtime_env: runtimeEnvironment, git_common_directory: common, repository_key: repoKey,
      created_at: new Date().toISOString(),
    }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(envFile);
  } catch (error) {
    // No environment has been returned and no consumers have been started.
    // Only these newly claimed paths are eligible for failed-setup cleanup.
    if (sourceAllocated) {
      try {
        if (worktreeAdded) git(repository, ["worktree", "remove", source]);
        else rmdirSync(source);
      } catch (cleanupError) {
        console.error(`Retained workspace ${source}: ${String(cleanupError)}`);
      }
    }
    for (const path of allocated.reverse()) rmSync(path, { recursive: true });
    throw error;
  }
}

const previousMask = process.umask(0o077);
try {
  main();
} catch (error) {
  console.error(`prepare: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  process.umask(previousMask);
}
