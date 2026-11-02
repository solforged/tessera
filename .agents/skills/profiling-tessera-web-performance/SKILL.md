---
name: profiling-tessera-web-performance
description: "Profiles Tessera web client performance on a large notebook in headless Chromium when measuring or fixing page open, typing, Enter/Tab, scroll, table, or journal slowness."
---

# Profiling Tessera web performance

## Shared lifecycle, corpus and service

Complete
[managing-tessera-task-workspaces](../managing-tessera-task-workspaces/SKILL.md)
and source its prepared environment. This timing procedure requires release
binaries; retain measurements, profiles/traces and build/fixture provenance in
`TASK_EVIDENCE`.

1. Build `tessera-bench` with `--release --locked` into `TASK_TARGET` under
   normal host HOME, stage it at `$TASK_RUN/bin/tessera-bench`, then
   `task_run "$TASK_RUN/bin/tessera-bench" --root "$TASK_RUN/notebooks/bench" --sizes 50000 --runs 20`
   (needs at least 20 runs, historically about 80 s). Retain its server-miss
   report in `TASK_EVIDENCE`.
2. After corpus generation stops, copy
   `$TASK_RUN/notebooks/bench/corpus-50000-42` into `$TASK_RUN/notebooks/perf`.
   Verify the owned destination, remove only copied `service.lock`, and clear
   copied `sync_hub` before serving. Pages: "Page 00002" has 10k rows, "Page
   00001" 2k, and "Page 00000" is a type with about 42k members. Never write
   live notebooks/registry for performance QA.
3. Build `tessera-cli` with `--release --locked` under normal host HOME,
   serialize/stage `"$TASK_TARGET/release/tessera"` as `TASK_BIN`, then start
   `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/perf" serve --assets "$TASK_DIST" --port <owned-free-http> --sync-port <owned-free-sync>`
   as an exact named service. Record actual ports/origin and build;
   `--sync-port 0` is an ephemeral listener, not disabled sync. Never use live
   :4318 or shared dev :4320. Stop only the recorded old consumer before
   replacing a notebook/server.
4. For readable CPU profiles, from `TASK_SOURCE/web` under normal host HOME run
   `"$TASK_SOURCE/web/node_modules/.bin/vite" build --minify false --outDir "$TASK_DIST" --emptyOutDir`.
   Record the readable-asset build separately from production-minified timings.
5. Seed tasks/cards on the private origin through POST `/api/batches` (`Origin`
   equals its recorded origin). Read ids/revisions on a stopped/read-only copy
   with `/usr/bin/sqlite3` on Mac; the PATH sqlite3 may be Android's
   incompatible build. Use `set_task` ops for tasks and `edit_text` with `>>`
   for cards, 250 ops per batch. Do not exercise Sharing/Pair against host
   Tailscale.

## Browser harness (omp eval, headless)

- Use the shared fresh-browser launch with `$TASK_RUN/profiles/perf`, attach to
  the recorded CDP endpoint and emulate 1400x900. Keep the same origin/profile
  within each persistence check.
- Install page globals through
  `tab.run(async ({page}, h) => page.evaluate(h), {args:[str]})`. `tab.evaluate`
  strings and `addInitScript` did not leave `window.*` helpers callable later.
  Reinstall after every `goto`.
- Helpers to install: a longtask PerformanceObserver pushing into
  `window.__long`, and `window.__waitFor(pred)`, a MutationObserver that
  resolves two rAFs after `pred()` is true. Navigate with Ctrl+Shift+F, type the
  title, then press Enter.
- Event latency: a PerformanceObserver for `event` with `durationThreshold:16`.
  Compare keydown `dur`/`proc` for 8×Enter and 4×Tab/Shift-Tab on the 10k page.
- Scrolling: record rAF deltas while sending 120 wheel events of 600 px each,
  then report p50, p95 and max.
- Profiling: `tab.profileStart()`/`profileStop()` return a .cpuprofile path;
  copy it into `TASK_EVIDENCE` before teardown. Sum self/inclusive time per
  `functionName:line` and filter Solid internals (runComputation, readSignal,
  …). `traceStart`/`traceStop` give JSON traces; retain them in `TASK_EVIDENCE`,
  where Layout, UpdateLayoutTree and MinorGC events show layout cost. Save
  browser profile, fixture/base/binary/assets and exact action inputs with
  before/after numbers.

## Known hotspots and their fixes

- Navigation: keep released docs warm in the Notebook (`WARM_DOCUMENTS`).
  `cachePage` once per view. After merge, `refreshPending` covers only the
  pending, conflicted and resolving ids.
- Visible rows: the archived flags live in a raw Set plus `archivedVersion()`,
  and `OutlineIndex.each` walks without copying. Scan field entries only against
  defined fields.
- Memos fed by `api.fields()` or `api.type()` refetch on every `changeSequence`,
  so give them `equals`. Otherwise the editor reconfigures and Enter rebuilds
  rows.
- TanStack virtual: use a constant `estimateSize` equal to the row height. A
  per-index estimate that reads stores makes Enter slower.
- Measure scroll anchors (`getBoundingClientRect`) on scroll settle, not every
  frame. Debounce localStorage writes off the input path.
- Tables: batch clamp measurements (all reads, then all writes) and shape a
  preview capped at about 400 characters. The table is still not windowed, and
  the server query takes about 270 ms at 42k members.
- Long lists: `content-visibility: auto` plus `contain-intrinsic-size`, with
  inset focus rings (`outline-offset: -2px`). Cap journal agenda groups.

## Gotchas

- `notebook.lookup` uses `this`. Pass `id => notebook.lookup(id)`, never the
  bare method, or completion hangs on "Searching…".
- Route scoped fixes through the shared integration-owner procedure; profiling
  alone does not authorize landing/shipping/device installation.
- Retain before/after numbers, profiles/traces and fixture/build provenance in
  `TASK_EVIDENCE`, update `docs/performance.md` for an authorized permanent fix
  and follow shared teardown.
