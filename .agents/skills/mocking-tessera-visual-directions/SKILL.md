---
name: mocking-tessera-visual-directions
description: "Explores Tessera palette, typography, layout, and per-view UX proposals across desktop, Fold unfolded, and Fold cover before code changes, using real-app restyling, injected prototypes, captured-shell structural mocks, and plate rounds for user review."
---

# Mocking visual directions and new views on the real Tessera app

Show the user directions and new surfaces on real screens, not abstract mockups.
Techniques: A restyle the running app (palette/type), B inject a prototype into
one existing view, C graft a new view onto a captured shell with mock.js, D a
plate frame that injects HTML fragments into captured shells (best for wide
rounds with many plates), E a per-view UX review with static proposal plates.
Nothing is committed until the user picks.

## Notebook and browser (all techniques)

- Complete
  [`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
  and source its prepared environment. Keep mock sources/shots and design
  decisions in `TASK_EVIDENCE`.
- Copy the selected notebook into `$TASK_RUN/notebooks/mock` using the shared
  copied-lock/sync-detachment safeguards, then start
  `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/mock" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`
  (or matching embedded assets). Browsing writes reading positions, so never
  point the mock browser at the real notebook.
- Use the shared fresh Chrome for Testing launch with
  `$TASK_RUN/profiles/<device>` and
  `--headless=new --window-size=1440,900 --hide-scrollbars`; attach to the
  recorded CDP endpoint. Keep one profile/process per device/window and runtime
  tools under `TASK_RUN/tools`.
- `tab.run` cannot see `document`; use
  `tab.evaluate(\`(${fn})(...${JSON.stringify(args)})\`)` for page code.
- `tab.screenshot({silent:true,format:'png'})` ignores `path` and returns a temp
  path; copy it immediately into `TASK_EVIDENCE`. Blur `document.activeElement`
  before each shot. Keep the same origin/profile within persistence checks.
- Navigate: `.global-search` click, type into `.picker-input`, Enter. Sidebar
  buttons by text (`.sidebar .button`), Library tabs (`.library-pane button`).
  There is no URL routing.
- Touch screens: CDP `setTouchEmulationEnabled`, `emulate({hasTouch})` and
  `setEmulatedMedia` do NOT flip `(pointer: coarse)`/`(hover: none)`. Launch a
  second task-run Chrome for Testing with its own profile and
  `--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1`,
  set size via `tab.run(({page},v)=>page.setViewport(v),{args:[v]})`, reload and
  verify with `matchMedia('(pointer: coarse)')`. Record its separate
  endpoint/launcher handle.
- Sizes: desktop 1440×900 DPR 2 mouse; Fold unfolded 1088×821 DPR 2.25 touch;
  Fold cover 554×876 DPR 2.25 touch (cover chrome applies under 600 px with a
  coarse pointer).
- Don't name a helper `snap` in the `eval` kernel if you also store snapshot ids;
  globals collide.

## A. Restyling the private app copy (palette, typography)

- Write overlay CSS with per-direction `:root{...}` blocks overriding the token
  names in `web/src/tokens.css` and inject it into a `<style id="vl">` via
  `tab.evaluate`.
- Fonts: Tessera's CSP blocks `data:` @font-face. Load fonts with
  `new FontFace(name, arrayBuffer, {weight:'100 900'})` plus
  `document.fonts.add` inside `tab.evaluate`, passing base64 and decoding it in
  the page. Check `document.fonts` status shows `loaded`, not `error`. Fonts
  survive SPA navigation, not reloads.
- Capture the same states for each direction: journal (`text/Today`), a content
  page (via the `.global-search` finder), Library → Highlights, and a source
  page with the reader opened beside it (Shift-click its Read button).

## B. Injected prototype of one view (reader round, 2026-10-11)

Faster and more honest than static plates when the change is layout or
typography inside an existing view: run the real app on a throwaway notebook,
inject a CSS file plus an idempotent in-page script, screenshot.

1. Seed the owned run notebook with the pinned release `TASK_BIN` under
   `task_run` and an exact named service/owned HTTP+sync ports, then
   `task_run "$TASK_BIN" --workshop <owned-notebook> add --wait <epubs>`. Real
   books with messy markup make good private cases: Huizinga's Waning of the
   Middle Ages (caps paragraphs as headings), Bailyn's Ideological Origins
   (headings are links), Hemingway's Farewell to Arms (running heads in the TOC,
   whole text tagged as quote). Do not publish private/copyrighted content as a
   gallery without authorization.
