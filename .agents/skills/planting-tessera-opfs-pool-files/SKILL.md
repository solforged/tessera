---
name: planting-tessera-opfs-pool-files
description: "Seeds or inspects Tessera browser-build OPFS pool files from a page for upgrade-copy, staged-restore, or hot-journal smoke tests without wasm hooks."
---

# Planting and inspecting Tessera OPFS pool files

The browser build stores SQLite files in the sqlite-wasm-vfs SAH pool at
`.opfs-sahpool/.opaque/<random>`. Each slot is a 4096-byte header (UTF-8 logical
name NUL-terminated in bytes 0-511, u32 big-endian SQLite open flags at 512)
followed by the file payload. An empty name means a free slot.

## Shared lifecycle

Complete
[managing-tessera-task-workspaces](../managing-tessera-task-workspaces/SKILL.md)
and source its prepared environment. Build this checkout's demo assets into
`TASK_DIST` before launching the private OPFS browser context.

## Rules

- Plant or restore files only in the verified private profile and owned loopback
  origin from this run. Never attach to a user's browser, production demo or
  live notebook. Save the origin, profile, logical slot names and before/after
  bytes/checksums in `TASK_EVIDENCE`; keep the same origin/profile throughout
  persistence checks.
- Only touch slots while no worker holds the pool: navigate the tab to a static
  asset of the same origin (for example `/assets/<some>.css`) so the demo worker
  is gone, then use `navigator.storage.getDirectory()`.
- Reading is safe at any time via `handle.getFile().slice()`; occasional
  `NotReadableError` during an active save is a race, so skip that sample.
- To plant a file: pick a slot with empty name, write a header with the logical
  name and flags `0x100` (SQLITE_OPEN_MAIN_DB), then the payload, via
  `createWritable()`. Copy the payload from `/demo/notebook.db` (bytes
  from 4096) to fabricate a valid database.
- Iterate with `for await (const handle of opaque.values())` and
  `handle instanceof FileSystemFileHandle`; no `any` casts.

## Tessera names

- Live: `/demo/notebook.db` (+ `-journal`). Staged restore:
  `/demo-restore/notebook.db`. Upgrade copy:
  `/demo-upgrade-{schema}-{created_ms}-{bytes}.db`; Settings › Backups shows a
  "Before the last upgrade" row when one exists.
- Hot rollback journal payload starts `d9 d5 05 f9 20 a1 63 d7`; a zero header
  is a harmless leftover.

## Smoke harness

- Serve `TASK_DIST` from `TASK_SOURCE/web` with
  `task_run "$TASK_SOURCE/web/node_modules/.bin/vite" preview --mode demo --outDir "$TASK_DIST" --host 127.0.0.1 --port <owned-free-http> --strictPort`
  as a named service (never 4317/4318/4320/5173). The lockfile-installed Vite
  executable must exist before runtime; do not use `bunx` to install tools
  implicitly.
- Prerequisites are a compatible installed Chrome for Testing and the
  lockfile-installed `playwright-core` in this source; discover their actual
  paths, do not assume a versioned cache path exists. Launch the browser harness
  with `task_run`, a persistent context rooted at `$TASK_RUN/profiles/opfs`,
  `acceptDownloads: true` and a download path under `$TASK_RUN/downloads`. Use
  only that run's browser/context handles.
- Locate the Backups section with `section[id^="settings-backups-"]` (a
  role/heading filter also matches the pane section).
- After a restore Confirm, the page reloads into the restored notebook; it may
  reopen on Settings, so do not wait for `.outline-list`.
- Retain screenshots, downloaded backups, OPFS/profile state and the recorded
  preview/browser origin/handles in `TASK_EVIDENCE`, then follow shared
  teardown.
