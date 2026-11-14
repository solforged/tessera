---
name: creating-tessera-iphone-plates
description: "Creates iPhone (iOS 27, 18 Pro) mockup plates of Tessera surfaces and builds approved plates into the app; use for simulator walkthroughs, static HTML plates, parallel design lanes, before/after galleries and foundation or surface build lanes."
---

# Creating Tessera iPhone plates

Static HTML plates at iPhone 18 Pro size (402×874 pt, @3x) in Tessera's own
tokens, fonts and glyphs, with drawn status bar, Dynamic Island and home
indicator.

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source each lane's workspace and run, with one integration owner.

The kit/fonts/brief/helpers below are external prerequisites, not
checkout-provided tools. Copy required runtime helpers to `TASK_RUN/tools`; keep
new plates, manifests, briefs, screenshots, notes and gallery in
`TASK_EVIDENCE`. Browser-launching helpers must support the shared owned
profile/launcher/CDP lifecycle; otherwise report that missing capability.
Browser plates are simulations; native iOS/WebKit acceptance stays host-side.

## Latest kit: reuse it

`~/artifacts/tessera/2026-10-29-ios/` is the newest round. Copy `kit/`
from there:

- `ios.css` v2 is a fixed phone vocabulary that the user accepted. Its top
  comment lists it:
  - content scrolls under the chrome, with `.edge-top` and `.edge-bottom`;
  - three capsule buttons: `.btn.stamp` (the one gilt primary), `.btn.tint` and
    `.btn.plain`;
  - `.leaf` at 14 pt radius, `.seg`, `.strip` (mode tabs), the `.search` well
    and `.menu` pull-downs;
  - sheets with an `xmark` close, `.check`, `.doing` and `.done`, and `.caret` and
    `.sel-handle` in gilt.
- `tokens.css` comes from the round's pinned commit:
  `git -C "$TASK_SOURCE" show <pinned-sha>:web/src/tokens.css`.
- Fonts:
  - Piazzolla's standard cut carries the `opsz` axis.
  - SFNS and SFNSMono stand in for Berkeley Mono, which iOS does not bundle.
- `plates/kit/specimen.html` is the reference plate.
- Tools:
  - `tools/shoot.mjs` renders the plates with headless Chrome for Testing and a
    coarse pointer.
  - `tools/index.mjs` builds the gallery, with before and after shots, fix
    chips, decisions and engineering notes in a `<details>`.
  - `tools/sim.mjs` drives the simulator, taking the SIM and PORT environment
    variables.
- `BRIEF.md` is the plate contract.

Resolve Python under normal host HOME, then serve the new `TASK_EVIDENCE` round
via
`task_run <absolute-python3> -m http.server <owned-free-port> --bind 127.0.0.1 --directory <absolute-round-path>`
as a unique named service. Detach it only for an explicitly retained gallery
handoff recording the handle, origin, backing evidence path and next owner;
never delete files while that gallery is retained.

Kit gaps to fix before the next round:

- `.edge-top` is too weak: make it about 150 pt with a 14 px blur.
- `.seg` is 36 pt; make it 44.
- `kit.js` hard-codes 9:41.
- `<i data-icon>` drops its classes.
- The kit has no filter, indent or outdent glyphs.
- The `find` glyph is an eye; use `search`.

## Walkthrough first

1. Set up this run's owned simulator and private detached seed per
   `installing-tessera-ios-builds`, building from the pinned `TASK_SOURCE`. Do
   not borrow another lane's simulator or notebook.
2. Drive it from a persistent JS `eval` using the required helper with this run's
   explicit SIM/PORT: `sim.connect()`, then `ev(...)`.
   - Use `axe tap` for real touches and `axe touch --down/--up` for long-press.
   - Never use `axe type`.
3. Capture every surface, light and dark.
4. Write `notes.json` with themes (T…), bugs (B…) and per-screen notes, then
   build the gallery and open it in Tern.
5. When the round builds on an unlanded commit, also capture that build into
   `current/`. Verify that every capture shows the intended screen.

## Plate lanes

- Run one `task` per surface group: system overlays, Today, Agenda, Review,
  Library and the reader, pages, and Settings and onboarding.
- Each lane owns a distinct `TASK_EVIDENCE/plates/<lane>/` handoff and writes
  its `manifest.json` with plates, fixes, notes, decisions (with picks) and
  engineering. Its mutable browser/simulator state remains in its own prepared
  run; do not share a profile or service across lanes.
- Review dark and light PNGs as lanes finish, and send fixes with
  `write agent://<Lane>`.
- Shared components drift between lanes: the task row did on 2026-10-29. Send
  both lanes one exact spec.
- After a consistency change, check that references inside written text keep
  their link cue.
- Recurring fixes:
  - Meta text belongs in captions, not on the device.
  - Use Tessera tokens inside system surfaces.
  - Use real seed names.
  - Context menus need a blurred, dimmed backdrop.
  - Never let text show unfaded between the nav circles.
  - Set only the figure in mono.

## Building approved plates

The phone layout is CSS only: `@media (max-width: 599px) and (pointer: coarse)`
in `web/src/styles.css`, plus `isPhone()` in `web/src/ui/phone.ts`. Desktop must
stay unchanged.

