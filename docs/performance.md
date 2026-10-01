# Performance

The goal is that ordinary use never drops a frame on the owner's machines: typing, scrolling, folding, moving blocks and switching pages, on notebooks of 50,000 blocks or more. No design can promise that on all hardware, so Tessera sets budgets, measures them on named devices and treats a missed budget as a bug.

## Budgets

Measured on 50,000-block notebooks with 2,000- and 10,000-row pages, mixed heights and two panes open.

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
- No per-keystroke work is proportional to page size or notebook size.
- No synchronous storage write on the input path.
- Undo history and drafts grow with the number of edits, not with page size times edits.

## Baseline from the prototype

The prototype was measured on an Apple M5 Max in headless Chrome 151 with a 52,000-block notebook.

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
- **Search and completion scanned** and grew linearly with notebook size.

## Spike 1 result: backend operations

Spike 1 passed on 2026-10-01: Apple M5 Max, release build, SQLite 3.53.2, 50,000-block notebook, 31 runs per measurement. Each measured read was checked against the generator's own model.

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

## Spike 2 result: editor, partly settled

Three variants of the same outline editor live in `spikes/editor/`: React with one CodeMirror per pane, Solid with the same design, and one ProseMirror document. A runner drives them in headless Chrome with real keyboard and IME input, at 2,000 and 10,000 fully mounted rows. Results are in `spikes/editor/results/summary.md`.

| Variant | Correctness scenarios | Typing, handler p99 | Structural edit, handler p99 at 10,000 rows |
|---|---|---|---|
| React + CodeMirror | 11 of 11 | 0.2 ms | 0.2 to 23 ms |
| Solid + CodeMirror | 11 of 11 | 0.2 ms | 0.2 to 10 ms |
| ProseMirror | 9 of 11; both failures are Vim | 0.1 ms | 12 to 18 ms |

What it settled:

- **CodeMirror per pane, not one ProseMirror document.** ProseMirror matched the others on everything except Vim, and no usable ProseMirror Vim mode exists. CodeMirror's Vim extension passed every Vim scenario.
- **Outline commands are cheap once indexed.** An indexed sequence shared by both CodeMirror variants made indent, outdent and move independent of page size.

What it did not settle:

- **No variant meets the frame budgets with 10,000 rows mounted.** At 10,000 rows, browser style, layout and paint cost about 22 ms per Enter in every variant. That is mounted DOM size, which windowing bounds.
- **React or Solid.** React's list reconciliation adds about 7 ms per structural edit at 10,000 rows; Solid's adds about 1 ms. Windowing shrinks both, so the choice is made in spike 3 by running both variants windowed. React stays the default until then.
- Headless paint timing is a proxy. Two panes, real presentation traces and service round trips were not measured.

## Spikes that decide the stack

Each runs before the matching feature is built. Each can overturn a choice in [architecture](architecture.md).

1. **Backend operations.** Load 2,000 and 10,000-block pages and commit single-block operations. Pass: cold viewport under 500 ms, commit under 50 ms, no per-row work for unchanged rows.
2. **Editor.** React with one CodeMirror per pane, against Solid with the same design and against one ProseMirror document. Pass: frame budgets, plus zero wrong outcomes for IME, Vim, undo and cross-block selection.
3. **Windowing.** 10,000 mixed-height rows with folding and long scrolls, in both the React and Solid editors from spike 2. Pass: bounded mounted rows, at most 2 px anchor drift, no missed frames attributable to the app in real presentation traces. The faster variant that passes becomes the editor.
4. **Runtime and concurrency.** Chromium over HTTP against Tauri on WebKit; four windows plus agent writes. Pass: transport and propagation budgets, no lost edits, reconnects converge without polling.
5. **Eight-hour soak.** Editing, navigation and forced crashes. Pass: no acknowledged edit lost, heap within 10 percent of a warmed steady state, bounded caches, WAL and draft storage.

## How it is measured

- `tessera-bench` generates seeded notebooks of 1k, 10k and 50k blocks through the same batches clients use, and checks every measured query against the generator's model.
- Release builds, median and p95 over 31 runs, query plans saved for regressions.
- `cargo run --release -p tessera-bench -- --root /tmp/tessera-bench --fail-on budgets` is the gate on a named device. CI runs the 50k notebook with `--fail-on scaling`: it fails on any correctness error or on per-row work, and reports absolute budgets without failing, since shared runners are not the devices the budgets describe.
- Scaling checks compare medians: the 10,000-block page's commit must cost at most twice the 100-block page's plus 1 ms.
- Browser traces for input latency and long tasks; on-device presentation traces for frame claims, since headless paint timing is only a proxy.
- Results recorded per commit, so regressions show up when they happen.
