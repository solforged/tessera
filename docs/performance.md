# Performance

The goal is that ordinary use never drops a frame on the owner's machines: typing, scrolling, folding, moving blocks and switching pages, on workshops of 50,000 blocks or more. No design can promise that on all hardware, so Tessera sets budgets, measures them on named devices and treats a missed budget as a bug.

## Budgets

Measured on 50,000-block workshops with 2,000- and 10,000-row pages, mixed heights and two panes open.

| Surface | 120 Hz display | 60 Hz display |
|---|---|---|
| Frame interval | 8.33 ms | 16.67 ms |
| Application work per frame, p99 | 6 ms | 12 ms |
| Keystroke to presented frame, p95 | 16 ms | 33 ms |
| Structural edit (Enter, Tab, move) to presented frame, p95 | 16 ms | 33 ms |

| Operation | Budget |
|---|---|
| Page navigation to a usable viewport | warm p95 100 ms; cold 500 ms |
| Reference completion query | p95 25 ms |
| Full-text search query | p95 50 ms; visible results 100 ms |
| Small operation commit, round trip | p95 50 ms |
| Change visible in another window | p95 100 ms |

Rules that follow from the budgets:

- Typing never waits on the network, the service or SQLite.
- No per-keystroke work is proportional to page size or workshop size.
- No synchronous storage write on the input path.
- Undo history and drafts grow with the number of edits, not with page size times edits.

## Baseline from the prototype

The prototype was measured on an Apple M5 Max in headless Chrome 151 with a 52,000-block workshop.

| Scenario | Result |
|---|---|
| Typing on a 300-block page | p95 9.7 ms |
| Typing on a 2,000-block page | p50 28 ms, p95 33 ms |
| Structural edit on a 2,000-block page | p50 56 ms, p95 68 ms |
| Scrolling 18,700 rendered DOM nodes | no frame over 8.4 ms |
| Loading a 2,000-block page | 2.6 s for the API response; 2.6 to 2.9 s to first paint |
| Autosaving a 2,000-block page | 9.5 s |
| Reference completion at 50k blocks | 57 ms median |
| Context assembly at 50k blocks | 245 ms median |
| Browser draft storage | quota exceeded after 30 edits on the big page |

What this shows:

- **Rendering is not the limit.** The browser scrolled a fully rendered 2,000-block page within a 120 Hz budget. Virtualization is for memory and load time.
- **Work per edit is.** Typing cost grew with page size because each key re-rendered and reserialized the whole page.
- **Backend load and save were the worst offenders,** at about 1.3 ms per block.
- **Search and completion scanned** and grew linearly with workshop size.

## Spike 1 result: backend operations

Spike 1 passed on 2026-10-01: Apple M5 Max, release build, SQLite 3.53.2, 50,000-block workshop, 31 runs per measurement. Each measured read was checked against the generator's own model.

| Operation | Core p95 | HTTP p95 | Budget |
|---|---|---|---|
| Loading a 2,000-block page, fresh connection | 2.7 ms | 6.7 ms | 500 ms |
| Loading a 10,000-block page, fresh connection | 16 ms | 34 ms | 500 ms |
| Loading a 10,000-block page again | 14 ms | 33 ms | 100 ms |
| Reference completion, common word | 13 ms | 13 ms | 25 ms |
| Full-text search, common word | 13 ms | 13 ms | 50 ms |
| Single-block commit on a 10,000-block page | 0.2 to 2.4 ms | 0.5 to 2.7 ms | 50 ms |

Commits cost the same on a 10,000-block page as on a 100-block page, so no operation does work per unchanged row. Delete and restore are the slowest at about 2 ms. The prototype took 2.6 s to load a 2,000-block page and 9.5 s to save one; the difference is set-based reads and single-block operations instead of whole-page saves.