2. Drive the private Chrome for Testing endpoint from Setup, or run a
   bun/playwright-core harness via `task_run` from `TASK_SOURCE` with the
   discovered executable path and its own `TASK_RUN/profiles/<device>`
   persistent context (node cannot import this bun-oriented harness). Reader
   layout via `localStorage['tessera.reader']`, then reload. Open a book:
   sidebar Library → `.library-reading-card`/`.library-row-open` → button
   `Read|Continue reading` → wait `.reader-passage`. Jump: `.reader-contents`
   click → `.reader-toc-entry` by text. Create highlights: select a DOM range in
   `.reader-passage`, dispatch `selectionchange` + `mouseup`, press `1`–`5`/`h`;
   on touch click the toolbar's `Highlight and note`.
3. Passages are `.reader-passage[data-ordinal]` inside absolutely positioned
   `.reader-row`s measured by ResizeObserver, so inserting siblings or hiding
   passages re-flows correctly. The title block `.reader-title-block` is
   absolute and observed too; don't make it static. Run the injected script 2–3
   times with short waits so lazily mounted rows get the treatment; store any
   original text you overwrite in a data attribute (later passes read it).
4. Render plates in independent task-run browser processes/contexts per device
   or lane, writing only that lane's `TASK_EVIDENCE` paths. Historical
   throughput was about 1 min for 18 plates in 3 bun processes. Make retained
   comparison crops with PIL (an explicit prerequisite) for treatments that
   differ subtly.

## C. Structural mock on a captured shell (one view, mock.js)

Used 2026-10-11 for the notes Index, note views, spreads and note header
(`~/Documents/tessera-design/notes-index-mock/`).

1. Serve the owned notebook copy, open the base page in its private profile,
   blur focus and save `document.documentElement.outerHTML` under
   `TASK_EVIDENCE/mock`.
2. Download every referenced `/assets/*.css` plus its `url(...)` fonts into this
   mock's `assets/`; rewrite absolute asset URLs to relative, retaining the
   source/build provenance.
3. Strip `<script>` and `modulepreload` links, append your CSS/JS → `app.html`.
   Stop only the recorded capture server after all dependent captures finish.
4. If available, the historical `mock.js` template replaces regions
   (`aside.sidebar section.page-list`, `.pane.active .pane-header`,
   `.pane.active .pane-content`); it is not a supplied repository tool.
   Obtain/review a source artifact before using it, record provenance and adapt
   a task-local copy. Reuse app classes/tokens only; missing template sources
   are prerequisites, not runnable guessed paths.
5. Real content beats lorem: use permitted site notes from
   `~/src/site/src/content/entries` and `~/src/site/src/data/references.json`,
   read-only and coordinated with its owner.
6. Wrapper `index.html` with scene buttons posting into a scaled iframe; serve
   only this retained mock folder on loopback with
   `task_run python3 -m http.server <owned-free-port> --bind 127.0.0.1 --directory <mock-folder>`
   as a unique named service. Record the exact handle/origin.

## D. Plate frame for wide rounds (many directions, parallel lanes)

Used 2026-10-11 for cards/fields/perspectives (`cards-fields-2026-10-11/`, 35
plates, 7 lanes), the Library metadata editor (`library-editor-2026-10-11/`, 12
plates, 3 lanes) and 2026-10-12 for sync status (`sync-indicator-2026-10-12/`,
21 plates, 3 lanes, ~17 min). Those are historical citations, not installed
tools. Prerequisites are available reviewed sources for `frame.js`,
`index.html`, `tools/shoot.mjs`, `tools/capture.mjs`, `plates/shared.css`, fonts
and the brief template from a retained round. Record their provenance, adapt
task-local copies under `TASK_RUN/tools`, and retain final mock sources under
`TASK_EVIDENCE`. If absent, report the missing sources rather than
assume/reimplement them in this procedure.

