---
name: shipping-tessera-live-builds
description: "Ships an explicitly authorized, landed Tessera commit to the installed app on :4318, with live-build ancestry checks, backup provenance and isolated QA copies."
---

# Shipping a Tessera pass to the live app

The user works in the installed app on http://127.0.0.1:4318. Since v0.2.0
(2026-10-08) that is `/Applications/Tessera.app` (bundle `dev.tessera.desktop`,
Tauri window `tessera-desktop` plus the `tessera` CLI inside), with launch agent
`dev.tessera.serve`. Resolve the current notebook through the service rather
than assume a historical workshop path. Shipping replaces the host app, backs
up/migrates the live notebook and restarts its agent: an audit/fix request alone
does not authorize those effects or device installation.

## Shared lifecycle and authorization

Complete
[managing-tessera-task-workspaces](../managing-tessera-task-workspaces/SKILL.md)
and source its prepared environment. It governs source ownership and private QA;
the authorized host ship itself stays outside `task_run`.

## When

Only after the exact landed SHA is on `origin/main` and the user has authorized
shipping that build to the installed host app. Obtain point-of-risk confirmation
if that exact effect/scope was not already authorized. Never ship implicit HEAD,
uncommitted work, a peer's unlanded ancestors or a still-running PR. Landing,
installing on replicas, publishing APKs and live content edits are separate
effects requiring their own authorization.

## Before EVERY ship

Record the exact SHA and inspect its ancestry/range against fetched
`origin/main` from the owned checkout, including one-line follow-ups. Shipping
includes every ancestor and migration. On 2026-10-12 a follow-up
`mise run ship HEAD` accidentally shipped a peer's three fresh commits (schema
36), refusing grok-bot (schema 35). Use an explicit full landed SHA and
coordinate the host ship with peers immediately before invoking it. Complete the
integration owner's required checks once on that exact integrated commit (tsc,
web tests with staged `TESSERA_TEST_BINARY` and isolated HOME/XDG, Vite build,
`cargo test --workspace`); do not turn every finder lane into a verifier.

## Never roll the Mac back

Several sessions ship to :4318. Immediately before the authorized ship, read
`http://127.0.0.1:4318/api/service`, retain its build/notebook identity in
`TASK_EVIDENCE`, fetch in the owned checkout and run
`git -C "$TASK_SOURCE" merge-base --is-ancestor <live-sha> <explicit-landed-sha>`.

- If your sha is already an ancestor of the live build, it is already live:
  don't ship.
- If the live build is NOT an ancestor of yours, locate it with
  `git -C "$TASK_SOURCE" branch -a --contains <live-sha>`. If it is a peer's
  unmerged integration branch (e.g. `omp/kh-int`, seen 2026-10-12), shipping
  would delete their unmerged work and possibly a newer schema from the Mac. Do
  not ship. Hand the exact SHA/ancestry evidence to that peer and the
  integration owner so both changes can land before a separately authorized
  forward ship; tell the user the blocker.
- If you receive "I'm shipping X" from a peer and the live build already
  contains X, tell them to stop.

## Diverged local main or peer work

Use the shared integration procedure to select an owned tree and apply only
scoped handoffs agreed with the owning peers; silence grants no ownership.
Preserve both sides' intent in conflicts rather than treating every CHANGELOG
conflict as additive across release boundaries, and report new SHAs without
changing peers' trees.

## Land a change on main

The ruleset `reviewed` requires a pull request for main; only deploy keys bypass
it, and only the fast-forward workflow holds the write key (`FAST_FORWARD_KEY`).
The ruleset `green` requires signed commits, linear history and seven checks:
`rust (ubuntu-latest)`, `rust (macos-latest)`, `browser wasm build`,
`backend correctness and scaling`, `web`, `android app`,
`embedded release assets`. Never push main or use a squash or rebase merge. See
`docs/releasing.md`, "Land a change on main".

1. In the clean owned integration tree, fetch and rebase onto fetched
   `origin/main`, binding Git commands to `TASK_SOURCE` as required by the
   shared procedure.