Risk: completion and search for a word that appears in thousands of blocks cost about 13 ms here and 36 to 46 ms on a shared CI runner. Their cost grows with the number of matches, so slower machines may miss the 25 ms completion budget.

## Spike 2 result: editor

The editor comparison measured three variants of the same outline editor: React with one CodeMirror per pane, Solid with the same design, and one ProseMirror document. A runner drove them in headless Chrome with real keyboard and IME input, at 2,000 and 10,000 fully mounted rows. The retired [spike workspace](https://github.com/solforged/tessera/tree/1f5f12b582659468a361c4d916eed7dc7971b738/spikes/editor) and [full results](https://github.com/solforged/tessera/blob/1f5f12b582659468a361c4d916eed7dc7971b738/spikes/editor/results/summary.md) remain available at the original comparison commit.

| Variant | Correctness scenarios | Typing, handler p99 | Structural edit, handler p99 at 10,000 rows |
|---|---|---|---|
| React + CodeMirror | 11 of 11 | 0.2 ms | 0.2 to 23 ms |
| Solid + CodeMirror | 11 of 11 | 0.2 ms | 0.2 to 10 ms |
| ProseMirror | 9 of 11; both failures are Vim | 0.1 ms | 12 to 18 ms |

What it settled:

- **CodeMirror per pane, not one ProseMirror document.** ProseMirror matched the others on everything except Vim, and no usable ProseMirror Vim mode exists. CodeMirror's Vim extension passed every Vim scenario.
- **Outline commands are cheap once indexed.** An indexed sequence shared by both CodeMirror variants made indent, outdent and move independent of page size.
- **Solid over React.** React's list reconciliation added about 7 ms per structural edit at 10,000 rows; Solid's about 1 ms. Both were correct. The owner chose Solid.

What it left to spike 3:

- **No variant meets the frame budgets with 10,000 rows mounted.** At 10,000 rows, browser style, layout and paint cost about 22 ms per Enter in every variant. That is mounted DOM size, which windowing bounds.
- Headless paint timing is a proxy. Two panes, real presentation traces and service round trips were not measured.

## Client pass, 2026-10-06

Measured on an Apple M5 Max in headless Chrome 150 against a release service and the 50,000-block bench workshop, with 1,500 seeded tasks. Times run from the key or click to two frames after the target rows render.

| Scenario | Before | After |
|---|---|---|
| Reopen the 10,000-row page | 600 to 980 ms, one 620 to 750 ms task | 95 to 140 ms |
| Reopen the 2,000-row page | 100 to 255 ms | 60 to 80 ms |
| Enter on the 10,000-row page, handler time | 37 to 43 ms | 17 to 24 ms |
| Tab on the 10,000-row page, handler time | 20 to 23 ms | 12 to 13 ms |
| Scrolling the 10,000-row page, frame p95 / max | 25 / 92 ms | 18 / 42 ms |
| Opening a 41,922-member table at its 500-row limit | 1,080 ms, one 540 ms layout | 730 to 870 ms, one 150 ms task |
| A journal with 501 overdue tasks | 700 ms, 5,554 nodes | 130 ms, 312 nodes |
| Startup bundle | 884 kB, 270 kB gzipped | 585 kB, 179 kB gzipped |

What changed: released pages stay warm for back and forward; a merge caches its view once and refreshes only the cells that differ; the visible-row walk reads archive flags from one set instead of a store per row; field definitions keep their identity across the refetch after every commit, so the editor is not reconfigured; rows estimate their height at the row height; card parsing skips text with no card syntax; table cells measure in one batch and shape only a preview; navigation persists off the input path; scroll anchors are measured once scrolling settles; secondary panes and Vim load on demand.

Remaining: the table's server query costs about 270 ms at 42,000 members, with the type count queued behind it, and the table renders its 500 rows without windowing. Enter on a 10,000-row page still re-walks the outline once.

## Client pass, 2026-10-11

Measured in headless Brave against a release service and the 10,000-block bench workshop (60 pages, an 8,474-member type).

| Scenario | Before | After |
|---|---|---|
| Open Find, requests for page icons | 124 capability reads | none; one Sources index read per session |
| Type `Page 00000` into Find | 126 capability reads queued with the search | none |
| A 5,792-character tagged block in a type table | 705 px tall | 57 px, three lines |
| Open Unfiled | two index reads, 300 ms apart | one |

On the 50,000-block workshop the same Find opened with 384 rows sent 351 to 866 capability reads, which held `/api/search` back by about 5 s. Page icons now read source formats from one shared Sources index, reloaded only when a change adds, removes or reformats a source page.

A cold window has since read `/api/changes/head` first and subscribed from that cursor, with each cached page carrying its own replay floor, so launch no longer replays the journal from sequence 0.

## Change reads, 2026-10-22

`changes_since` joined every event's `committed` receipt against its revision rows before sorting, so SQLite's temporary sort carried each receipt once per revision: 503 kB of receipts became 122 MB of sort input on the 10,000-block workshop. The read now fetches event metadata in one query and revision and block rows in a second, keyed by the collected events, and keeps both orders. HTTP `/api/changes` and WebSocket catch-up now page 500 events, matching the client; each WebSocket message still carries one event.

| Probe, 100 events | Before, core / HTTP p95 | After, core / HTTP p95 |
|---|---|---|
| 10,000 blocks, from 0 | 199 / 216 ms | 33 / 53 ms |
| 10,000 blocks, from the midpoint | 99 / 93 ms | 17 / 26 ms |
| 50,000 blocks, from 0 | 413 / 439 ms | 59 / 81 ms |
| 50,000 blocks, from the midpoint | 417 / 444 ms | 57 / 82 ms |

Twenty release runs each; the end probes stay under 1 ms. Remaining: `complete:cobalt` at 50,000 blocks measures 35 ms in core and 41 ms over HTTP against the 25 ms completion budget, the risk noted under spike 1.

## Spikes that decide the stack

Each runs before the matching feature is built. Each can overturn a choice in [architecture](architecture.md).

1. **Backend operations.** Load 2,000 and 10,000-block pages and commit single-block operations. Pass: cold viewport under 500 ms, commit under 50 ms, no per-row work for unchanged rows.
2. **Editor.** React with one CodeMirror per pane, against Solid with the same design and against one ProseMirror document. Pass: frame budgets, plus zero wrong outcomes for IME, Vim, undo and cross-block selection.
3. **Windowing.** 10,000 mixed-height rows with folding and long scrolls, in the Solid editor. Pass: bounded mounted rows, at most 2 px anchor drift, no missed frames attributable to the app in real presentation traces.
4. **Runtime and concurrency.** Chromium over HTTP against Tauri on WebKit; four windows plus agent writes. Pass: transport and propagation budgets, no lost edits, reconnects converge without polling.
5. **Eight-hour soak.** Editing, navigation and forced crashes. Pass: no acknowledged edit lost, heap within 10 percent of a warmed steady state, bounded caches, WAL and draft storage.

## How it is measured

- `tessera-bench` generates seeded workshops of 1k, 10k and 50k blocks through the same batches clients use, and checks every measured query against the generator's model.
- Release builds, median and p95 over 31 runs, query plans saved for regressions.
- `cargo run --release -p tessera-bench -- --root /tmp/tessera-bench --fail-on budgets` is the gate on a named device. CI runs the 50k workshop with `--fail-on scaling`: it fails on any correctness error or on per-row work, and reports absolute budgets without failing, since shared runners are not the devices the budgets describe.
- Scaling checks compare medians: the 10,000-block page's commit must cost at most twice the 100-block page's plus 1 ms.
- Browser traces for input latency and long tasks; on-device presentation traces for frame claims, since headless paint timing is only a proxy.
- Results recorded per commit, so regressions show up when they happen.