1. With those prerequisites, run the adapted capture tool under `task_run`,
   resolving playwright-core from this owned source's lockfile install and the
   available Chrome for Testing executable. It writes shells (scripts stripped,
   CSS/fonts localized, shared.css/frame.js wired) and `ref/<name>.png|html`
   current-state shots under `TASK_EVIDENCE`. Edit its owned-origin navigation
   steps per surface; the app uses `html[data-theme]`.
2. **Multi-shell rounds (desktop, Fold unfolded, Fold cover):** capture one
   shell per device: `app.html` desk, `app-fold.html`, `app-cover.html` (sizes
   above; touch shells from the second Chrome for Testing). The sync round's
   `shoot.mjs --shell=desk|settings|fold|cover` picks size/DPR/touch per shell;
   manifests carry `shell` per plate and the index maps it to the live link.
   frame.js regions there: `pane`, `pane-header`, `crumbs`, `header-end`,
   `panes`, `workspace`, `rail-end`, `sidebar-foot`, `bottom-nav`, `overlay`,
   `script`.
3. After capture fix the shells: lazily loaded CSS links stay absolute
   (`http://127.0.0.1:<port>/assets/...`) and break when the server stops;
   rewrite to retained local `assets/`. Download
   `<img src="/api/snapshots/...">` covers into this mock's `covers/` and
   rewrite. Strip the throwaway notebook marker (`span.notebook-marker`) and
   private runtime-path text without altering the retained provenance manifest.
4. Replica shells need a real private replica: serve the owned hub copy,
   `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/replica" sync clone <recorded-private-hub-origin>`,
   then serve it with a distinct named service and owned HTTP/sync ports. To
   show "waiting/unreachable", create a page through its `POST /api/batches` and
   stop only the recorded hub. Retain both notebooks' provenance/screenshots
   before exact teardown; never connect the mock replica to a real hub or host
   Sharing/Pair.
5. Seed permitted real data:
   `task_run "$TASK_BIN" --workshop <owned-notebook> add --wait <epubs…>` from
   an explicitly selected source, never by default ingest the user's whole
   Calibre Library. Set reading positions via the owned origin's
   `POST /api/snapshots/<id>/position {"ordinal":N}`.
6. `frame.js`: `<shell>.html?p=<id>&theme=` injects `<template data-region>`
   fragments; `data-select`, `data-recent`, `data-height`. Scripts:
   `<script type="text/x-plate">`.
7. Lanes: one per surface group, each with its own prepared runtime and only its
   owned plates/manifest/shots. Retain the whole contract in
   `TASK_EVIDENCE/BRIEF.md` (decisions already made, states every direction
   covers, real names, sample values, current API data and what the backend does
   NOT record). Source-writing lanes have separate worktrees and transfer scoped
   patches to one integration owner. Ask for a `decisions` list with picks and
   an `engineering` note; the index renders it as "What it needs". Agree on
   shared wording through messages, not a shared mutable checkout/profile.
8. Review every PNG yourself (PIL contact sheets of 4–5 shots are fast) and send
   fixes back to the idle lane via `write agent://<id>`. Recurring lane
   mistakes: gilt on every link, two popups at once, invented phone headers, em
   dashes, typewriter apostrophes, lowercase "the Mac" fallbacks used as
   headings.
9. Add a P0 "Today" section of real `ref/` captures to the index so the user
   sees the current state next to proposals.

## E. Per-view UX review across desktop and the Fold (current state, then proposals)

1. Capture each view at each size through the private browser: sidebar buttons,
   Library tabs, source row, `Read`; set Scroll/Pages via
   `localStorage['tessera.reader'].layout` and reload. Name files
   `<ctx>-NN-view.png` under `TASK_EVIDENCE/ux-review/current/`.
