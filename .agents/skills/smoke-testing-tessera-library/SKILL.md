---
name: smoke-testing-tessera-library
description: "Smoke-tests Tessera library, reader, highlight, triage and export changes in the browser on a throwaway notebook with real EPUBs and an article; use for end-to-end reading flows and empty or edge-state passes."
---

# Smoke-testing the Tessera library

Proves stage-5 flows (ingest → read → highlight → note/card → review → triage →
export, shelf, Continue reading) in the running app. Never use ports
4317/4318/4320/5173 or `.tessera/dev`.

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source the library smoke's workspace and run.

The clickaround notebook and named Calibre edge-case books below are external
prerequisites; report missing coverage if unavailable rather than inventing
replacements.

## Seed

```sh
CARGO_TARGET_DIR="$TASK_TARGET" cargo build --manifest-path "$TASK_SOURCE/Cargo.toml" --locked -q -p tessera-cli
cp "$TASK_TARGET/debug/tessera" "$TASK_BIN"  # serialize build+copy; later shared-target builds cannot replace this run binary
bun install --cwd "$TASK_SOURCE/web" --frozen-lockfile
(cd "$TASK_SOURCE/web" && bunx tsc --noEmit && bunx vite build --outDir "$TASK_DIST" --emptyOutDir)
task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/library" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"  # unique named service; verify readiness
task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/library" add --wait <permitted-files…>
```

- `serve` also binds a sync listener at port+1 by default; peers may own it.
  Allocate HTTP and sync independently and record the actual listeners and
  origin. `--sync-port 0` is an ephemeral listener, not disabled sync.
- An owned worktree's install can be broken (blank page, ResizeObserver
  `parameter 1 is not of type 'Element'`). Inspect `tab.errors()` and reinstall
  its own lockfile dependencies rather than modifying another checkout. Aborted
  `/api/...` requests after navigation are noise, not proof of a bundle failure.
- Seeded data prerequisite: a permitted
  `~/.local/share/tessera/workshops/clickaround` copy has Reading/Inbox/Finished
  sources, 3 highlights, 2 collections and saved view `Not started`. Use
  `/usr/bin/sqlite3` online backup plus its objects directory into a fresh
  `TASK_RUN/notebooks` child, not bare copying a running database. Remove
  `service.lock` only if copied into that verified owned destination, and run
  `DELETE FROM sync_hub;` only on the current-schema copy before serving. Never
  reseed or browse the persistent original for QA.
- ~/Calibre Library has ~50 EPUBs
  (`glob /Users/admin/Calibre Library/*/*/*.epub`). Anatomy of the State
  (malformed spine) fails on purpose: use it for failed-job rows.
- Metadata edge cases: Higher Education in the Digital Age (packed
  `Bowen, William G., Guthrie, Kevin M.`), Origins of the Kabbalah (`A; B; B`),
  The Burgundians / European Empires (trailing `;`), Histoire de la Gaule and
  One Nation Under Blackmail (Calibre null date `0101-01-01`), Roll, Jordan,
  Roll (no cover → spine), Ellen Meiksins Wood ×2 + Alan Woods and Marx ×2
  (siglum collisions).
- Reading positions without the reader:
  `POST /api/snapshots/<snapshot_id>/position {"ordinal":N}`. Snapshot id is
  `row.source.current_snapshot_id` from `POST /api/library/query`.
- Web-only changes: rebuild only this run's `TASK_DIST` and reload its tab.
  After a Rust rebuild, copy the matching binary back into `TASK_BIN` and
  restart only the run-owned service; preserve the same origin/profile for
  persistence checks.

## Browser (`eval` `browser`)

- Use the shared owned Chrome for Testing launcher/CDP procedure with
  `TASK_RUN/profiles/desktop` and `--headless=new --hide-scrollbars`, then
  `t.emulate({viewport:{width:1440,height:900}})`. Give the phone pass a
  separate launcher/profile; retain exact launcher handles.
- `browser.open({ url, name, app })` takes one options object. `t.back()` can
  leave the app; use `t.goto(url)`.
