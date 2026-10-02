# Spike 3 · typing-path attribution and cutover

CDP Profiler (100 µs sampling) + devtools.timeline Tracing, minified production Solid fixture with source maps, real release service, two panes. Each typing profile contains 50 alternating x/y key presses mid-page and waits through the coalesced save; structural profiles contain 12 Enter splits plus their acknowledgements. Page sizes are nominal corpus sizes; the initial profiles followed the earlier structural proof and retained its added rows. Final latency cells use a regenerated pristine corpus.

CPU self time is sampled exclusive JavaScript time; total is inclusive at the largest sampled callsite and overlaps other totals. No samples is not a fabricated zero. V8 occasionally returned negative timestamp deltas at this sampling interval: those raw samples remain in .cpuprofile but are excluded from nonnegative attribution below. Browser style/layout/paint are timeline span totals, not CPU self measurements or presentation certification.

## Typing attribution · self ms over 50 keys and save

| Category | Before 2k | Before 10k | After 2k | After 10k |
|---|---:|---:|---:|---:|
| Solid reactivity | 302.30 | 426.80 | 1.51 | 2.08 |
| Document / queue / lookup | 165.64 | 217.57 | 1.21 | 1.33 |
| Outbox / IndexedDB | 145.11 | 223.73 | 1.74 | 1.60 |
| Outline effects / rendering | 9.19 | 5.30 | 1.15 | 1.50 |
| Visibility / virtualizer | not sampled | not sampled | not sampled | 0.53 |
| CodeMirror | 14.57 | 11.58 | 16.94 | 15.46 |

## Named hot functions · self / inclusive total ms

| Function | Before 2k | Before 10k | After 2k | After 10k |
|---|---:|---:|---:|---:|
| Document.merge | 23.21 / 481.27 | 26.32 / 641.47 | not sampled | not sampled |
| Document.refreshPending | 17.02 / 159.79 | 28.46 / 215.64 | 0.00 / 0.03 | not sampled |
| Document.snapshot | 25.13 / 38.98 | 29.63 / 47.75 | 0.00 / 0.13 | 0.07 / 0.07 |
| Document.put | 17.79 / 191.57 | 17.77 / 235.77 | 0.00 / 0.75 | 0.13 / 0.99 |
| Document.edit | 0.26 / 1.86 | 0.13 / 2.46 | 0.13 / 1.70 | 0.13 / 2.66 |
| Notebook.enqueue | 0.00 / 0.72 | 0.00 / 0.79 | not sampled | 0.06 / 0.88 |
| Notebook.compile | 0.00 / 0.07 | 0.13 / 0.14 | 0.00 / 0.04 | 0.00 / 0.07 |
| Notebook.publish | 17.01 / 20.51 | 6.99 / 10.74 | 0.08 / 0.08 | 0.02 / 0.02 |
| Outbox.put | 0.00 / 2.00 | 0.00 / 0.78 | 0.45 / 0.53 | 0.48 / 0.62 |
| IDB request wrapper | 141.37 / 206.59 | 222.38 / 298.36 | 0.07 / 0.65 | 0.10 / 0.61 |
| Solid.updatePath | 47.21 / 106.48 | 61.15 / 146.91 | 0.00 / 0.39 | 0.39 / 0.70 |
| CodeMirror.measure | 0.32 / 8.00 | 0.13 / 6.81 | 0.54 / 10.47 | 0.00 / 7.85 |

## Browser rendering · trace span ms

| Span | Before 2k | Before 10k | After 2k | After 10k |
|---|---:|---:|---:|---:|
| UpdateLayoutTree | 14.26 | 8.14 | 7.91 | 7.59 |
| Layout | 120.98 | 33.35 | 8.37 | 11.31 |
| PrePaint | 15.32 | 5.34 | 2.94 | 3.16 |
| Paint | 100.85 | 28.15 | 7.27 | 12.44 |

## Structural attribution · self / inclusive total ms over 12 Enter keys

| Function | Before 2k | Before 10k | After 2k | After 10k |
|---|---:|---:|---:|---:|
| Document.merge | 5.24 / 113.51 | 3.76 / 94.89 | not sampled | not sampled |
| Document.view | 0.13 / 3.27 | 1.94 / 16.83 | not sampled | not sampled |
| OutlineIndex.at | not sampled | 14.11 / 14.11 | not sampled | not sampled |
| OutlineIndex.slice | 0.13 / 1.69 | 0.26 / 5.49 | 0.13 / 1.44 | 0.34 / 6.99 |
| visibleIds | 3.48 / 3.48 | 1.05 / 15.93 | 0.13 / 1.57 | 0.91 / 7.91 |
| TanStack.getMeasurements | not sampled | not sampled | 0.88 / 0.88 | 3.64 / 3.64 |
| Outbox.acknowledge | 0.13 / 35.46 | 0.02 / 169.35 | not sampled | not sampled |
| IDB request wrapper | 32.95 / 47.95 | 126.55 / 169.33 | 0.00 / 0.00 | 0.13 / 0.13 |

