---
name: managing-tessera-task-workspaces
description: Allocates owned source workspaces, private audit runtime state, and retained evidence for Tessera tasks; use before smoke tests, visual audits, performance checks, integration, or device trials.
---

# Managing Tessera task workspaces

Use this procedure before the task-specific skill. Source ownership, runtime
isolation, retained evidence, and permission to publish are separate concerns.
It manages host workspaces. Process sandboxing and container configuration are
outside its scope.

## Establish ownership and base

- Check intercom and checkout state. Reuse an uncontended checkout when its
  changes belong to this task. Isolate concurrent source writers, uncertain
  ownership, and unrelated dirty work; one integrator owns integration.
  Read-only finders may share source, but each concurrent consumer gets a
  private runtime.
- Resolve the intended build from an explicit committed base and verify which
  commit was shipped. Record working changes separately when auditing a modified
  tree.
- Preserve applicable instructions and the selected skill versions in every
  lane's context. A worktree from an older commit will not contain these
  uncommitted skills: retain their originating absolute paths and pass their
  instructions explicitly. Do not reset or stage the user's files to transfer
  instructions.
- Harness-managed worktrees keep their own paths and lifecycle. Use reuse mode
  inside an owned harness tree; do not create a replacement just to change its
  location, or remove it yourself.

## Allocate source, runtime, and evidence

Run the helper from the selected repository root under the normal host HOME. Bun
and Git are prerequisites. The helper prints a shell environment-file path; it
does not start services, install dependencies, infer ownership, or grant publish
authority.

```sh
POLICY_DIR="$(pwd -P)/.agents/skills/managing-tessera-task-workspaces"
ENV_FILE="$(bun "$POLICY_DIR/scripts/prepare.ts" --mode worktree --base origin/main --task fields)"
. "$ENV_FILE"
```

Use `--mode reuse --base HEAD` for an already owned checkout, including a
harness-managed tree. Reuse refuses a base other than that checkout's HEAD.
Select ownership before invoking it; the helper cannot determine who owns dirty
files.

The helper derives the repository key from the canonical Git common directory.
It requires an absolute state root, rejects symlink ancestors, and allocates
fresh, owned `0700` task directories:

| Variable                   | Purpose                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `TASK_SOURCE`              | Reused checkout, or a detached worktree at `${XDG_STATE_HOME:-$HOME/.local/state}/agent-worktrees/<repo-key>/<task-id>`.                        |
| `TASK_RUN`                 | Disposable HOME/XDG, notebooks, profiles, downloads, tools, logs, binary, and assets under the corresponding `agent-runs/<repo-key>/<task-id>`. |
| `TASK_EVIDENCE`            | Retained reports, captures, traces, and provenance under `agent-artifacts/<repo-key>/<task-id>`, outside runtime cleanup.                       |
| `TASK_BASE`, `TASK_ID`     | Full base commit and unique task identity.                                                                                                      |
| `TASK_MAIN`, `TASK_TARGET` | Main checkout and its absolute Cargo target path, resolved before runtime HOME changes.                                                         |
| `TASK_POLICY`              | Originating shared procedure, even if the selected base predates it.                                                                            |
| `TASK_BIN`, `TASK_DIST`    | Reserved paths for this run's matching executable and web assets; preparation does not build them.                                              |
| `TASK_OWNS_WORKTREE`       | `yes` only for a manually created tree owned by this allocation; reuse never grants removal rights.                                             |

`TASK_RUN/context.json` records the allocation and its `runtime_env` map. `Eval`
subprocesses merge that map over their inherited environment for the same
isolation as `task_run`. Keep a resource ledger beside it with exact
service/browser handles, ports, device serials, ADB forwards/reverses, simulator
or AVD identities, and intentional handoffs. A name prefix is not proof of
ownership.

## Build before changing runtime HOME

Install dependencies from lockfiles in `TASK_SOURCE` under the normal host
environment. Do not symlink another checkout's `node_modules` or generated WASM
into it. Generate required demo/mobile assets in the owned checkout.

For host Rust builds, default to `CARGO_TARGET_DIR="$TASK_TARGET"`. Serialize
access and copy the matching executable into `TASK_BIN` before starting a run: a
later build must not silently replace the executable selected for an audit.

```sh
bun install --cwd "$TASK_SOURCE/web" --frozen-lockfile
CARGO_TARGET_DIR="$TASK_TARGET" cargo build --manifest-path "$TASK_SOURCE/Cargo.toml" --locked -p tessera-cli
cp "$TASK_TARGET/debug/tessera" "$TASK_BIN"
```

Build Vite assets into `TASK_DIST` from `TASK_SOURCE/web`. Timing, scaling, and
jitter audits require a release executable. Build with `--release` and copy that
executable instead. A shipped-build audit may copy its authorized installed
executable and use embedded assets. Record its `/api/service` build identity.

Use a separate target only when build/platform isolation requires it:
`CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$TASK_RUN/target"`. Record that exception
and remove the owned target after its consumers stop. Do not run `cargo clean`
against a shared target as a private-worktree repair. Managed ship/publish
caches are persistent task infrastructure; do not repurpose or delete them.

Cargo's complete test gate combines compilation, test execution, and doctests.
For this combined command, retain the installed toolchain/cache locations while
isolating HOME/XDG; do not substitute `--no-run` and a partial executable list:

```sh
HOST_CARGO="$(rustup which cargo)"
HOST_RUSTC="$(rustup which rustc)"
HOST_RUSTDOC="$(rustup which rustdoc)"
HOST_CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
HOST_RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
task_run env PATH="$(dirname "$HOST_CARGO"):$PATH" CARGO_HOME="$HOST_CARGO_HOME" RUSTUP_HOME="$HOST_RUSTUP_HOME" RUSTC="$HOST_RUSTC" RUSTDOC="$HOST_RUSTDOC" CARGO_TARGET_DIR="$TASK_TARGET" "$HOST_CARGO" test --manifest-path "$TASK_SOURCE/Cargo.toml" --workspace --locked
```

