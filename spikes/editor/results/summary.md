# Editor spike comparison

Measured 2026-10-01T21:46:29.250Z on Apple M5 Max, 64.0 GiB RAM, darwin/arm64 27.0.0, headless Chrome 151.0.7922.34.

## Measurement budgets

120 Hz: 8.33 ms frames, application work p99 6 ms, input-to-paint p95 16 ms. 60 Hz: 16.67 ms frames, application work p99 12 ms, input-to-paint p95 33 ms. Cold usable load 500 ms; warm usable load p95 100 ms.

## Results

| Variant | Rows | DPR | Cold usable ms | Warm p95 ms | Heap MiB | Typing p50/p95/max ms | Enter p95 | Tab p95 | Shift+Tab p95 | Move p95 | Load/input long tasks |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| react-codemirror | 2000 | 1 | 148.3 | 120.1 | 8.3 | 24.0/24.0/32.0 | 24.0 | 24.0 | 24.0 | 32.0 | 0/0 |
| react-codemirror | 2000 | 2 | 142.3 | 122.7 | 8.3 | 24.0/24.0/32.0 | 24.0 | 32.0 | 32.0 | 24.0 | 0/0 |
| react-codemirror | 10000 | 1 | 310.8 | 332.9 | 29.8 | 24.0/32.0/40.0 | 48.0 | 40.0 | 48.0 | 40.0 | 0/0 |
| react-codemirror | 10000 | 2 | 338.4 | 334.1 | 30.0 | 24.0/32.0/32.0 | 48.0 | 40.0 | 40.0 | 40.0 | 0/0 |
| solid-codemirror | 2000 | 1 | 129.6 | 128.6 | 10.0 | 24.0/24.0/32.0 | 24.0 | 24.0 | 24.0 | 24.0 | 1/0 |
| solid-codemirror | 2000 | 2 | 131.9 | 128.1 | 7.7 | 24.0/24.0/32.0 | 24.0 | 24.0 | 24.0 | 24.0 | 1/0 |
| solid-codemirror | 10000 | 1 | 336.8 | 353.3 | 30.7 | 24.0/32.0/32.0 | 48.0 | 40.0 | 40.0 | 40.0 | 1/0 |
| solid-codemirror | 10000 | 2 | 344.0 | 369.6 | 30.7 | 24.0/32.0/32.0 | 48.0 | 40.0 | 40.0 | 40.0 | 1/0 |
| prosemirror | 2000 | 1 | 113.0 | 110.3 | 3.4 | 16.0/24.0/32.0 | 24.0 | 24.0 | 24.0 | 16.0 | 0/0 |
| prosemirror | 2000 | 2 | 115.1 | 110.8 | 3.4 | 24.0/24.0/32.0 | 24.0 | 24.0 | 24.0 | 24.0 | 0/0 |
| prosemirror | 10000 | 1 | 319.7 | 345.0 | 11.7 | 32.0/32.0/32.0 | 40.0 | 32.0 | 40.0 | 32.0 | 1/0 |
| prosemirror | 10000 | 2 | 309.0 | 345.1 | 11.7 | 32.0/32.0/40.0 | 40.0 | 32.0 | 40.0 | 32.0 | 1/0 |

Latency percentiles cover reported Event Timing entries only (at least 16 ms). Structural p50/p95/max, attempted/observed sample coverage, handler-processing p99 and every long-task duration are in results.json.

## Comparison

- react-codemirror: worst-cell reported typing p95 32.0 ms; structural p95 48.0 ms; peak loaded heap 30.0 MiB; correctness 11/11.
- solid-codemirror: worst-cell reported typing p95 32.0 ms; structural p95 48.0 ms; peak loaded heap 30.7 MiB; correctness 11/11.
- prosemirror: worst-cell reported typing p95 32.0 ms; structural p95 40.0 ms; peak loaded heap 11.7 MiB; correctness 9/11.

## Correctness

### react-codemirror

11/11 scenarios passed.

