# Spike 3 · windowed daily outline

Measured 2026-10-02T00:09:29.949Z, Apple M5 Max, darwin/arm64 27.0.0, headless Chrome 151.0.7922.34. Real tessera service, seeded 50,000-block notebook, two shared-document panes.

Headless Event Timing and double-requestAnimationFrame are proxies, not on-device presentation traces. Event Timing reports only entries ≥16 ms and is 8 ms quantized; unreported entries are not fabricated as zero. Handler p99 covers explicit outline handlers, not total browser frame work. Cold load fetches the production fixture and real page; warm loads are five remounts of the shared cached PageDocument, as on history navigation. Both panes include archived rows. Structural setup/remount and corpus inspection are outside input samples. A retained parent above the viewport is folded while measuring a surviving later anchor.

## Budgets

120 Hz: input/structural p95 16 ms, application work p99 6 ms. 60 Hz: input/structural p95 33 ms, work p99 12 ms. Cold usable 500 ms, warm usable p95 100 ms. Mounted rows bounded by viewport + 8-row overscan each side + one retained active row per pane; anchor drift ≤2 px.

| Rows | Cold usable ms | Warm p95 ms | Peak mounted, two panes | Long-scroll drift px | Fold drift px | Typing handler p99 ms | Typing frame proxy p95 ms | Typing Event Timing p95 ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2000 | 167.61 | 81.72 | 57 | 0.00 | 0.00 | 0.20 | 15.90 | 24.00 (100 reported) |
| 10000 | 307.67 | 85.21 | 57 | 0.00 | 0.00 | 0.20 | 41.50 | 64.00 (100 reported) |

| Rows | Structural key | Handler p99 ms | Frame proxy p95 ms | Event Timing p95 ms | Handler samples |
|---:|---|---:|---:|---:|---:|
| 2000 | Enter | 1.70 | 16.50 | 24.00 (31 reported) | 31/31 |
| 2000 | Tab | 1.00 | 16.70 | 24.00 (31 reported) | 31/31 |
| 2000 | Shift+Tab | 1.30 | 18.10 | 24.00 (31 reported) | 31/31 |
| 2000 | Alt+ArrowUp | 1.00 | 15.80 | 16.00 (31 reported) | 31/31 |
| 10000 | Enter | 4.20 | 27.40 | 32.00 (31 reported) | 31/31 |
| 10000 | Tab | 3.20 | 25.20 | 24.00 (31 reported) | 31/31 |
| 10000 | Shift+Tab | 3.50 | 27.70 | 32.00 (31 reported) | 31/31 |
| 10000 | Alt+ArrowUp | 3.20 | 25.20 | 24.00 (31 reported) | 31/31 |

## Correctness

- PASS **Split / merge and undo / redo across acknowledged saves preserve IDs and children** — Left 01M3WZ132GJQB0PQ8PKMD4FSYZ, child 01M3WZ132GX9J8H1Y4EG24NP6M, split 01M3WZ13C1EFGQMP89WD7389NV; merge, committed undo and redo checked.
- PASS **Indent / outdent / sibling move preserve complete subtree identities** — All four original block IDs survive; 01M3WZ13JX05NW6SSRQGANA6KM moves before 01M3WZ13JX9HJDR3Q1Z29XF84B; child remains attached.
- PASS **CodeMirror Vim text motions/operators and structural Vim** — Text w/dw, Escape mode transition, j, >>/<<, o, dd, u and Ctrl+R exercised; new ID 01M3WZ14ES0EYCJ4X6YW9Z08EZ restored exactly.
- PASS **IME composition Enter commits once and never splits** — CDP preedit かん, real Enter while composing, commit 漢; four IDs remain and one undo restores original text.
- PASS **Cross-block partial selection copies and deletes visible text, with undo** — A local partial selection extends across rows without losing its original offset; copied “ld preserved\nbra”; deletion retained first ID and last suffix; undo restored last ID.
- PASS **Folded descendants are not silently deleted by text selection** — Folded child remains live; cross-range delete refused with a visible explanation.
- PASS **[[ completion inserts a stable working reference and opens beside** — Completion inserts [[01M3WZ1635YWV9D55QVNHZJEJN]]; rendered target clicked into second real page pane.
- PASS **Tag chip resolves its type page and opens beside** — #proof-tag resolves to live type page 01M3WZ16X996X23QEKVQD9FF30 and opens beside.
- PASS **Fold, zoom breadcrumbs and exact view-state restore** — Fold hides child; bullet zoom, breadcrumb path, zoom-out and remount restore zoom, folds, caret and anchor ≤2px.
- PASS **Heading input rule is one undo step; page rename validates in place** — Typed #␠ converts text/style atomically; one undo restores normal; Enter rename acknowledged by service.
- PASS **Expanded Backlinks and Tagged blocks follow remote membership and show ancestor breadcrumbs** — A remote insert adds one backlink and one tag member; breadcrumbs include its source parent; remote text removal updates both counts to zero without reloading.

## Budget assessment

- 2000: row bound PASS (≤102 across two 858px viewports); anchor PASS; handler 120/60 Hz PASS/PASS; frame proxy 120/60 Hz FAIL/PASS; cold PASS, warm PASS. Long tasks 0; runtime errors 0.
- 10000: row bound PASS (≤102 across two 858px viewports); anchor PASS; handler 120/60 Hz PASS/PASS; frame proxy 120/60 Hz FAIL/FAIL; cold PASS, warm PASS. Long tasks 2; runtime errors 0.

No claim of 60/120 Hz presentation correctness is made without on-device presentation traces. Raw events, processing samples and all long tasks are in results.json. Run: `bun run --cwd web vite build --config perf/vite.config.ts`; `target/release/tessera serve --notebook /tmp/tessera-Outline/corpus-50000-42 --port 4340 --assets web/perf/dist`; `bun web/perf/run.ts`. The runner creates isolated proof pages and edits the benchmark pages; regenerate the disposable notebook before another complete measurement.
