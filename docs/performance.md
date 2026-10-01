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

## Spikes that decide the stack

Each runs before the matching feature is built. Each can overturn a choice in [architecture](architecture.md).

1. **Backend operations.** Load 2,000 and 10,000-block pages and commit single-block operations. Pass: cold viewport under 500 ms, commit under 50 ms, no per-row work for unchanged rows.
2. **Editor.** React with one CodeMirror per pane, against Solid with the same design and against one ProseMirror document. Pass: frame budgets, plus zero wrong outcomes for IME, Vim, undo and cross-block selection.
3. **Windowing.** 10,000 mixed-height rows with folding and long scrolls. Pass: bounded mounted rows, at most 2 px anchor drift, no missed frames attributable to the app in real presentation traces.
4. **Runtime and concurrency.** Chromium over HTTP against Tauri on WebKit; four windows plus agent writes. Pass: transport and propagation budgets, no lost edits, reconnects converge without polling.
5. **Eight-hour soak.** Editing, navigation and forced crashes. Pass: no acknowledged edit lost, heap within 10 percent of a warmed steady state, bounded caches, WAL and draft storage.

## How it is measured

- A deterministic corpus generator at 1k, 10k and 50k blocks, with an independent correctness check for every measured query.
- Release builds, median and p95 over repeated runs, query plans saved for regressions.
- Browser traces for input latency and long tasks; on-device presentation traces for frame claims, since headless paint timing is only a proxy.
- Results recorded per commit, so regressions show up when they happen.