1. **Base.** Use the owned integration source with required base commits/patches
   transferred to it. Integrator gates: `bunx tsc --noEmit`, web tests through
   `task_run` with `TESSERA_TEST_BINARY="$TASK_BIN"`, and Vite build into
   `TASK_DIST`; run once after the batch integrates.
2. **Brief.** Write the shared lane brief in `TASK_EVIDENCE` (the historical
   2026-10-29 example was `/tmp/tess-ios/BUILD-BRIEF.md`):
   - the plates are the spec;
   - phone-only scope;
   - each writer has an owned source tree and separate prepared run, notebook
     copy, simulator/browser profile, named services and ports; read-only plate
     finders may share source but never runtime state;
   - the external `phone.mjs` is a prerequisite for its screenshot method:
     resolve its supported invocation, require a run-owned Chrome for Testing
     launcher/profile/CDP endpoint, and capture to `TASK_EVIDENCE`. Browser
     simulation uses 402×874 @3x,
     `--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1`,
     `isMobile`/`hasTouch` and CDP touch; it is not real-device proof;
   - no gates in source-writing lanes; the integrator verifies after all changes
     land;
   - use scoped commits/patches for transfer and normal applicable signing/hook
     rules in each owned tree; do not disable repository protections as a
     default recipe. Pass the originating skill/brief paths even when the lane
     base predates uncommitted skills.
3. **Phase 1, foundation.** Run three lanes in parallel:
   - chrome: glass nav bar with `NavEnd`, `NavButton`, `NavGroup` and
     `NavTitle`; inline prose title; Button kinds; `ListGroup`, `ListRow` and
     `PropertyRow`; `Seg`; `SearchWell`; glyphs;
   - overlays: phone pull-down `Menu`; `longPress` and `openContextMenu`; sheets
     with title, × and an optional scrim; `showNotice`; `haptic()`;
   - native: `main.mm` script handlers `tesseraHaptic` and `tesseraEditMenu`,
     the `buildMenuWithBuilder:` swizzle that puts color dots in the selection
     menu and fires `tessera:edit-menu`, and a gilt `tintColor`. Integrate, run
     the gates, then write a FOUNDATION-API doc for the next phase.
4. **Phase 2, surfaces.** Run eight lanes in parallel: system, task row (shared
   between Today and Agenda), Today, Agenda, Review, Library and the reader,
   pages, and Settings.
   - Agent ids collide with the plate round's lane names (they become `-2`);
     broadcast the real ids.
   - Cherry-pick each scoped lane commit with
     `git -C "$TASK_SOURCE" cherry-pick -S <sha>` into the owned integration
     branch; resolve the batch, then run the integrator's gates once.
   - Expect duplicate-import merges and lanes' untypechecked TSX.
5. **Verify.**
   - Walk the integrated build in a run-owned browser/profile at an owned
     origin, using the shared `task_run` named-launcher/CDP procedure. A
     round-specific `walk.mjs` is an explicit required helper if selected, not a
     supplied repository tool. Save screenshots/contact sheets to
     `TASK_EVIDENCE`; Chrome can render `<img>` tiles without assuming
     ImageMagick is installed.
   - Compare desktop at 1280×800 against a pure pinned-base build in a separate
     prepared run with its own binary, assets, notebook, profile and origin.
   - Then build the simulator app in `TASK_SOURCE`
     (`bun run --cwd "$TASK_SOURCE/web" build:mobile`, then
     `ts-ios-build --debug --target aarch64-sim` there with the
     selected target), install only on this run's owned walkthrough simulator,
     and check real selected-UDID AXe touches: accessory bar, native edit menu,
     swipes, review gestures and first launch on a fresh owned simulator.
   - Send bugs back with the integrated SHA and evidence. A lane owner preserves
     unfinished work and integrates the new base in its own tree, or prepares a
     new owned tree; never hard-reset a lane or shared checkout for it.
6. **Finish.**
   - Fix the docs' Vale errors (the base already has 8).
   - Write the CHANGELOG yourself.
   - Keep commit bodies within 72 columns and preserve applicable signing rules
     in the owned integration branch; do not rewrite peers' branches or shared
     main to tidy messages.
   - Only if landing is explicitly authorized, use
     `ts-land --title ... --wait` with tool `cwd: TASK_SOURCE` (about
     14 minutes). Shipping and physical-device installation require their own
     exact authorization; an approved plate build is not permission to publish.

Pitfalls:

- A named service's port check can pass because another lane's server already
  holds that port. Wait on `log: "service listening"`.
- A JS `.click()` bypasses `inert` and scrims, so test popup blocking with real
  `axe` taps.
- `ListRow` carried `role="listitem"` on a `<button>` and lost its button
  semantics; it was removed.
- The native edit-menu bar fits five dots; Annotate falls behind ›.

When the user is done, retain the gallery/notes/captures in `TASK_EVIDENCE` and
follow shared teardown. Keep an explicitly retained gallery/trial's backing
files and record its service handle and next owner; do not silently delete the
user's review surface.
