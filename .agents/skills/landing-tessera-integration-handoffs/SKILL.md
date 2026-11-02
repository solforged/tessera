---
name: landing-tessera-integration-handoffs
description: "Verifies and lands peer commits or patches through an owned Tessera integration checkout and protected-main pull request; use when acting as the designated integration owner, with shipping separately authorized."
---

# Landing peer handoffs on Tessera main

The user may name one integration owner. Peers transfer scoped commits or
patches; the owner integrates and verifies in an owned checkout, then lands or
ships only when authorized. Messages can cross after rebases, so expect stale
SHAs. Never assemble commits through a peer's index or replay work over its
dirty files.

## Establish the integration source and run

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to establish the integration owner, prepare/source the intended integration
workspace and allocate its run.

Create an owned branch with `git -C "$TASK_SOURCE" switch -c "omp/$TASK_ID"`.
Every Git command below is scoped to this source; run `mise`, Cargo, web and `gh`
commands with tool `cwd: TASK_SOURCE` or `TASK_SOURCE/web` as appropriate.
Source separation does not grant permission to move shared main or another
branch's refs.

## Know what will land

- `git -C "$TASK_SOURCE" fetch -q origin`, then
  `git -C "$TASK_SOURCE" log --oneline origin/main..HEAD`. Landing includes
  every ancestor; inspect
  `git -C "$TASK_SOURCE" diff --stat origin/main..HEAD -- crates/tessera-core/migrations`
  and exclude unintended peer work.
- Map source owners before accepting handoffs. Ask for exact base, commit SHAs
  or patch, paths, tests, migration implications and remaining work. Do not use
  `git add -A` or collect unrelated dirty work.
- Check whether a handoff already landed with
  `git -C "$TASK_SOURCE" cherry origin/main <peer-tip>`. `-` means an identical
  patch is upstream. If all scoped handoff commits are equivalent, report their
  landed SHAs; do not delete a peer's branch. A tree comparison with
  `git -C "$TASK_SOURCE" rev-parse A^{tree} B^{tree}` can establish whole-tree
  equivalence, but is not authority to reset a shared checkout.
- Branch names may be stale or deleted: cherry-pick exact handed-off SHAs with
  `git -C "$TASK_SOURCE" cherry-pick -S <sha1> <sha2>`. For uncommitted work,
  ask the peer for a scoped patch and use
  `git -C "$TASK_SOURCE" apply --3way <absolute-patch>` in the owned integration
  tree. Inspect/commit only those changes there. Do not use shared-index blob
  staging, update-ref, reset/restore, or whole-file copies over peers.

## Verify the integrated batch

Build/stage the integrated executable and assets using the shared host-build
procedure:

```sh
bun install --cwd "$TASK_SOURCE/web" --frozen-lockfile
CARGO_TARGET_DIR="$TASK_TARGET" cargo build --manifest-path "$TASK_SOURCE/Cargo.toml" --locked -p tessera-cli
cp "$TASK_TARGET/debug/tessera" "$TASK_BIN"
(cd "$TASK_SOURCE/web" && bunx tsc --noEmit && bunx vite build --outDir "$TASK_DIST" --emptyOutDir)
```

Run the complete workspace test gate, including doctests, once after the lane
batch integrates. Capture the host toolchain/cache paths before runtime HOME
changes, then use the shared combined compile/test exception:

```sh
HOST_CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
HOST_RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
HOST_CARGO="$(rustup which cargo)"  # bypass mise/rustup shims after isolating HOME
HOST_RUSTC="$(rustup which rustc)"
HOST_RUSTDOC="$(rustup which rustdoc)"
(cd "$TASK_SOURCE" && task_run env PATH="$(dirname "$HOST_CARGO"):$PATH" CARGO_HOME="$HOST_CARGO_HOME" RUSTUP_HOME="$HOST_RUSTUP_HOME" RUSTC="$HOST_RUSTC" RUSTDOC="$HOST_RUSTDOC" CARGO_TARGET_DIR="$TASK_TARGET" "$HOST_CARGO" test --workspace --locked)
```

Run the full web suite from `TASK_SOURCE/web` through `task_run` with
`TESSERA_TEST_BINARY="$TASK_BIN"` and an owned test port; omitting that binary
can cause worktree document-test ENOENT.

Smoke as a unique named service:
`task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/integration" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`.
Verify readiness/build identity. Use a fresh seed or a permitted copy detached
by the shared procedure, never live data.

- A 5000 ms `(unnamed)` document-test timeout can mean a held port (historically
  4330). Inspect the listener and its recorded owner. Stop it only if this run
  owns its exact handle; a `tessera-Document-tests-*` process name is not proof.
  Otherwise coordinate or allocate a supported private port.
- The acknowledged-structural-deltas offline-restore case has historically
  flaked. Record the actual failure and conditions rather than dismissing it or
  rerunning solely to invalidate a peer's reported failure.
- If explicit mutation testing is requested, change only the owned checkout,
  preserve the original work, and show the named test's failing/passing
  evidence. Never restore/reset a peer's file as part of the experiment.
- For overlapping migrations, preserve both registrations and update every
  applicable downgrade fixture; use
  `landing-lane-patches-around-dirty-peer-trees` for integration-specific
  conflict guidance.

## Land and optionally ship

Follow `shipping-tessera-live-builds`, “Land a change on main”, and `/land` for
the protected-main PR procedure. An integration assignment alone does not
authorize publishing. When authorized, run
`mise run land -- --wait <owned-branch>` with tool `cwd: TASK_SOURCE`. Commit
messages use lowercase past-tense summaries and header/body lines ≤72. Keep this
owned handoff/verification procedure rather than using the original dirty
checkout as the landing target.

`--wait` takes about 10–15 minutes (4–5 for web/docs-only PRs) and fails if a
required check fails or main moves. If a rebase needs a PR branch update,
confirm that this is the integrator's owned branch and record the old remote SHA
before the authorized leased update:

```sh
git -C "$TASK_SOURCE" fetch origin
git -C "$TASK_SOURCE" rebase origin/main
git -C "$TASK_SOURCE" push --force-with-lease=refs/heads/<owned-branch>:<recorded-old-sha> origin HEAD:refs/heads/<owned-branch>
```

Rerun `mise run land -- --wait <owned-branch>` from the same owned source; it
reuses the PR. Never force-push main. Ship only after the SHA lands on
`origin/main` and shipping is authorized, following
`shipping-tessera-live-builds`. For an authorized ship, smoke
`POST /api/library/query {}` (expect 200); if migrations shipped, inspect the
managed live `~/.local/state/tessera/logs/serve.log` for each
`migration applied version=N`. These managed logs are not task scratch to
delete.

## Handoff and cleanup

- Send affected peers the integrated SHAs (cherry-picks change them), actual
  checks/failures, retained evidence path and, if shipped, backup path/live
  build. Peers reconcile their own branches; never tell them to discard
  unfinished work or reset their checkout for them.
- Give the user the landed/shipped SHA as applicable, backup path, migrations
  and only checks actually run. If sync schema changed, notify device-build
  owners; updating or installing on devices still needs authorization.
- Retain integration reports/browser proof in `TASK_EVIDENCE`, then follow
  shared teardown. Include the next owner for any unfinished tree or
  deliberately retained trial.
- During a history-rewrite freeze nobody moves main. Afterwards, reconcile only
  the owned branch with
  `git -C "$TASK_SOURCE" rebase --onto origin/main <old-base> <owned-branch>`
  using the rewriter's old→new map.