- Screenshots: `t.screenshot({format:'png', silent:true})` → retain in
  `TASK_EVIDENCE` with base/build/seed, browser engine, viewport, origin and
  actual ports. Keep selected profiles/traces/logs there before runtime cleanup.
- Real pointer input: `t.clickAt(x, y)`; long press
  `t.mouseMove(x,y); t.mouseDown(); sleep 700; t.mouseUp()`. DOM `.click()`
  skips pointer handlers (long-press, capture-phase toggles).
- DOM: open Library via the button whose text starts with `Library`; tabs
  `.pane.active [data-library-tab="inbox|reading|all|finished|abandoned|collections|highlights"]`;
  rows `[data-library-row]`; checkboxes `.library-checkbox`; layout
  `[aria-label="List"|"Shelf"]`; sort `.library-sort` then `.popup .menu-item`
  by text (Group section: None/Author/Year/Decade/Publisher/Language); highlight
  filters `.library-highlight-filters`; overflow menu `.library-tabs-more`;
  phone Select `.library-select-toggle`.
- Highlight without UI: open source → Read, select a text node range inside
  `.reader-passage`, `t.press('h')`.
- Phone cover layout:
  `emulate({viewport:{width:412,height:900,deviceScaleFactor:2,isMobile:true,hasTouch:true}})`;
  `t.addInitScript` wrapping `window.matchMedia` to rewrite
  `(pointer: coarse)`/`(hover: none)` → `(min-width: 0px)` and
  `(pointer: fine)`/`(hover: hover)` → `(max-width: 0px)`; after each navigation
  rewrite `CSSMediaRule.media.mediaText` the same way. Navigate via
  `.bottom-nav button`. Phone search/controls hide until the heading's Search
  button is pressed.

## Edge-state pass checklist

Empty notebook and seeded copy, at 1440, 760 and 412: every tab empty and
populated; search no-match; empty collection and the Collections index;
Highlights with zero highlights, with highlights, and with a zero-match color
filter (filter sheet footer); failed import rows; Shelf grouped by year and by
language; inspector open; saved view chosen while it sits in More. Measure left
edges with `getBoundingClientRect` (tabs, controls, main, empty message, column
heads vs row cells) and visible strip children
(`getComputedStyle(c).display !== 'none'`) instead of eyeballing.

## API checks

- `POST /api/library/query {"states":["reading"],"sort":"last_read","direction":"desc","limit":3}`.
- `POST /api/highlights/query {"unprocessed":true,"limit":0}` → `total`.
- `GET /api/library/export?format=bibtex&ids=<id>`.

## Finish

- In the owned integration source, run the requested `mise run lint` and web
  tests through isolated runtime where appropriate: with tool
  `cwd: TASK_SOURCE/web`,
  `task_run env TESSERA_TEST_BINARY="$TASK_BIN" TESSERA_TEST_PORT=<owned-free-test-port> bun run test`.
  Inspect actual timeout/binary/port evidence; rebuild and recopy only if the
  selected binary is stale, and do not kill an unowned test listener or dismiss
  a reported failure as a flake.
- Commit explicit paths in the owned source with
  `git -C "$TASK_SOURCE" add <paths>` and the applicable ≤72-character commit
  header/body rules. Landing is separate authorization: use
  `mise run land -- [--issue N] --wait <owned-branch>` with tool
  `cwd: TASK_SOURCE` only when requested. Never push main or squash/rebase
  merge.
- Ship only when separately authorized and the SHA has landed; scope the
  ancestry check as
  `git -C "$TASK_SOURCE" merge-base --is-ancestor <live-build> <landed-sha>`
  (live build from `curl -s 127.0.0.1:4318/api/service`), then follow
  `shipping-tessera-live-builds`. Library smoke is not authority for live writes
  or device updates.
- Retain proof in `TASK_EVIDENCE` and follow shared teardown for the exact
  browser/service handles. Explicitly hand off intentionally retained trials
  instead of deleting their notebook/assets/profile.
