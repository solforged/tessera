---
name: auditing-tessera-rendering-jitter
description: "Measures painted frames in WebKit (Tern WKWebView pane or Playwright WebKit) against a throwaway notebook when investigating Tessera or other web UI jitter, flicker, scroll jumps, reflow flashes, or \"re-rendering\" reports."
---

# Auditing Tessera rendering jitter

The user's "WebKit jitter" reports (new lines, cut, merge, fields, library tabs,
covers, outline scroll jumps) turned out to be Tessera bugs that paint wrong
frames, not engine bugs. Prove with per-frame numbers whether a visible jump is
the app's code or the engine.

## Setup

- Complete
  [managing-tessera-task-workspaces](../managing-tessera-task-workspaces/SKILL.md)
  and source its prepared environment. Give old/patched comparisons separate
  prepared runs.
- Allocate a fresh destination with `mkdir "$TASK_RUN/notebooks/jitter"`, then
  copy the explicit source read-only using
  `/usr/bin/sqlite3 -cmd ".timeout 20000" "file:<source>/notebook.db?mode=ro" ".backup \"$TASK_RUN/notebooks/jitter/notebook.db\""`,
  plus its objects. Apply the shared copied-lock/sync-detachment safeguards
  before serving. Never write the source notebook/registry or exercise host
  Sharing/Pair during QA.
- Build matching web assets into `TASK_DIST` and stage a pinned RELEASE
  executable at `TASK_BIN` through the shared build procedure. A debug binary
  makes API requests 10x slower and distorts hold/settle timing. Serve with
  `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/jitter" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`
  and record actual origin/ports.
- One notebook per server (`service.lock`). Old/patched runs start from
  identical stopped pristine fixtures and retain binary/assets provenance plus
  before/after results in `TASK_EVIDENCE`.

## Capture: which tool shows the truth

- Ordinary animations (mode fades, folds, popups) and outline edits: an owned
  Tern WKWebView pane, if the host Tern preview tool and
  `tern-browser-and-preview` skill are available. Record the exact pane
  block/owner; do not re-home the harness-owned process or borrow the user's
  private page. Wrap its `tern browser` eval call as `qeval`, navigate via
  `location.href=` and wait for the tested state; capture bursts take about 30
  ms per capture. If this harness cannot provide a private context, use the
  task-run WebKit harness instead.
- View transitions (pane navigations, cover travel): Tern capture LIES. It
  paints live DOM while rendering is suppressed (shows a blank pane during the
  hold) and omits `::view-transition-new` content. Use Playwright WebKit video
  instead:
  - An available version-matched Playwright WebKit installation is a
    prerequisite. Provision tool files and browser binaries under
    `TASK_RUN/tools` under normal host HOME; do not assume a wiped scratch
    script or global cache is present. Launch the harness with `task_run` and an
    explicit browser path.
  - `webkit.launch()` with the isolated HOME/XDG environment, then a private
    context with `colorScheme: 'dark'`, viewport `{width:1440,height:900}` and
    `recordVideo: {dir: <TASK_EVIDENCE/video>, size:{width:1440,height:900}}`;
    drive with `page.evaluate` clicks/state waits and log `Date.now()` marks.
    Record the exact browser/context handles and retain storage/profile state as
    applicable; downloads go to `TASK_RUN/downloads`.
  - `addInitScript` wrapping `document.startViewTransition` to log vt-start,
    callback done (with `data-entered`, remaining `[data-pane-pending]`, named
    elements), `ready` rejections and `finished`; sample
    `document.getAnimations()` pseudo-element animations at ready, +30, +80 ms.
  - Frames:
    `ffmpeg -ss <s> -t <s> -i <retained-video.webm> -fps_mode passthrough <TASK_EVIDENCE/frames>/%03d.png`
    (25 fps), contact sheet with PIL. Video-vs-mark offset drifts by up to ±200
    ms; take wide windows and find the change visually. Available ffmpeg/PIL are
    prerequisites, not supplied scratch tools.

## Driving the outline (Tern pane)

- Focus a row: dispatch pointerdown/mousedown/pointerup/mouseup/click on its
  `.static-text` (match `[data-block-id]` by id suffix).
- EditorView handle: `document.querySelector('.cm-content').cmTile.view`.
- Keys: dispatch
  `KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true,cancelable:true})`
  on `.cm-content`; for merge set the selection to 0 then Backspace; Tab for
  indent.

## Sampling rule for in-page probes

Sample after paint: `requestAnimationFrame(() => setTimeout(sample, 0))`. A
plain rAF sampler runs before the app's own rAF callbacks and reports states
that never paint (false positives).

## What to record per painted frame

- `getBoundingClientRect()` of rows, `.cm-editor`, popups, cards, toolbar rows;
  `scrollTop` of scrollers; text of status/empty messages. Report the max row
  offset from the final frame.
- Frame rate / main-thread cost: an rAF loop collecting intervals; time forced
  layout (`offsetHeight`) after setting geometry vs transform styles.
- Find who moves the scroll: patch the `Element.prototype.scrollTop` setter,
  `scrollTo/scrollBy/scrollIntoView` and `HTMLElement.prototype.focus` to log
  `new Error().stack`, plus a capturing `scroll` listener. Retain fetched
  minified assets and frame coordinates under `TASK_EVIDENCE`; inspect the
  relevant line/column and search the owned source to map the stack. Do not
  modify the live origin or source notebook for probes.
- Compare old vs patched builds with the same action and report a before/after
  table.
- Library: click `.library-pane .mode-tabs button` by label (layout buttons by
  aria-label List/Shelf); Reading now cards `.library-reading-card`; shelf
  `.library-book-open`.

## Pane-motion facts (web/src/ui/pane-motion.ts)

- WebKit pauses rAF during a held transition callback (test: count rAF ticks
  across `startViewTransition(async () => sleep(400))`: 1 tick). Anything that
  needs frames to finish (reader position restore) can never be ready inside the
  hold; such surfaces use `data-pane-loading`, not `data-pane-pending`.
- Solid `lazy()` panes render nothing for a microtask after mount even when the
  module is cached (createResource), so an empty `.pane-content` must count as
  pending.
- WebKit silently aborts a running transition (finished ~50 ms after ready,
  ready NOT rejected) when a named element is removed mid-animation, e.g. a
  `<For>` re-keyed because a refresh produced new row objects. Keep unchanged
  rows' identity (`keepRows` in library/query.ts).
- Mode panels marked `aria-busy` are held at opacity 0 (paused fade) until rows
  land, capped at the 400 ms hold.
- Tern WKWebView rAF runs at 60 Hz on 120 Hz displays (macOS 27).

## Bugs found

- Outline scroll jumps came from `restoreAnchor` aligning to start before
  correcting; fixed by `scrollToOffset(item.start - anchor.offset)`.
- 2026-10-12 Outline (2fcb664, db80ab9, f558920), Review (a00d73c), Library
  (bb5dd66, 5e1dc1f): see git log.
- 2026-10-14 (05c332a): lazy panes settled empty; reader held 400 ms for frames
  it never got; busy tab panels showed rows at full then dipped into the fade;
  Reading now cards flashed spines on articles (rows had source.format `record`;
  now `snapshot_format`); back-to-Library cover travel aborted by remounted
  cards.

## Cleanup

Retain frame samples, video, profiles, screenshots and before/after tables in
`TASK_EVIDENCE`, then follow shared teardown for the recorded
pane/browser/service resources. After an authorized fix, the integration owner
runs `bun run typecheck` and `bun test src/outline` (or the touched area) once
after integration; audit lanes do not build/test mid-flight.