## Synchronization / save evidence

- before 2000 typing: observed API sends {"pages":76,"batches":3}; excluded negative timestamp deltas 567.
- before 2000 structural: observed API sends {"pages":28,"batches":12}; excluded negative timestamp deltas 315.
- before 10000 typing: observed API sends {"pages":23,"batches":2}; excluded negative timestamp deltas 400.
- before 10000 structural: observed API sends {"pages":14,"batches":12}; excluded negative timestamp deltas 266.
- after 2000 typing: observed API sends {"batches":2}; excluded negative timestamp deltas 370.
- after 2000 structural: observed API sends {"batches":12}; excluded negative timestamp deltas 293.
- after 10000 typing: observed API sends {"batches":2}; excluded negative timestamp deltas 385.
- after 10000 structural: observed API sends {"batches":12}; excluded negative timestamp deltas 269.

Retained-library qualification: application typing does not rebuild page visibility or serialize/scan the page on save. At 10k, an occasional wrapped-row height update still sampled 0.53 ms of TanStack work over all 50 keys (0.26 ms in its measurement getter). TanStack was intentionally retained unchanged; this is not a claim of zero internal height-cache work. Related sections were collapsed and produced no related HTTP sends during these input windows.

## Changes

- Coalesce each HTTP catch-up batch to final touched-block state; reconcile a structured page only when incoming revisions/removals are ahead of its current snapshot. This removes repeated historical whole-page reload/merge/IndexedDB churn after the editor becomes usable.
- Key block-presence tracking by ID; track conflicts independently. Remote text and conflict changes no longer invalidate every block reader or archive-visibility dependency.
- Cache full snapshots only on page load/create/whole-page restore. Acknowledgements atomically persist touched blocks and compact structural actions/revisions, removing the queued command in the same transaction. Offline load replays deltas with the existing treap. Fresh network snapshots prune only deltas known committed before the GET began, preserving in-flight edits.
- Structure/fold/archive/zoom visibility rebuild is one linear treap slice instead of one logarithmic idAt per row. TanStack remains unchanged as directed. Structural projection may be O(n) within the measured frame budget; typing does not rebuild it.
- Added consumer regression: acknowledged insert/split/move/delete/undo structure survives offline cold reload; a fresh snapshot after a remote deletion cannot resurrect an earlier local restore.

## Latency before / after

| Rows | Cell | Handler p99 before / after ms | Frame p95 before / after ms | Event p95 before / after ms |
|---:|---|---:|---:|---:|
| 2000 | typing | 0.20 / 0.20 | 15.90 / 15.90 | 24.00 / 16.00 |
| 2000 | Enter | 1.70 / 1.20 | 16.50 / 16.30 | 24.00 / 24.00 |
| 2000 | Tab | 1.00 / 1.00 | 16.70 / 16.70 | 24.00 / 24.00 |
| 2000 | Shift+Tab | 1.30 / 1.30 | 18.10 / 17.20 | 24.00 / 24.00 |
| 2000 | Alt+ArrowUp | 1.00 / 1.00 | 15.80 / 16.50 | 16.00 / 16.00 |
| 10000 | typing | 0.20 / 0.20 | 41.50 / 15.80 | 64.00 / 24.00 |
| 10000 | Enter | 4.20 / 2.90 | 27.40 / 16.70 | 32.00 / 24.00 |
| 10000 | Tab | 3.20 / 3.30 | 25.20 / 16.50 | 24.00 / 24.00 |
| 10000 | Shift+Tab | 3.50 / 3.50 | 27.70 / 17.50 | 32.00 / 32.00 |
| 10000 | Alt+ArrowUp | 3.20 / 3.10 | 25.20 / 16.60 | 24.00 / 24.00 |

Final correctness and row/anchor/error evidence: [summary.md](summary.md). Raw before/after profiles and traces are adjacent; normalized attribution is [attribution.json](attribution.json). `bun test src/document`: 21 pass (all 20 existing tests plus the cache regression). Typecheck passed. Headless frame/Event Timing remain proxies; no 60/120 Hz presentation certification is implied.