- Pass: Typing and Shift+Enter. Real browser input produced the expected model, IDs and selection.
- Pass: Split retains left ID and children. Real browser input produced the expected model, IDs and selection.
- Pass: Merge keeps previous visible ID and join caret. Real browser input produced the expected model, IDs and selection.
- Pass: Merge refuses a row with children. Real browser input produced the expected model, IDs and selection.
- Pass: Indent, outdent and move preserve subtree IDs. Real browser input produced the expected model, IDs and selection.
- Pass: One undo stack restores exact mixed model, IDs and caret. Real browser input produced the expected model, IDs and selection.
- Pass: Cross-block selection copy, delete and undo. Real browser input produced the expected model, IDs and selection.
- Pass: Arrow navigation and reverse cross-block selection. Real browser input produced the expected model, IDs and selection.
- Pass: IME commits once; Enter while composing never splits. Real browser input produced the expected model, IDs and selection.
- Pass: Vim word motions and ciw/u. Real browser input produced the expected model, IDs and selection.
- Pass: Vim dd/u and j/k across rows. Real browser input produced the expected model, IDs and selection.

### solid-codemirror

11/11 scenarios passed.

- Pass: Typing and Shift+Enter. Real browser input produced the expected model, IDs and selection.
- Pass: Split retains left ID and children. Real browser input produced the expected model, IDs and selection.
- Pass: Merge keeps previous visible ID and join caret. Real browser input produced the expected model, IDs and selection.
- Pass: Merge refuses a row with children. Real browser input produced the expected model, IDs and selection.
- Pass: Indent, outdent and move preserve subtree IDs. Real browser input produced the expected model, IDs and selection.
- Pass: One undo stack restores exact mixed model, IDs and caret. Real browser input produced the expected model, IDs and selection.
- Pass: Cross-block selection copy, delete and undo. Real browser input produced the expected model, IDs and selection.
- Pass: Arrow navigation and reverse cross-block selection. Real browser input produced the expected model, IDs and selection.
- Pass: IME commits once; Enter while composing never splits. Real browser input produced the expected model, IDs and selection.
- Pass: Vim word motions and ciw/u. Real browser input produced the expected model, IDs and selection.
- Pass: Vim dd/u and j/k across rows. Real browser input produced the expected model, IDs and selection.

### prosemirror

9/11 scenarios passed.

