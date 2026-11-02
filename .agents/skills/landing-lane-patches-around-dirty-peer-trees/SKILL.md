---
name: landing-lane-patches-around-dirty-peer-trees
description: Guides landing Tessera lane commits or patches through an owned integration checkout without changing peers' dirty trees; use for peer-overlap integration and git apply index conflicts.
---

# Landing lane patches around a dirty peer tree

Use when a lane patch overlaps another session's dirty files. Do not repair a
shared index or replay changes over those files. Transfer the lane's scoped
commits or patch to one owned integration checkout instead.

## Establish ownership and allocate

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to establish ownership, prepare the integration source/run and source its
environment. Keep the original dirty checkout outside the integration path.

Create a branch only in the selected tree:
`git -C "$TASK_SOURCE" switch -c "omp/$TASK_ID"`. Bind all subsequent Git
commands with `-C "$TASK_SOURCE"` and run build/land tools with that source as
their working directory. Never change a peer's index, refs, branch, or working
files.

## Transfer and integrate

1. Ask each peer for the exact base, scoped commit SHAs or patch, paths, checks
   and remaining work. Intercom `send` takes one session id in `to`; notify
   several peers individually. Do not collect unrelated dirty work into commits
   on the user's behalf.
2. Check upstream equivalence in the owned integration tree with
   `git -C "$TASK_SOURCE" cherry origin/main <peer-tip>`; patch-equivalent
   commits need not be replayed. Branch names may be stale, so use the
   handed-off SHAs.
3. Apply only the transferred work: `git -C "$TASK_SOURCE" cherry-pick -S <sha>`
   or `git -C "$TASK_SOURCE" apply --3way <absolute-lane-patch>`. Inspect the
   integration tree's index and commit explicit paths there. The original dirty
   checkout is not an integration target.
4. Resolve conflicts in that owned tree. For two lanes adding migrations, keep
   both `include_str!` entries in merge order and combine every downgrade
   fixture in `crates/tessera-core/tests/{fields,types_changes,library}.rs` so
   each later schema change is dropped. Preserve peers' newer neighboring
   documentation when it applies.
5. Install/build the integration tree and stage its matching
   `TASK_BIN`/`TASK_DIST` using the shared procedure; no dependency symlinks or
   shared-target cleaning.

## Verify the integrated work

Run the relevant checks once after the lane batch is integrated, not
concurrently in source-writing lanes. Use `TESSERA_TEST_BINARY="$TASK_BIN"` and
isolated runtime state for tests that start services. Smoke with
`task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/integration" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`
as a uniquely named service. Record readiness, actual listeners and
`/api/service` build identity. Old services retain their old schema and binary;
restart only services owned by this run after a rebuild and recopy.

- Seed a fresh notebook through `POST /api/batches`
  (`{actor:{kind:'person'},reason,idempotency_key:null,operations:[{op:'create_page',…},{op:'add_type',id,base_revision,title}]}`).
  Never mutate live notebooks or their registry for smoke tests.
- Detach permitted notebook copies using the shared consistent-backup,
  copied-lock and sync-attachment procedure before serving.
- `document.test.ts` has used port 4330. Allocate a supported private test port,
  or serialize with its recorded owner; a process name or port collision is not
  authority to kill it. For a deliberately private test-file adjustment, edit
  only the owned source and run the copied `TASK_BIN`.
- The acknowledged-structural-deltas offline-restore test has historically
  flaked (observed 2026-10-11). Record the actual failure and evidence; do not
  dismiss a current failure or treat a peer's reported failure as unverified.
- A 404 in web integration may mean the selected binary predates the route.
  Compare the recorded build before debugging client code.
- For offline/error UI, stop only the run's recorded service handle, switch tabs
  to force fresh reads, capture, restart the same owned service/origin and press
  Retry.
- Use the shared owned Chrome for Testing launcher/CDP procedure with
  `TASK_RUN/profiles/chrome`. Page JS belongs in `tab.evaluate`, not `tab.run`.
  The command palette uses `Control+Shift+P` with `>` prefilled; fill
  `.picker-input` with `>query`. Coarse-pointer emulation from
  `smoke-testing-tessera-library` is labeled browser simulation, not
  native-device acceptance.

## Land and hand off

Only when the user authorizes landing, follow
`landing-tessera-integration-handoffs` and `shipping-tessera-live-builds`:
fetch/rebase in the owned integration checkout and use `mise run land -- --wait`
there, with a batch title when needed. Never push main directly, reset a shared
tree, rewrite its refs, or publish peer ancestors unintentionally. Shipping
requires its own authorization and the landed SHA.

Retain integration proof and provenance in `TASK_EVIDENCE`, tell peers the
integrated SHAs and their next ownership action, then follow shared teardown.
Never reconcile a peer's checkout for it.
