---
name: profiling-tessera-scale-fixtures
description: "Reproduces and profiles Tessera slowness in the library, reader pages, imports, writes, or sync size, from a few books on the Fold up to 1k–10k-book synthetic EPUB fixtures, when investigating performance problems."
---

# Profiling Tessera scale fixtures

Use this for large-library slowness and small-notebook reports such as "the
library feels sluggish on the Fold". First complete
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
and source its prepared environment.

## Quick triage (small notebook, sluggish UI)

- First split JS from native time. A CPU profile of the WebView
  (`tab.profileStart()`/`profileStop()`) that is mostly `(idle)` means the wait
  is in Rust or in a timer, not rendering.
- `window.__TAURI_INTERNALS__.invoke` is non-writable, so it can't be wrapped.
  Time endpoints directly:
  `invoke('notebook_request', {request:{method, path, headers:[['content-type','application/json']], body: btoa(json)|null}})`.
- Compare pinned release and debug only as an explicitly labeled diagnostic, on
  separate copies under `TASK_RUN/notebooks`. Copy matching executables into
  distinct run-local `bin` paths before serving; launch each via `task_run` with
  its own named service and owned HTTP/sync ports, and record actual origins.
  Only release results count as product timing acceptance. If release is slow
  too, it is the query, not the debug APK (`ts-android-build` makes a
  debug APK); profiling alone does not authorize building/installing on a
  physical device.
- `sample <recorded-owned-pid> 8 -file "$TASK_EVIDENCE/native-sample.txt"` while
  curling the owned origin in a loop; read the `tessera_core::...` frames
  (mangled `_RNv...12tessera_core13library_reads3toc`). Never sample/kill a
  process merely by a shared name or port assumption.
- Check the web side for timers. LibraryPane debounced even its first load by
  150 ms; it now debounces only once a result exists.
- 2026-10-11 case: `library_reads::toc` joined passages with
  `p.id = loc OR p.locator = loc OR p.anchor = loc` on `json_extract`. That
  scanned every passage per contents entry, and it runs for library rows,
  highlight rows, `source()` and every `passages()` page. A rewrite
  (materialized CTE plus a UNION ALL of indexed lookups, with anchors in one
  pass over `anchor IS NOT NULL`) took /api/library/query from 239 to 2.3 ms
  with byte-identical output (3fffdd8).
- To validate a SQL rewrite, run the old and new queries in python sqlite3
  against a read-only copy, check the rows match, and time both per snapshot.

## Fixture

- Generator prerequisite: the historical
  `/tmp/tess-calibre-scale-generator.py START END PORT [serial]` is not supplied
  or assumed to survive. Obtain a reviewed source artifact before using it,
  record its provenance and place the task-local copy under `TASK_RUN/tools`.
  The historical method is cited at
  `~/artifacts/tessera/calibre-scale-2026-10-10/calibre-scale-audit.md`;
  that citation is not a runnable generator. PIL is also a prerequisite. Its
  documented behavior uploads synthetic EPUBs to an owned service, with bulk
  uploads by default and per-job waits plus `serial_seconds` median/max in
  `serial` mode. If the source cannot be obtained, report the missing generator
  rather than invent/reimplement one during profiling.
- Build/stage release through the shared procedure: from `TASK_SOURCE`,
  `CARGO_TARGET_DIR="$TASK_TARGET" cargo build --release --locked --bin tessera`,
  then `cp "$TASK_TARGET/release/tessera" "$TASK_BIN"`. Debug builds distort
  timing.
- Fresh notebook:
  `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/scale" info`. For copied
  data use `/usr/bin/sqlite3` read-only `.backup` plus objects, verify the owned
  destination, strip only its copied `service.lock` and clear copied `sync_hub`
  before serving.
- If the slow path makes building 10k books impractical, add scratch indexes
  only to the owned fixture database first, e.g.
  `CREATE INDEX scratch_… ON field_values(entry_id)`. Drop them,
  `DROP TABLE IF EXISTS sqlite_stat1` and `PRAGMA wal_checkpoint(TRUNCATE)`
  before measuring so the schema is normal; record these mutations. On Mac use
  `/usr/bin/sqlite3`, not Android's PATH sqlite3.
- Serve as an exact named service:
  `task_run env RUST_LOG=warn "$TASK_BIN" --workshop "$TASK_RUN/notebooks/scale" serve --port <owned-free-http> --sync-port <owned-free-sync>`.
  Record actual ports/origin; `--sync-port 0` allocates an ephemeral listener
  rather than disabling sync. Bulk importing 10k books historically took about
  15 min. Stop the recorded service before copying the baseline into
  `$TASK_RUN/notebooks/base`; each attempt starts from its own stopped copy.
- Track the actual `subprocess.Popen` handle and pass the exact task-run
  environment. In bash, `cp … && bin serve &` backgrounds the whole chain, so
  `$!` is the wrong pid and the server outlives the script. Browser comparisons
  use the shared fresh-browser launch and retain their profiles/handles in
  `TASK_EVIDENCE`.

## Measure

1. Baseline, only after obtaining the generator prerequisite: run its reviewed
   task-local source via `task_run` for one serial import (documented arguments
   `10000 10001 <owned-http-port> serial`). At 10k books, before the fix in
   0864593, this took 73 s. Save output and exact inputs in `TASK_EVIDENCE`.
2. Find the hot path while it runs:
   `sample <recorded-owned-pid> 8 -file "$TASK_EVIDENCE/import-sample.txt"`,
   then read the `tessera_core` frames in the call graph.
3. For SQL: pull query text from source, then run `EXPLAIN QUERY PLAN` against a
   read-only copy of `$TASK_RUN/notebooks/base/notebook.db` (on Mac use
   `/usr/bin/sqlite3`; a compatible Python sqlite3 is usable for non-FTS
   queries). A `SCAN` inside a CORRELATED SUBQUERY is the bug. Do not time the
   old full query in `eval`: it can run for minutes and kill the kernel.
4. Fix in the owned writer checkout, rebuild serially and restage the release
   executable; stop the old consumer, create a fresh baseline copy and serve on
   the recorded owned ports. Run about 20 serial imports and retain/report
   median and max. Also time a related write through `POST /api/batches` on that
   origin (op names include `save_library_view`, `create_page`, `insert`,
   `edit_text`). Never reuse an already-mutated attempt as the baseline.

## SQLite fixes that worked

- Use `CROSS JOIN` to keep a small driving table as the outer loop.
- Split `OR` across columns into one `NOT EXISTS` per column, or one `UNION ALL`
  branch per column, each with its own index.
- Extract JSON once in a `MATERIALIZED` CTE instead of calling `json_extract`
  inside a join condition.
- Add indexes in a new migration, registered in `migrate.rs`. Add undo SQL for
  it in the 6 downgrade fixtures (tests/fields.rs, library.rs ×2,
  types_changes.rs ×3). A new table also needs a class in `replication.rs`.
- A JSON expression index is only used if the compared column's affinity is
  removed: `json_extract(...) = +b.id`.

## Integration and teardown

The integration owner runs workspace tests and `clippy` once after integration
(`--lib --bins` plus touched test targets; `tests/page_merge.rs` had a
historical `collapsible_if` error). Transfer scoped fixes through
`landing-lane-patches-around-dirty-peer-trees`; use
`shipping-tessera-live-builds` only for separately authorized landing/shipping.
Retain before/after numbers, samples and generator/binary/fixture provenance in
`TASK_EVIDENCE`, then follow shared teardown.