## Isolate runtime state

The environment file defines `task_run`, which applies HOME, all three XDG
directories, and TMPDIR/TMP/TEMP for one command without changing the build
shell's environment:

```sh
task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/hub" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"
```

- Use a unique named service and verified readiness. Allocate HTTP and sync
  listeners independently; `--sync-port 0` means an ephemeral loopback listener,
  not disabled sync. Record the actual listeners. Never take a peer's port or
  kill its listener because an example used that number.
- Keep the same origin and owned profile within persistence/offline tests. A
  different concurrent lane needs its own allocation, notebook, origin, and
  profile.
- Dependency installation and ordinary builds stay outside `task_run`; use the
  explicit toolchain/cache environment above for Cargo's combined test gate.
  Resolve installed browser/device tooling to absolute paths before isolated
  HOME hides discovery or toolchain settings.
- Start a fresh installed browser through `task_run` as an owned named service,
  with a profile under `TASK_RUN/profiles` and `--remote-debugging-port=0`. Read
  that profile's `DevToolsActivePort`, then attach the browser helper to the
  recorded loopback CDP endpoint. Closing a CDP-attached tab does not stop the
  launcher: retain its exact service handle. Do not attach to a user's existing
  browser/profile merely for convenience. Device WebView inspection instead uses
  the explicitly selected device and an owned inspection forward.
- Never let QA default to the live workshop, persistent clickaround seed, live
  registry, or another session's emulator. Carry the selected device serial
  through every ADB command. Do not accept account, security, or license prompts
  on the user's behalf.

## Copy data without retaining live attachments

Prefer synthetic fixtures or an explicitly permitted private backup. Browsing
writes reading positions; a read-only-looking audit is not permission to browse
a live notebook.

- Create a fresh destination directory under `TASK_RUN/notebooks` before running
  SQLite's online backup; `.backup` does not create parent directories. Quote
  its destination for SQLite's command parser as well as the shell, then copy
  the source objects there. On macOS, use `/usr/bin/sqlite3`; Android's
  PATH-provided sqlite3 is not a substitute. Do not copy a running database's
  bare file while ignoring its WAL.
- Never remove the source notebook's `service.lock`. If the selected copying
  method includes one, remove it only from the verified owned copy before
  serving; a copied lock can route CLI commands to the original service.
- For current-schema copies, clear the copy's persistent sync attachment with
  `DELETE FROM sync_hub;` before starting it. Check the schema first for
  older-release migration fixtures. Never run that statement on the source, and
  never let a copied replica reconnect to a live hub.
- Sharing and pairing use host-global Tailscale state. A scratch HOME is not
  protection against host commands, forwarded live endpoints, or device actions.
  Do not exercise them against the host's live route. Label a simulated dialog
  as simulated; real pairing needs separately authorized, owned endpoints.

## Integrate without touching peers' checkout state

For a writing task, create an owned branch if needed with
`git -C "$TASK_SOURCE" switch -c "omp/$TASK_ID"`. Bind subsequent commands to
the intended source with `git -C` or the tool's `cwd`; creating a worktree does
not change the caller's directory.

Transfer scoped commits or patches to the integrator's owned checkout. Do not
replay changes through a peer's index, move its `main`, reset/restore its files,
or copy whole files over its dirty versions. Worktrees share Git refs and common
metadata; source separation is not independent repository authority.

An audit or fix request does not authorize pushing, PR landing, shipping,
changing signing/account state, installing on a physical device, pairing, or
live-data writes. Retain the existing protected-main `mise run land` procedure
only when the user authorizes landing and the integration owner is identified.
The absence of an integration owner does not grant publish authority.

## Preserve evidence and tear down owned resources

1. Save selected reports, screenshots, traces, profiles, and logs to
   `TASK_EVIDENCE`. Include the base/build, engine, OS, viewport/device, seed
   identity, run context, and whether results were simulated. Do not disclose
   private notebook data without permission.
2. Stop only the services, browsers, inspection forwards/reverses, and owned
   simulators/AVDs recorded in this run's ledger. A deliberately retained trial
   or gallery needs a named next owner and persistent backing files.
3. Inspect and preserve needed untracked and ignored files. Keep unfinished
   work; report source path, branch, and next owner. Dependency/build
   directories are not the only ignored files a worktree may contain.
4. Only when `TASK_OWNS_WORKTREE=yes`, no consumer remains, and the work is
   preserved, run `git -C "$TASK_MAIN" worktree remove "$TASK_SOURCE"` without
   force. Never remove reused or harness-managed trees, and never run global
   worktree pruning as task cleanup.
5. Delete an owned branch with `git branch -d` only after its tip is integrated.
   Retain it if Git refuses. Remove only this allocation's recorded runtime
   paths after any handoff; do not use wildcard, prefix-wide process, or global
   ADB cleanup. Retain `TASK_EVIDENCE` and report its path.

## Optional execution boundary

A future Linux worker may provide portable builds, fixtures, private services,
and correctness checks. It must have its own compatible dependencies and target,
not Darwin binaries or dependency symlinks. Keep host Git/integration authority
and native acceptance separate; a linked worktree's `.git` pointer refers to
host common metadata.

macOS WKWebView/native timing, Xcode/CoreSimulator, Keychain/signing, and
physical-device acceptance remain on their actual platform. Do not present VM
timings or Linux WebKit as Mac/Fold acceptance. No container, daemon socket,
credential forwarding, or host-command bridge is enabled by this procedure.
