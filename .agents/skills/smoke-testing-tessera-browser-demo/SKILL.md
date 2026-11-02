---
name: smoke-testing-tessera-browser-demo
description: "Builds and smoke-tests Tessera's wasm browser demo (demo.html, dist-demo, OPFS worker) end to end in headless Chromium; use to verify demo seeding, library and reader flows, exports and persistence."
---

# Smoke-testing the Tessera browser demo

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source the workspace and demo run.

Prerequisites: mise's WASM toolchain/LLVM tools and `wasm-opt`, an installed
Chromium with OPFS, and network access or supplied EPUB fixtures. Generate the
WASM package in the owned source.

## Build

```sh
(cd "$TASK_SOURCE" && CARGO_TARGET_DIR="$TASK_TARGET" mise run demo:wasm)  # pinned toolchain, llvm-ar and wasm-opt; serialize shared-target builds
(cd "$TASK_SOURCE/web" && bunx tsc --noEmit && bunx tsc --noEmit -p tsconfig.demo.json && task_run bun test src && bun run build:demo)
cp -R "$TASK_SOURCE/web/dist-demo/." "$TASK_DIST/"
```

- `tsconfig.demo.json` fails on missing `./pkg/tessera_web.js` until the wasm
  script has run; that is not a code bug.
- Quick Rust check (normal host environment, tool `cwd: TASK_SOURCE`):
  `AR_wasm32_unknown_unknown=$(rustc --print sysroot)/lib/rustlib/aarch64-apple-darwin/bin/llvm-ar CARGO_TARGET_DIR="$TASK_TARGET" cargo clippy -p tessera-web --target wasm32-unknown-unknown`.
  Also run native `cargo clippy --workspace --all-targets` there with the
  selected target, since `cfg` splits differ.

## Serve

From `TASK_SOURCE/web`, start
`task_run "$TASK_SOURCE/web/node_modules/.bin/vite" preview --mode demo --outDir "$TASK_DIST" --host 127.0.0.1 --port <owned-free-http> --strictPort`
as a unique named service with readiness on both `Local:` and the selected port.
Record its handle and origin; a port already held by a peer is not readiness for
this service. Avoid live ports 4317/4318/5173. Each new origin has empty OPFS
and reseeds the tour; use the same owned origin/profile within persistence
checks.

## Browser (`eval` `browser`)

- Use the shared owned Chromium launcher/CDP procedure with
  `TASK_RUN/profiles/demo`; attach
  `browser.open({name:'<TASK_ID>-demo', app:{cdp_url:'http://127.0.0.1:<recorded-cdp-port>'}})`
  and navigate to the owned `/demo.html` origin. Tern PiP is not OPFS
  acceptance.
- A fresh run-owned profile seeds the tour (Welcome page, Meditations source).
  Ready selector: `text/Welcome to Tessera` or `.outline-list`. Reuse only that
  same profile/origin for reopen and persistence tests, not another lane's
  profile.
- `tab.console()` / `tab.errors()` return `{entries,…}`, not arrays.
- Library: `role/button[name="Library"]`, rows `[data-library-row]`, tabs by
  text (`Highlights`, `All`). In the demo, Add opens the file chooser directly
  (no URL popup); upload via `tab.uploadFile('input[type=file]', path)`.
- Reader: source page → `role/button[name="Read" exact]` → `.reader-passage`;
  Contents → click a section. Highlight by selecting a DOM range in a passage
  text node, then `tab.press('h')`.
- Exports are blob downloads; capture by monkeypatching
  `HTMLAnchorElement.prototype.click` via `tab.evaluate` to `fetch(this.href)`
  and push the text to `window.__dl`. Avoid `waitForDownload` racing clicks
  ("Tab is busy").
- Reset demo uses `window.confirm`: `tab.setDialogs('accept')` first.
- Test EPUBs: download `https://www.gutenberg.org/ebooks/<id>.epub3.images` into
  `TASK_RUN/downloads` (2680 Meditations, 1022 Walking), or supply permitted
  local copies. Retain exports and their checks in `TASK_EVIDENCE`.

## Cleanup

Retain screenshots, exports, console/errors and the selected OPFS profile in
`TASK_EVIDENCE`, then follow shared teardown for the browser launcher and
preview service. `web/src/demo/pkg` and `web/dist-demo` remain generated outputs
of the owned source, not peer cleanup targets.