- Pass: Typing and Shift+Enter. Real browser input produced the expected model, IDs and selection.
- Pass: Split retains left ID and children. Real browser input produced the expected model, IDs and selection.
- Pass: Merge keeps previous visible ID and join caret. Real browser input produced the expected model, IDs and selection.
- Pass: Merge refuses a row with children. Real browser input produced the expected model, IDs and selection.
- Pass: Indent, outdent and move preserve subtree IDs. Real browser input produced the expected model, IDs and selection.
- Pass: One undo stack restores exact mixed model, IDs and caret. Real browser input produced the expected model, IDs and selection.
- Pass: Cross-block selection copy, delete and undo. Real browser input produced the expected model, IDs and selection.
- Pass: Arrow navigation and reverse cross-block selection. Real browser input produced the expected model, IDs and selection.
- Pass: IME commits once; Enter while composing never splits. Real browser input produced the expected model, IDs and selection.
- Fail: Vim word motions and ciw/u. Vim Escape normal mode: expected "normal", got null
- Fail: Vim dd/u and j/k across rows. Vim dd clears row text without deleting its ID: expected [{"id":"r00000","depth":0,"text":"Argument assumption change answer history answer notes review passage source definition interpretation context claim reference compare counterexample position passage claim result change"},{"id":"r00001","depth":1,"text":""},{"id":"r00002","depth":0,"text":"Study"},{"id":"r00003","depth":0,"text":"Method criteria block result example definition reference answer"},{"id":"r00004","depth":0,"text":"Notes change author passage interpretation chapter summary"},{"id":, got [{"id":"r00000","depth":0,"text":"Argument assumption change answer history answer notes review passage source definition interpretation context claim reference compare counterexample position passage claim result change"},{"id":"r00001","depth":1,"text":"ddAnswer"},{"id":"r00002","depth":0,"text":"Study"},{"id":"r00003","depth":0,"text":"Method criteria block result example definition reference answer"},{"id":"r00004","depth":0,"text":"Notes change author passage interpretation chapter summary"


## Recommendation

Zero-wrong-outcome candidates: react-codemirror, solid-codemirror. Headless 60 Hz input-latency proxy candidates: none. Headless 120 Hz input-latency proxy candidates: none.
Do not settle the editor stack or declare spike 2 passed. No variant meets both zero wrong outcomes and the measured 60 Hz input proxy budget across all four matrix cells. Fix the recorded correctness/latency failures, then capture real presentation traces.
react-codemirror: cold-load budget misses 0/4; warm-load budget misses 4/4.
solid-codemirror: cold-load budget misses 0/4; warm-load budget misses 4/4.
prosemirror: cold-load budget misses 0/4; warm-load budget misses 4/4.

## Limits and unmeasured work

- Headless next-paint Event Timing is a proxy, not on-device presented-frame timing. No 60/120 Hz presentation trace was captured.
- Event Timing has a 16 ms minimum reporting threshold and 8 ms quantization. Percentiles summarize reported keydown entries only and are conservative truncated distributions, not fabricated 0 ms samples. Below-threshold or unreported events are counted separately; a phase with no entries has null percentiles.
- processingP99ObservedMs covers only reported keydown handlers, not all application/render/layout work per frame. The 6/12 ms application-work frame budgets are not certified.
- Each matrix cell uses one empty-cache context load and five same-context warm reloads. Usable load ends after first-row focus and two animation frames. The 200 mid-page typing keys and 50 keys per structural command are paced by 16 ms waits; focused rows are centered before sampling, and setup focus/model reads are outside event samples but can contribute long tasks.
- IME uses one CDP composition/commit scenario per variant, not a full OS input-method matrix. Vim, undo and cross-block selection correctness run once per variant on an 80-row corpus.
- One fully mounted pane was measured. Two-pane load, reference completion, service commits, search, windowing, long scrolling and soak behavior were not measured.

## Structural command follow-up

The preceding table remains the **before** result. Follow-up input and profile results below do not replace its load, heap, DPR 2 or ProseMirror measurements.

| Stage | Variant | Command, 20 presses | Command/store CPU ms | Framework/list CPU ms | CodeMirror CPU ms | Other CPU ms | Style ms | Layout ms | Paint ms |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | react-codemirror | Enter | 5.48 | 149.79 | 308.03 | 210.84 | 68.46 | 219.05 | 154.17 |
| before | react-codemirror | Shift+Tab | 5.27 | 217.06 | 81.99 | 127.38 | 10.04 | 98.01 | 88.28 |
| before | solid-codemirror | Enter | 29.96 | 16.47 | 306.64 | 181.19 | 100.21 | 180.56 | 159.25 |
| before | solid-codemirror | Shift+Tab | 28.02 | 22.28 | 296.94 | 115.88 | 96.59 | 173.65 | 90.88 |
| after | react-codemirror | Enter | 1.62 | 156.97 | 283.66 | 188.67 | 65.49 | 195.67 | 149.28 |
| after | react-codemirror | Shift+Tab | 0.78 | 146.00 | 78.50 | 112.75 | 9.58 | 93.41 | 81.31 |
| after | solid-codemirror | Enter | 0.77 | 18.61 | 293.91 | 179.50 | 96.69 | 174.20 | 158.01 |
| after | solid-codemirror | Shift+Tab | 0.13 | 14.97 | 280.83 | 110.26 | 95.33 | 161.48 | 87.30 |

### Hot functions

#### before: react-codemirror, Enter

[CPU profile](profiles/react-codemirror-before-enter.cpuprofile) · [Browser trace](profiles/react-codemirror-before-enter.trace.json)

| Function | Source | Category | Self ms | Total ms |
|---|---|---|---:|---:|
| model | ../../src/store.ts:31 | command/store | 0.63 | 3.33 |
| execute | ../../src/store.ts:84 | command/store | 0.29 | 1.14 |
| apply | ../../src/store.ts:65 | command/store | 0.65 | 0.85 |
| split | ../../src/commands.ts:26 | command/store | 0.52 | 0.83 |
| performSyncWorkOnRoot | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:13574 | framework/list | 0.01 | 147.90 |
| flushSyncWorkAcrossRoots_impl | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:13408 | framework/list | 0.00 | 147.90 |
| flushSyncWork$1 | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:12402 | framework/list | 0.00 | 147.90 |
| t2 | ../../src/main.tsx:34 | framework/list | 21.20 | 21.20 |
| Row | ../../src/main.tsx:33 | framework/list | 15.97 | 72.56 |
| updateSyncExternalStore | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:4980 | framework/list | 14.09 | 42.64 |
| renderWithHooks | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:4627 | framework/list | 5.64 | 82.86 |
| handleEvent | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4578 | CodeMirror/editor | 0.00 | 364.00 |
| action | ../../src/text-editor.ts:117 | CodeMirror/editor | 0.00 | 363.35 |
| key | ../../src/text-editor.ts:113 | CodeMirror/editor | 0.00 | 363.35 |
| mount | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:107 | CodeMirror/editor | 2.68 | 3.19 |
| measure | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:6355 | CodeMirror/editor | 0.52 | 57.76 |
| getRules | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:55 | CodeMirror/editor | 0.51 | 0.51 |
| measure | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:8171 | CodeMirror/editor | 0.40 | 97.82 |
| (program) | :0 | other JS/native | 188.70 | 188.70 |
| (garbage collector) | :0 | other JS/native | 18.92 | 18.92 |

#### before: react-codemirror, Shift+Tab

[CPU profile](profiles/react-codemirror-before-outdent.cpuprofile) · [Browser trace](profiles/react-codemirror-before-outdent.trace.json)

| Function | Source | Category | Self ms | Total ms |
|---|---|---|---:|---:|
| model | ../../src/store.ts:31 | command/store | 0.78 | 3.22 |
| indent | ../../src/commands.ts:40 | command/store | 0.39 | 1.04 |
| apply | ../../src/store.ts:65 | command/store | 0.51 | 0.76 |
| performWorkOnRoot | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:12069 | framework/list | 0.00 | 215.02 |
| performSyncWorkOnRoot | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:13574 | framework/list | 0.00 | 215.02 |
| flushSyncWorkAcrossRoots_impl | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:13408 | framework/list | 0.00 | 215.02 |
| t2 | ../../src/main.tsx:34 | framework/list | 19.15 | 19.15 |
| Row | ../../src/main.tsx:33 | framework/list | 16.51 | 81.88 |
| updateSyncExternalStore | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:4980 | framework/list | 15.28 | 43.05 |
| useMemoCache | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:4811 | framework/list | 12.35 | 17.14 |
| handleEvent | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4578 | CodeMirror/editor | 0.00 | 298.78 |
| runHandlers | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4588 | CodeMirror/editor | 0.00 | 298.36 |
| action | ../../src/text-editor.ts:117 | CodeMirror/editor | 0.00 | 297.24 |
| add | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:9161 | CodeMirror/editor | 0.50 | 0.60 |
| getKeymap | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:9134 | CodeMirror/editor | 0.35 | 1.10 |
| (program) | :0 | other JS/native | 120.82 | 120.82 |
| (garbage collector) | :0 | other JS/native | 3.95 | 3.95 |

#### before: solid-codemirror, Enter

[CPU profile](profiles/solid-codemirror-before-enter.cpuprofile) · [Browser trace](profiles/solid-codemirror-before-enter.trace.json)

| Function | Source | Category | Self ms | Total ms |
|---|---|---|---:|---:|
| perform | ../../src/main.tsx:118 | command/store | 0.14 | 213.24 |
| model | ../../src/main.tsx:54 | command/store | 1.69 | 28.79 |
| apply | ../../src/main.tsx:103 | command/store | 0.00 | 14.78 |
| readSignal | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:619 | command/store | 4.76 | 4.76 |
| get | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/store/dist/store.js:97 | command/store | 2.08 | 6.84 |
| split | ../../src/commands.ts:33 | command/store | 0.57 | 1.03 |
| runUpdates | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:819 | framework/list | 0.00 | 14.78 |
| batch | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:452 | framework/list | 0.00 | 14.78 |
| completeUpdates | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:835 | framework/list | 0.00 | 13.69 |
| normalizeIncomingArray | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/web/dist/web.js:612 | framework/list | 7.96 | 7.96 |
| insertExpression | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/web/dist/web.js:529 | framework/list | 1.96 | 10.68 |
| setOrder | ../../src/main.tsx:112 | framework/list | 0.65 | 0.65 |
| handleEvent | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4578 | CodeMirror/editor | 0.13 | 244.60 |
| runHandlers | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4588 | CodeMirror/editor | 0.09 | 243.82 |
| keydown | ../../src/main.tsx:210 | CodeMirror/editor | 0.40 | 243.47 |
| mount | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:107 | CodeMirror/editor | 4.11 | 4.75 |
| measure | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:6355 | CodeMirror/editor | 0.65 | 64.91 |
| getRules | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:55 | CodeMirror/editor | 0.64 | 0.64 |
| render | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:29 | CodeMirror/editor | 0.52 | 0.52 |
| (program) | :0 | other JS/native | 178.96 | 178.96 |
| (garbage collector) | :0 | other JS/native | 0.14 | 0.14 |

#### before: solid-codemirror, Shift+Tab

[CPU profile](profiles/solid-codemirror-before-outdent.cpuprofile) · [Browser trace](profiles/solid-codemirror-before-outdent.trace.json)

| Function | Source | Category | Self ms | Total ms |
|---|---|---|---:|---:|
| perform | ../../src/main.tsx:118 | command/store | 0.00 | 212.45 |
| model | ../../src/main.tsx:54 | command/store | 1.18 | 27.33 |
| apply | ../../src/main.tsx:103 | command/store | 0.00 | 21.37 |
| get | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/store/dist/store.js:97 | command/store | 7.94 | 10.05 |
| readSignal | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:619 | command/store | 1.54 | 1.54 |
| getNodes | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/store/dist/store.js:65 | command/store | 1.07 | 1.07 |
| runUpdates | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:819 | framework/list | 0.00 | 21.37 |
| batch | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:452 | framework/list | 0.00 | 21.37 |
| completeUpdates | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:835 | framework/list | 0.00 | 19.79 |
| normalizeIncomingArray | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/web/dist/web.js:612 | framework/list | 12.10 | 12.10 |
| setOrder | ../../src/main.tsx:112 | framework/list | 0.86 | 0.86 |
| reconcileArrays | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/web/dist/web.js:135 | framework/list | 0.78 | 5.32 |
| handleEvent | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4578 | CodeMirror/editor | 0.13 | 243.49 |
| runHandlers | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4588 | CodeMirror/editor | 0.00 | 242.58 |
| keydown | ../../src/main.tsx:210 | CodeMirror/editor | 0.00 | 240.47 |
| mount | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:107 | CodeMirror/editor | 3.86 | 4.63 |
| measure | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:6355 | CodeMirror/editor | 0.89 | 59.62 |
| getRules | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:55 | CodeMirror/editor | 0.77 | 0.77 |
| (program) | :0 | other JS/native | 113.60 | 113.60 |

#### after: react-codemirror, Enter

[CPU profile](profiles/react-codemirror-after-enter.cpuprofile) · [Browser trace](profiles/react-codemirror-after-enter.trace.json)

| Function | Source | Category | Self ms | Total ms |
|---|---|---|---:|---:|
| apply | ../../src/store.ts:66 | command/store | 0.00 | 0.97 |
| applyAll | ../../src/store.ts:86 | command/store | 0.00 | 0.97 |
| execute | ../../src/store.ts:94 | command/store | 0.00 | 0.97 |
| getSnapshot | ../../src/store.ts:27 | command/store | 0.39 | 0.39 |
| build | ../../src/outline-index.ts:173 | command/store | 0.38 | 0.51 |
| splice | ../../src/outline-index.ts:141 | command/store | 0.17 | 0.68 |
| setText | ../../src/outline-index.ts:136 | command/store | 0.17 | 0.17 |
| flushSyncWorkAcrossRoots_impl | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:13408 | framework/list | 0.02 | 153.51 |
| flushSyncWork$1 | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:12402 | framework/list | 0.00 | 153.51 |
| flushSyncWork | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:16914 | framework/list | 0.00 | 153.51 |
| t2 | ../../src/main.tsx:34 | framework/list | 17.86 | 17.86 |
| Row | ../../src/main.tsx:33 | framework/list | 12.35 | 69.61 |
| updateSyncExternalStore | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:4980 | framework/list | 10.94 | 36.93 |
| reconcileChildFibersImpl | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:4078 | framework/list | 9.76 | 13.65 |
| handleEvent | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4578 | CodeMirror/editor | 0.13 | 351.94 |
| runHandlers | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4588 | CodeMirror/editor | 0.13 | 351.55 |
| key | ../../src/text-editor.ts:113 | CodeMirror/editor | 0.13 | 351.42 |
| mount | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:107 | CodeMirror/editor | 2.96 | 3.08 |
| ensureHandlers | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4603 | CodeMirror/editor | 0.64 | 0.64 |
| measureTextSize | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:3368 | CodeMirror/editor | 0.51 | 50.87 |
| measure | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:6355 | CodeMirror/editor | 0.39 | 52.23 |
| (program) | :0 | other JS/native | 172.19 | 172.19 |
| (garbage collector) | :0 | other JS/native | 14.02 | 14.02 |
| advanceTimers | ../../../node_modules/.bun/scheduler@0.28.0/node_modules/scheduler/cjs/scheduler.production.js:85 | other JS/native | 0.02 | 0.02 |

#### after: react-codemirror, Shift+Tab

[CPU profile](profiles/react-codemirror-after-outdent.cpuprofile) · [Browser trace](profiles/react-codemirror-after-outdent.trace.json)

| Function | Source | Category | Self ms | Total ms |
|---|---|---|---:|---:|
| apply | ../../src/store.ts:66 | command/store | 0.00 | 0.53 |
| applyAll | ../../src/store.ts:86 | command/store | 0.00 | 0.53 |
| execute | ../../src/store.ts:94 | command/store | 0.00 | 0.53 |
| indent | ../../src/commands.ts:39 | command/store | 0.26 | 0.26 |
| refresh | ../../src/outline-index.ts:66 | command/store | 0.14 | 0.14 |
| split | ../../src/outline-index.ts:42 | command/store | 0.13 | 0.13 |
| visit | ../../src/outline-index.ts:158 | command/store | 0.13 | 0.13 |
| performWorkOnRoot | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:12069 | framework/list | 0.00 | 144.28 |
| performSyncWorkOnRoot | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:13574 | framework/list | 0.00 | 144.28 |
| flushSyncWorkAcrossRoots_impl | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:13408 | framework/list | 0.00 | 144.28 |
| Row | ../../src/main.tsx:33 | framework/list | 8.87 | 40.60 |
| updateSyncExternalStore | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:4980 | framework/list | 7.84 | 19.80 |
| t2 | ../../src/main.tsx:34 | framework/list | 7.34 | 7.34 |
| useMemoCache | ../../../node_modules/.bun/react-dom@19.3.0+62547eec5a2188e3/node_modules/react-dom/cjs/react-dom-client.production.js:4811 | framework/list | 6.43 | 9.27 |
| handleEvent | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4578 | CodeMirror/editor | 0.00 | 220.18 |
| runHandlers | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4588 | CodeMirror/editor | 0.00 | 219.60 |
| action | ../../src/text-editor.ts:117 | CodeMirror/editor | 0.00 | 218.61 |
| normalizeKeyName | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:9071 | CodeMirror/editor | 0.31 | 0.32 |
| scrollRectIntoView | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:540 | CodeMirror/editor | 0.30 | 0.32 |
| visiblePixelRange | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:6145 | CodeMirror/editor | 0.26 | 0.26 |
| (program) | :0 | other JS/native | 109.65 | 109.65 |
| (garbage collector) | :0 | other JS/native | 1.13 | 1.13 |
| push | ../../../node_modules/.bun/scheduler@0.28.0/node_modules/scheduler/cjs/scheduler.production.js:12 | other JS/native | 0.13 | 0.13 |

#### after: solid-codemirror, Enter

[CPU profile](profiles/solid-codemirror-after-enter.cpuprofile) · [Browser trace](profiles/solid-codemirror-after-enter.trace.json)

| Function | Source | Category | Self ms | Total ms |
|---|---|---|---:|---:|
| perform | ../../src/main.tsx:131 | command/store | 0.25 | 209.24 |
| apply | ../../src/main.tsx:107 | command/store | 0.00 | 18.86 |
| split | ../../src/commands.ts:17 | command/store | 0.13 | 0.26 |
| collapsed | ../../src/commands.ts:10 | command/store | 0.13 | 0.13 |
| ensure | ../../src/main.tsx:48 | command/store | 0.13 | 0.25 |
| runUpdates | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:819 | framework/list | 0.00 | 18.86 |
| batch | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:452 | framework/list | 0.00 | 18.86 |
| completeUpdates | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:835 | framework/list | 0.00 | 17.53 |
| normalizeIncomingArray | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/web/dist/web.js:612 | framework/list | 7.51 | 7.51 |
| insertExpression | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/web/dist/web.js:529 | framework/list | 1.58 | 10.19 |
| reconcileArrays | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/web/dist/web.js:135 | framework/list | 0.97 | 1.10 |
| visit | ../../../react-codemirror/src/outline-index.ts:60 | framework/list | 0.50 | 1.76 |
| handleEvent | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4578 | CodeMirror/editor | 0.24 | 210.00 |
| runHandlers | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4588 | CodeMirror/editor | 0.00 | 209.62 |
| keydown | ../../src/main.tsx:225 | CodeMirror/editor | 0.00 | 209.50 |
| mount | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:107 | CodeMirror/editor | 3.84 | 4.34 |
| render | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:29 | CodeMirror/editor | 0.65 | 0.77 |
| focusSelection | ../../src/main.tsx:86 | CodeMirror/editor | 0.64 | 190.13 |
| getRules | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:55 | CodeMirror/editor | 0.50 | 0.50 |
| (program) | :0 | other JS/native | 176.17 | 176.17 |
| (garbage collector) | :0 | other JS/native | 1.29 | 1.29 |

#### after: solid-codemirror, Shift+Tab

[CPU profile](profiles/solid-codemirror-after-outdent.cpuprofile) · [Browser trace](profiles/solid-codemirror-after-outdent.trace.json)

| Function | Source | Category | Self ms | Total ms |
|---|---|---|---:|---:|
| perform | ../../src/main.tsx:131 | command/store | 0.00 | 198.31 |
| apply | ../../src/main.tsx:107 | command/store | 0.00 | 15.43 |
| indent | ../../src/commands.ts:36 | command/store | 0.13 | 0.18 |
| runUpdates | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:819 | framework/list | 0.00 | 15.43 |
| batch | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:452 | framework/list | 0.00 | 15.43 |
| completeUpdates | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/dist/solid.js:835 | framework/list | 0.00 | 14.72 |
| normalizeIncomingArray | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/web/dist/web.js:612 | framework/list | 5.90 | 5.90 |
| insertExpression | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/web/dist/web.js:529 | framework/list | 1.09 | 11.41 |
| visit | ../../../react-codemirror/src/outline-index.ts:60 | framework/list | 0.38 | 1.89 |
| reconcileArrays | ../../../node_modules/.bun/solid-js@1.9.15/node_modules/solid-js/web/dist/web.js:135 | framework/list | 0.28 | 4.43 |
| handleEvent | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4578 | CodeMirror/editor | 0.00 | 201.63 |
| runHandlers | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:4588 | CodeMirror/editor | 0.00 | 201.10 |
| keydown | ../../src/main.tsx:225 | CodeMirror/editor | 0.00 | 198.49 |
| mount | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:107 | CodeMirror/editor | 4.11 | 4.62 |
| getKeymap | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:9134 | CodeMirror/editor | 0.53 | 2.10 |
| checkPrefix | ../../../node_modules/.bun/@codemirror+view@6.43.13/node_modules/@codemirror/view/dist/index.js:9154 | CodeMirror/editor | 0.51 | 0.51 |
| getRules | ../../../node_modules/.bun/style-mod@4.1.4/node_modules/style-mod/src/style-mod.js:55 | CodeMirror/editor | 0.51 | 0.51 |
| (program) | :0 | other JS/native | 108.57 | 108.57 |
| (garbage collector) | :0 | other JS/native | 0.13 | 0.13 |

### Before and after input work

| Variant | Rows | Input | Before handler p99 ms | After handler p99 ms | Before paint p95 ms | After paint p95 ms |
|---|---:|---|---:|---:|---:|---:|
| react-codemirror | 2000 | typing | 0.20 | 0.20 | 24.00 | 24.00 |
| react-codemirror | 2000 | Enter | 6.60 | 5.30 | 24.00 | 32.00 |
| react-codemirror | 2000 | Tab | 3.40 | 1.50 | 24.00 | 24.00 |
| react-codemirror | 2000 | Shift+Tab | 5.10 | 4.20 | 24.00 | 24.00 |
| react-codemirror | 2000 | Alt+ArrowUp | 3.00 | 0.20 | 32.00 | 24.00 |
| react-codemirror | 10000 | typing | 0.20 | 0.20 | 32.00 | 32.00 |
| react-codemirror | 10000 | Enter | 21.00 | 22.90 | 48.00 | 56.00 |
| react-codemirror | 10000 | Tab | 13.70 | 5.20 | 40.00 | 24.00 |
| react-codemirror | 10000 | Shift+Tab | 22.80 | 0.30 | 48.00 | 40.00 |
| react-codemirror | 10000 | Alt+ArrowUp | 14.20 | 0.20 | 40.00 | 32.00 |
| solid-codemirror | 2000 | typing | 0.20 | 0.20 | 24.00 | 24.00 |
| solid-codemirror | 2000 | Enter | 4.20 | 3.00 | 24.00 | 24.00 |
| solid-codemirror | 2000 | Tab | 3.90 | 3.20 | 24.00 | 24.00 |
| solid-codemirror | 2000 | Shift+Tab | 4.50 | 0.20 | 24.00 | 24.00 |
| solid-codemirror | 2000 | Alt+ArrowUp | 4.80 | 3.70 | 24.00 | 24.00 |
| solid-codemirror | 10000 | typing | 0.20 | 0.20 | 32.00 | 32.00 |
| solid-codemirror | 10000 | Enter | 13.30 | 10.30 | 48.00 | 40.00 |
| solid-codemirror | 10000 | Tab | 12.30 | 9.10 | 40.00 | 32.00 |
| solid-codemirror | 10000 | Shift+Tab | 14.20 | 0.20 | 40.00 | 40.00 |
| solid-codemirror | 10000 | Alt+ArrowUp | 15.70 | 0.20 | 40.00 | 40.00 |

### Correctness after command-store cutover

- react-codemirror: 11/11 passed.
- solid-codemirror: 11/11 passed.

### Changes and remaining work

- Both variants read commands from one framework-independent indexed outline, instead of materializing model() or scanning the page for row IDs and parents on every structural key.
- The implicit treap maintains subtree size, parent pointers and minimum depth incrementally. Rank, boundary lookup and subtree movement are expected O(log n); insert/delete/depth shifts are O(k + log n) for k affected rows. Text replacement remains keyed O(1).
- Split stores a text patch and one insertion, not copies of unchanged children. Merge stores the removed row and prior text. Move and depth inverses are constant-size operations; cross-block deletion retains only its deleted range.
- Order revisions change only when IDs are inserted, removed or reordered. Depth-only operations notify affected rows and do not invalidate the row list. Solid imports the React spike framework-independent outline-index module without importing React runtime.

- Rendering still projects all row IDs and reconciles a fully mounted list whenever order changes. That O(n) projection/reconciliation is deliberately retained as framework/list work, not hidden as an optimized command.
- CodeMirror focus/measure paths still force style and layout over the fully mounted page. Browser native work is visible in the trace and also under JS wrapper CPU frames such as focusPreventScroll; those measures overlap.
- Windowing must bound list projection/reconciliation, mounted DOM size and focus-induced style/layout/paint. This follow-up does not certify presented-frame budgets or declare spike 2 passed.

### Attribution limits

- Release bundles with source maps; CDP Profiler sampling interval 100 microseconds. Twenty Enter and twenty Shift+Tab presses per variant at 10,000 rows, DPR 1.
- Trace console timestamps bound each actual input through two animation frames. Target lookup, focus and runner model reads are excluded from sampled CPU attribution.
- CPU self/total times are statistical samples. Self samples produce the attribution buckets; function total includes descendants in other buckets. Renderer-owned list projections are framework/list, not command/store. CodeMirror/editor and unattributed native/JS samples are separate.
- Raw V8 profiles contain out-of-order observation timestamps (negative arrival deltas). Samples are sorted by reconstructed timestamp and interval-integrated inside input bounds, rather than treating signed arrival deltas as CPU durations. Raw profiles and per-profile normalization counts are retained.
- Browser style/layout/paint uses non-overlapping duration unions from CrRendererMain trace events inside the same input windows. CPU samples and browser trace durations are not additive because native work can appear in both.
- After Event Timing has no profiling active; it repeats the original 200 typing and 50 per-structural-command input counts at 2,000/10,000 rows, DPR 1. Load, heap, DPR 2 and ProseMirror were not remeasured.
- Reproduction: build both variants with --sourcemap, then run bun run --cwd spikes/editor/runner followup before|after. The report mode regenerates documentation from stored measurements without opening Chrome.