2. Issues are optional: open one only for work that outlives the session or
   needs tracking, then pass `--issue N`. Web, docs or Markdown-only PRs skip
   the Rust, wasm and bench steps in CI, so they land in about 4 minutes instead
   of 10–15.
3. For one new commit, `mise run land` uses its subject as the PR title.
   Otherwise, from the owned integration source use
   `mise run land -- --title "type(scope): summary" [--issue N] [--wait] [branch]`.
   It pushes that tree's HEAD to `omp/<short sha>` or the named branch and opens
   a PR labelled `fast-forward`. CI runs only for pull requests; a bare branch
   push runs nothing (`gh workflow run ci.yml --ref <branch>` runs it by hand).
4. `.github/workflows/fast-forward.yml` moves main to exactly the head SHA after
   CI passes, preserves SHAs and signatures, deletes the branch and dispatches
   the demo deploy. `--wait` blocks until main is at HEAD (~10–15 min) and fails
   if a required check fails or main moves.
5. If main moves before CI finishes, the workflow comments instead of landing.
   The integration owner rebases its clean branch onto fetched `origin/main` and
   reruns land with the same branch name; honour peers' hold requests.
6. After landing, preserve integration provenance and follow shared teardown for
   manually owned worktrees/branches. Ship only the explicitly authorized landed
   SHA, never while its PR is pending. Demo deploy failures open or update one
   issue labelled `demo-deploy`; the next good deploy closes it. A rollback
   workflow (`gh workflow run demo.yml --ref main -f ref=<commit>`) changes a
   public deployment and needs explicit authorization; it is not an automatic QA
   cleanup step.

## Steps

1. From the selected owned host checkout, run
   `mise run ship <explicit-full-landed-sha>` under normal host HOME, not
   `task_run`. It builds in managed persistent `~/.cache/tessera/ship` (~45 s
   warm), quits Tessera.app if open, replaces it, then runs `tessera install`,
   which backs up the notebook and restarts the agent. This is the explicitly
   authorized host effect; never allocate/delete/re-home that managed cache as
   an agent task worktree.
2. Expect `ship: <sha> is live at http://127.0.0.1:4318`. Exit 0 also when
   already live.
3. Confirm: `curl -s http://127.0.0.1:4318/api/service` shows `"build":"<sha>"`,
   and `/api/notebook` shows `schema_version`.
4. If the shipped SHA changed schema, replicas (Fold, grok-bot) are refused with
   schema_mismatch until updated. Report that compatibility consequence and
   notify the appropriate sessions; do not install/publish a device build
   without separate authorization (see `distributing-tessera-android-apks`).
5. Retain/report the shipped short/full commit, actual service/notebook/schema
   identity and persistent host backup path in `TASK_EVIDENCE`. Record any
   intentionally retained services/handoffs.

## Throwaway smoke notebook

The ship's persistent backup (`~/.local/share/tessera/backups/<id>/<timestamp>`)
is a complete notebook, not disposable scratch. Copy it to
`$TASK_RUN/notebooks/ship-smoke` using the shared copied-lock/sync-detachment
safeguards; stage the matching shipped release at `TASK_BIN`, then start
`task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/ship-smoke" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`
(or embedded assets). Use the shared fresh-browser launch, retain smoke
screenshots/logs and backup/build provenance in `TASK_EVIDENCE`, then follow
shared teardown without deleting the host backup.

## On failure

`tessera install` restores the pre-ship backup and previous build if the new one
does not answer; the task then puts the previous app back. Read the actual host
serve log (`~/.local/state/tessera/logs/serve.log` for the default host layout),
retain relevant evidence privately, fix forward and re-run
ancestry/authorization checks before shipping again. Never hand-edit the live
notebook or bypass a failed install by deleting its backup/state.

## Do not

- Test against :4318 or a live notebook/registry. Shared dev :4320 and
  `.tessera/dev` are not default QA state either; all checks use prepared
  private copies, run-specific profiles and owned ports.
- Delete `~/.cache/tessera/ship` casually (it holds the warm release target);
  `git worktree list` shows it detached on purpose.
- Run `launchctl bootstrap` right after `bootout` yourself; `tessera install`
  waits for the old job to exit (EIO 5 otherwise).