2. Static proposal plates (when the view does not exist yet): HTML per plate
   under `TASK_EVIDENCE/ux-review/mocks/<view>/` with shared CSS/tokens and
   available licensed fonts. Font inputs are prerequisites: Piazzolla/Plex woff2
   from the owned source's `web/node_modules/@fontsource-variable/*/files`, and
   Berkeley Mono from an available permitted
   `~/src/site/public/fonts/berkeley-mono.woff2`; do not assume external files
   exist or publish licensed assets without authorization. Use permitted real
   book text, highlights and TOC from the private snapshot API
   (`/api/sources/<id>`, `/api/snapshots/<snap>/passages?from&limit=200`,
   `POST /api/highlights/query`, `/api/passages/search?q=`); compute times left
   from word counts at 250 wpm. Label invented data as samples and count claims
   (e.g. matches) before publishing.
3. Render each plate at its own size from the page server (`emulate` viewport to
   the plate's html/body size, `document.fonts.ready`, screenshot) and review
   every PNG; common breakages: inline links inside flex bullets (wrap text in
   one span), class collisions between shared CSS files, mid-word wrapping in
   small spine tiles (show only the siglum below ~80 px).

## Typography defaults

Left-aligned (ragged-right) text, never justified; sentence-case chapter titles
in plates.

## Presenting

- Serve the retained gallery folder with
  `task_run python3 -m http.server <owned-free-port> --bind 127.0.0.1 --directory <retained-gallery>`
  as a unique named service. Do not detach it by default. If the user wants it
  retained, record the exact service handle, origin, folder, owner and stop
  instructions before setting `proc://<name>/mode` to `detached`. Index style:
  Orrery tokens, mono eyebrows, rubric numbers, click-to-zoom dialog; the
  historical `~/Documents/tessera-design/ux-review-2026-10-11/index.html` is a
  possible reviewed template only if available. Proposed sections (P1…) go above
  current-state shots with captions, real-vs-sample ledes and a numbered
  "Decisions, with my picks" list.
- Show it in an available host Tern pane only if the preview tool/context is
  available: open a new owned block on the recorded loopback gallery origin and
  record its owner/block. Do not navigate a user's borrowed/signed-in pane or
  re-home the harness-owned Tern process. If the user is browsing the gallery,
  inspect headlessly through the private browser instead of scrolling their
  view. Native preview remains host-side; missing tools are explicit
  prerequisites.
- Retain gallery/mock sources, shots, profiles and manifests in `TASK_EVIDENCE`,
  then follow shared teardown; the ledger must identify any retained gallery
  service and next owner.

## Current state

The user picked Orrery, with Plex Sans for writing and Piazzolla for headings.
Historical galleries: 2026-10-10 UX review (P1–P5) at
`~/Documents/tessera-design/ux-review-2026-10-10/`, round two (P6–P8) at
`ux-review-2026-10-11/`, reader round one (P9 titles from contents, P10 progress
at the foot, P11 highlight lower band) at `reader-2026-10-11/`, with historical
scripts `reader-2026-10-11/scripts/{proto.js,proto.css,plates.mjs}`.
Obtain/review actual sources before reuse. Their old `/tmp/tessera-rd-cap/`
hard-code is a migration prerequisite: adapt a task-local copy to
`TASK_RUN`/`TASK_EVIDENCE`, private profiles and owned origins; do not recreate
that fixed scratch directory as a runnable default.

## Deliver and build

- Report surfaces, directions and the decisions with picks, plus engineering
  consequences.
- Before turning any draft into code, run its color and font changes through
  `web/src/tokens.css`, and put the reasons in `docs/design.md`.
- When the user approves implementation, retain an API contract in
  `TASK_EVIDENCE` (wire fields, health/state model, wording table) and give Rust
  (`crates/**`) and web (`web/**`) writers separate owned trees through the
  shared procedure. The Rust lane messages API/smoke details; the integration
  owner updates `docs/surfaces/*.md`, `docs/design.md` and relevant docs such as
  `docs/sync.md`, then runs phase-end checks once. Use
  `landing-lane-patches-around-dirty-peer-trees` and
  `shipping-tessera-live-builds` only if landing/shipping is separately
  authorized.
