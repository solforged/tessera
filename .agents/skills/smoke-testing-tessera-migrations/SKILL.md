---
name: smoke-testing-tessera-migrations
description: "Proves that an older notebook upgrades cleanly with the new binary before landing a Tessera core migration or stored-text rewrite."
---

# Smoke-testing Tessera migrations

Run when a branch adds `crates/tessera-core/migrations/NNN_*.sql`, a
`found < NNN` step in `migrate.rs`, or rewrites stored block text (tags,
references, card syntax). Unit tests fake the old schema; this exercises the
real upgrade on a notebook the shipped binary wrote.

## Shared lifecycle

Complete
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
and source its prepared environment. Keep old/new fixtures under
`TASK_RUN/notebooks` and retain versioned API snapshots, logs and binary
provenance in `TASK_EVIDENCE`.

## 1. Write the fixture with the shipped (old) binary

Resolve the last shipped release build at
`~/.cache/tessera/ship/target/release/tessera`, verify its build/schema and copy
it into `$TASK_RUN/bin/tessera-old`; the ship cache is persistent managed
infrastructure, not a task worktree. If it is absent or not the needed old
version, obtain the explicit previous release as below rather than assume it
exists.

```sh
task_run "$TASK_RUN/bin/tessera-old" --workshop "$TASK_RUN/notebooks/old" serve --port <owned-old-http> --sync-port <owned-old-sync>
```

Run this as an exact named service and record actual ports/origin.
`--sync-port 0` binds an ephemeral loopback listener, not disabled sync. Seed
only this private fixture through `POST /api/batches` with
`{"actor":{"kind":"person"},"operations":[...]}`; each operation carries
`"op": "create_page" | "insert" | "edit_text" | "add_type" ...` (`snake_case` of
`Operation` in `model.rs`). Cover every shape the migration touches: legacy and
bracket forms, a code-span shield, a manual membership (`add_type` is
title-addressed), a card (`front >> back`), a built-in tag (`#task`). Record ids
and requests in `TASK_EVIDENCE`. Stop the recorded server before copying to
`$TASK_RUN/notebooks/pristine-old`; retain a recoverable old fixture in
`TASK_EVIDENCE` before teardown.

## Previous release → new build

Use this fixture path before a release when the previous tagged binary is older
than the last shipped build, or when its CLI/API differs from the current seed
script.

- Old binary: download the explicitly chosen `vPREV` release's matching Darwin
  archive into `TASK_RUN/downloads` (for example
  `gh release download vPREV -p '*darwin*.tar.gz' --dir "$TASK_RUN/downloads/previous"`),
  record its tag, checksum and extracted executable path, and stage it at
  `$TASK_RUN/bin/tessera-old`.
- The current seed script fails on an older binary (service exits 2: it uses
  `--workshop`, newer routes). Select the old tag's script in an additional
  owned worktree through the shared procedure, preserving current policy
  context, then run its seed task with `task_run`, `TESSERA_BIN` set to the
  staged old executable and an explicit `$TASK_RUN/notebooks/old` destination.
  Old binaries take `--notebook`; follow that tag's actual CLI rather than
  applying current flags blindly, and record the additional tree in the resource
  ledger.
- Snapshot on the recorded old origin using routes that exist in both
  (`/api/index`, `/api/roots`, `/api/fields`, `/api/types`, `/api/entities`,
  `/api/decks`, `/api/revisits`, `/api/agenda/<date>`, `/api/task-views`,
  `/api/views`, `/api/projects`). Old builds may lack `/api/check`. Save
  responses under `TASK_EVIDENCE/old`.
- Stop the old service, copy the pristine fixture into
  `$TASK_RUN/notebooks/new`, verify that destination, strip only its copied
  `service.lock`, and clear any copied sync-hub attachment before opening it
  with the staged new release `TASK_BIN`. Log must list each new
  `migration applied version=N` once; `/api/check` must be ok with no stale
  derived rows or violations. Save/diff snapshots under `TASK_EVIDENCE/new` and
  explain every difference; perform one browser mutation (e.g. mark a task done)
  on this copy, then re-check. Use a task-run browser with its own
  profile/downloads and exact recorded handle, not a shared or live browser.
- Retain logs, API diffs, screenshots, browser profile, old fixture and binary
  provenance in `TASK_EVIDENCE`, then follow shared teardown; the managed ship
  cache is not disposable.

## 2. Open with the new binary

From `TASK_SOURCE` under normal host HOME, serialize the build and stage the
selected executable; build matching web assets into `TASK_DIST` from this owned
source when external assets are needed.

```sh
CARGO_TARGET_DIR="$TASK_TARGET" cargo build --release --locked -p tessera-cli
cp "$TASK_TARGET/release/tessera" "$TASK_BIN"
```

Then start a distinct named runtime service:
`task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/new" serve --port <owned-new-http> --sync-port <owned-new-sync> --assets "$TASK_DIST"`.
Log must show `migration applied version=NNN` once. Pin the build, both ports
and origin in `TASK_EVIDENCE`; never reuse the old server's directory while it
is running. Log must show `migration applied version=NNN` once.

## 3. Prove it

- `GET /api/check` → `ok: true`; no `invariants[].violations`, no `derived[]`
  row with `stale`/`missing` (`card_units` stale means rewritten sources need
  `card_store::derive_sources` in the migration; `search_blocks` stale means
  text changed without the triggers seeing it).
- Re-read every seeded block: text in the new canonical shape, revision
  unchanged (migrations write no change rows), `/api/blocks/<id>/capabilities`
  records intact.
- `/api/index`, `/api/tag-decks`, `/api/blocks/<id>/cards`: ids and counts
  unchanged.
- Browser pass on the page (pills/checkboxes/badges render); use the
  independently launched task-run browser and profile on the recorded new
  origin, then one mutation that depends on the new identity (e.g. rename the
  type page, confirm members' text and revision unchanged and pills follow).
  Keep the same origin/profile within a persistence check; do not attach to the
  user's browser.

Rerun from the stopped pristine old fixture after every fix, never from the
already migrated attempt. Retain the evidence and recoverable fixture before
stopping the exact consumers and applying shared teardown.

## 4. Before an authorized landing

Also run the independent bench model, which CI's "backend correctness and
scaling" job runs at 50k: build `tessera-bench` with `--release --locked` under
normal host HOME using the serialized `TASK_TARGET`, stage it into
`$TASK_RUN/bin/tessera-bench`, then run
`task_run "$TASK_RUN/bin/tessera-bench" --root "$TASK_RUN/notebooks/bench" --sizes 50000 --fail-on scaling`.
Any stored-text shape change needs `crates/tessera-bench/src/corpus.rs`
(generator text, `GENERATOR_VERSION`) and `measure.rs` (apply
`committed.text_rewrites` to the model) updated. Compare retained `MISS` lines
against an explicitly pinned `origin/main` baseline in a separate run; only new
misses matter. Migration QA alone does not authorize landing, shipping or device
installation.
