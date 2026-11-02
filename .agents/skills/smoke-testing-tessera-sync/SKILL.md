---
name: smoke-testing-tessera-sync
description: "Smoke-tests Tessera device sync (hub service plus CLI replica) on a copy of the live notebook after changes to core, service, or CLI sync code."
---

# Smoke-testing Tessera sync (hub service + CLI replica)

Use after changing `crates/tessera-core/src/sync*.rs`,
`crates/tessera-service/src/sync.rs` or `crates/tessera-cli/src/sync.rs`. Unit
tests in `crates/tessera-core/tests/sync.rs` use fresh notebooks. They miss
paths that only a real notebook hits: an existing Book type, fields and authors
make a duplicate import collapse to an empty batch. Always run this smoke test
as well.

## Shared lifecycle and setup (sequential)

Complete
[managing-tessera-task-workspaces](../managing-tessera-task-workspaces/SKILL.md)
and source its prepared environment. Build/stage `tessera-cli` through its
release-build procedure before running the hub/replica commands.

Resolve the requested source notebook or backup read-only. For an online copy,
first `mkdir "$TASK_RUN/notebooks/hub"`, then
`/usr/bin/sqlite3 "file:<source>/notebook.db?mode=ro" ".backup \"$TASK_RUN/notebooks/hub/notebook.db\""`
plus objects; alternatively restore an explicit backup with
`task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/hub" restore <backup>`.
Apply the shared copied-lock/sync-detachment safeguards so the QA hub cannot
reconnect to a real hub. Never write the live notebook/registry or run
Sharing/Pair against host Tailscale.

Start the private hub only after the copy/restore completes, as an exact named
service:
`task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/hub" serve --port <owned-hub-http> --sync-port <owned-hub-sync>`.
Record actual ports/origin, build and notebook provenance in `TASK_EVIDENCE`;
`--sync-port 0` allocates an ephemeral loopback listener, not disabled sync.
Avoid 4318 (installed app), 4320 (shared dev) and 4330 (web tests).

## Replica

```sh
task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/phone" sync clone <recorded-hub-origin>
task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/phone" sync  # JSON SyncReport
```

- To edit the replica offline, serve only that private copy via `task_run`, with
  distinct owned HTTP/sync ports and an exact named handle, edit through
  `POST /api/batches`, then **stop that service before `sync`**. The CLI holds
  `service.lock` and refuses while a service owns the directory. Record each
  origin/port and stop transition, never kill a PID guessed by port/name alone.
- Real book import:
  `task_run "$TASK_BIN" --workshop <owned-notebook> add "$TASK_SOURCE/web/src/demo/meditations.epub" --wait`
  against the running private service on each side.
- Reading position: `POST /api/snapshots/{id}/position {"ordinal": N}`.
  Passages: `GET /api/snapshots/{id}/passages?from=N&limit=1`.
- Pin a source:
  `task_run "$TASK_BIN" --workshop <owned-notebook> sync pin <source-id>`. Other
  commands: `sync status`, `sync conflicts`, `sync pins`, always with the
  explicit owned workshop and task-run environment.

## Checks

- Every push outcome is `accepted`, unless a rejection is the point of the test.
  For a rejected push, read `sync_conflicts.error`/`batch` on the hub.
- Convergence: compare every table except Local ones (`replica`, `sync_*`,
  `change_patches`, `ingest_jobs`, `agent_changes`), Indexed ones (`*_fts`,
  `search_blocks`) and `browser_objects`. Ignore `rowid`, `sync_seq` and
  `snapshots.created_at`. Work against stopped/read-only private copies. Python
  sqlite3 can compare non-FTS rows; use `/usr/bin/sqlite3` on Mac or the
  service/core for FTS, never Android's PATH sqlite3 against an active notebook.
- Files: objects live at `<nb>/objects/<sha[0..2]>/<sha[2..]>`. Deleting one on
  a replica and requesting `/api/snapshots/{id}/resources/{href}` from that
  replica's service must fetch it from the hub and keep it.
- The hub prunes `change_patches` once every replica has acknowledged them, and
  a second `sync` returns zeros.

## Cleanup

Retain sync reports/conflicts, convergence diffs, object-fetch evidence and
fixture/build provenance in `TASK_EVIDENCE`, then follow shared teardown.
Optional browser checks use the shared fresh-browser launch with separate
hub/replica profiles and recorded origins.

## Gotchas

- A new migration means updating the six schema-downgrade fixtures in
  `tests/fields.rs`, `tests/library.rs` and `tests/types_changes.rs`. Each must
  undo the new migration's tables, columns, indexes and triggers before setting
  `user_version`.
- In a changeset conflict callback, never call `ChangesetItem::op()` for
  `SQLITE_CHANGESET_FOREIGN_KEY`; it segfaults in rusqlite 0.40.
- To prove a regression test works, add a temporary env-var toggle that reverts
  the fix, run with it set to see the test fail, then remove the toggle.
