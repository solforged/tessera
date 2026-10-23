# Runtime and soak spikes

Run from the repository root. Both harnesses create a disposable 60-page, 9,000-block workshop through the public API, stop its seed service, and copy it for each run. They never use the live workshop or port 4318. Temporary workshops and browser contexts are removed on exit. JSON evidence and Markdown tables remain in `web/perf/results/`. A failed or unmeasured required budget exits nonzero.

```sh
cargo build --release -p tessera-cli
bun run --cwd web build
# Install Playwright's WebKit runtime once, if it is missing.
(cd web && bunx playwright-core install webkit)

# Short real-service checks. Concurrency runs each runtime for this duration.
bun web/perf/concurrency.ts --minutes 1
bun web/perf/soak.ts --minutes 1

# Full runs.
bun web/perf/concurrency.ts --minutes 3
bun web/perf/soak.ts --hours 8
```

`CHROME_PATH` overrides the Chromium executable. Its default matches `run.ts`: `~/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`. `BROWSER=chromium|webkit` selects one concurrency leg; the default runs both sequentially against independent copies of the same corpus. An unavailable runtime is reported as **not run**, not silently substituted. The soak requires Chromium for CDP heap measurements. WebKit here means Playwright WebKit over HTTP, **not Tauri or a native WKWebView**.

## Pass criteria

Concurrency uses four isolated contexts, two sharing a page, plus agent-note and batch writers. Typing runs about every 300 ms, structural edits every 3 s, and background writes every 500 ms. Small browser batch round trips must have p95 ≤50 ms and another window must display a probe edit at p95 ≤100 ms. Propagation includes the write request and a 10 ms DOM observation interval. Every 30 s a context goes offline for 5 s while editing continues. On reconnect, writers pause briefly: the outbox must drain to zero, the pane must report Saved, and every server row must match text and depth across the complete scrolled view. Convergence time is reported without inventing an additional latency budget. There must be zero `/api/changes` fetches while the change WebSocket is live outside startup and the deliberately disconnected context's recovery. Every request retains its timestamp and phase in JSON; catch-up reads are counted separately. Every acknowledged receipt is checked for change-event membership and revision floors in current pages; every typed/probe/background marker must survive in server text. Change replay returns current blocks, not exact historical snapshots.

The eight-hour soak uses PRNG seed 42 and two contexts for typing, Enter, Tab, Shift+Tab, Alt+ArrowUp, Find, back/forward, journal navigation and folding. It kills the service on a submitted batch every 10 minutes and replaces a context every 20 minutes. Typing continues during the injected outage; selected navigation actions wait for the service to return instead of opening network-backed Find against a deliberately stopped service. Overlapping edits, especially on the shared journal, can legitimately need conflict resolution; the runner uses Review conflict and Edit merged text to preserve both appended marker tails before continuing or draining. Per-window actions, targets, generations and outcomes are retained in the JSON. Receipts are retained by the runner, not inside the tabs. Every service restart and the final drain must preserve all acknowledged revisions and pass `/api/check`. No delete or merge operation is generated, so a missing live block cannot be explained away as intentional deletion.

Samples include CDP used/total JS heap, nodes and listeners; DOM and mounted block counts; all six IndexedDB outbox stores; distinct cached pages and pages opened; and WAL bytes. Final-hour median used heap must not exceed 110% of the minute-30-to-60 median for either context slot. A decrease is acceptable. WAL samples must stay ≤64 MiB. Commands must return to zero after each drain, and distinct cached pages must not exceed distinct pages opened in that context. The `pages` store contains both snapshots and ordered structural patches; its raw record count remains in the samples, but each patch is not another cached page. SubtreeCache is not exposed by the production app, so mounted rows stand in, using the existing ≤102-row browser performance bound. WAL and storage bounds are sampled, not claims about unseen transient peaks.

`--minutes` on the soak compresses service/tab crashes to one-third/two-thirds of the duration, samples at least 12 times, and compares second-quarter heap samples with the last quarter. This exercises recovery quickly; it does **not** establish eight-hour steady-state behavior. An unusually short concurrency run under 35 s cannot complete an offline cycle and fails the convergence check. Close-and-replace contexts model loss of a tab's execution and isolated storage, not an OS-level browser-process crash. Native Tauri IPC, WebKit heap size and presentation-frame timing are not measured.
