---
name: testing-tessera-emulator-reader-touch
description: "Tests Tessera reader touch gestures, motion timings, full-screen and cover-screen layouts, and system-bar behavior on the tessera_fold8 emulator via WebView CDP; use for real-touch reader QA and layout measurements."
---

# Testing Tessera emulator reader touch interactions

Drive real touch input with `adb`; inspect and time the DOM through the WebView's
CDP socket.

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source the workspace and private emulator run.

Prerequisites: an installed foldable image/template, Android toolchain and
permitted test book. This is host-side emulator acceptance, not authorization to
install on the physical Fold.

## Setup

1. Create a fresh run-owned foldable AVD per
   `smoke-testing-tessera-android-app`, keeping its files under
   `TASK_RUN/tools/avd`. Record its unique AVD name, emulator service handle,
   owned port pair and actual `SERIAL`. Check
   `adb -s "$SERIAL" shell cmd device_state print-state` before each test (2
   inner, 0 cover). Fold/unfold only with `adb -s "$SERIAL" emu fold` /
   `adb -s "$SERIAL" emu unfold`.
2. With tool `cwd: TASK_SOURCE`, build
   `CARGO_TARGET_DIR="$TASK_TARGET" mise run android:build`, then
   `adb -s "$SERIAL" install -r "$TASK_SOURCE/crates/tessera-mobile/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"`.
   Record the intended source changes and APK hash; use shared target/exception
   handling rather than peers' dirty source.
3. Launch with
   `adb -s "$SERIAL" shell am start -W -n dev.tessera.android/.MainActivity`. A
   cold launch can open quick capture or the sync-setup sheet; dismiss with
   `adb -s "$SERIAL" shell input keyevent 111` (Escape). Avoid `keyevent` 4, which
   can close the activity. If the fresh emulator needs onboarding/content, use
   only its local throwaway notebook and the explicitly permitted seed
   procedure; never join a live hub.
4. Forward again after every relaunch: read the pid with
   `adb -s "$SERIAL" shell pidof dev.tessera.android` in its own call, then
   `adb -s "$SERIAL" forward tcp:0 localabstract:webview_devtools_remote_<pid>`.
   Record the returned port; do not use a fixed 9333 or inline a possibly stale
   pid after launch.
5. Attach
   `browser.open({name:'<TASK_ID>-reader-webview', app:{cdp_url:'http://127.0.0.1:<recorded-forward>', target:'tauri.localhost'}})`.
   Close the old attachment first. Every guest `input`, `dumpsys` or `am`
   fragment below is prefixed with `adb -s "$SERIAL" shell`; no unscoped ADB
   input.

## Screenshots

- Capture `adb -s "$SERIAL" exec-out screencap -p` as binary into
  `TASK_EVIDENCE`, selecting the measured display id when necessary or removing
  only bytes before the PNG signature if a multiple-display warning is
  prepended. Preserve the full original. A smaller inspection derivative can be
  made with
  `sips -Z 1000 "$TASK_EVIDENCE/<shot>.png" --out "$TASK_EVIDENCE/<shot>-small.png"`.
  Read the PNG only after the write finishes; do not use shared `/sdcard/a.png`
  or host scratch names.

## Input

- Device px = CSS px × measured DPR (historically 2.25). Get element rects with
  `tab.evaluate`, then `adb -s "$SERIAL" shell input tap X Y`.
- Enter reader full screen: tap `.reader-full-screen` (unfolded only; hidden on
  cover), or dispatch a `keydown` `f` on `.reader-pane` to toggle.
- Center tap toggles reader chrome (e.g. `input tap 1700 1000` unfolded).
- Long-press to select text: `input swipe x y x y 900`.
- Drag or flick: `input swipe x1 y x2 y <ms>`.
- Type text: `input text "a%sb"` (`%s` is a space).

## Layout checks

- Measure with `getBoundingClientRect` on `.reader-header`, `.reader-body`,
  `.reader-running-head`, `.reader-page-frame`, `.reader-foot`, plus `.app`
  padding-top and the `.reader-pane` classes (`reader-chrome-over` = chrome
  overlays the page on touch; `reader-chrome-hidden`).
- Expected since cbd1c49: unfolded touch full screen with chrome hidden has
  `.app` padding-top 0 and the running head ~24 px from the top; the cover
  screen keeps its ~68 px top inset; non-immersive split keeps the toolbar above
  the page.

## Measuring motion

- Before the action, start a requestAnimationFrame sampler in the page that
  pushes `[t, computed opacity/transform/backgroundSize]` into `window.__e` for
  about 2.5 s. Fire the `adb` input, wait, read `window.__e` back and collapse
  repeated values.
- `document.getAnimations().map(a => a.animationName)` right after a tap
  confirms which keyframes ran.
- To check reduced motion on desktop headless Chrome for Testing, send
  `Emulation.setEmulatedMedia` with `prefers-reduced-motion: reduce` through a
  CDP session; `--motion-page` should read `0s`.

## System bars

- `adb -s "$SERIAL" shell dumpsys window` exposes `type=statusBars`; expect
  `visible=false` when reader chrome is hidden.
- With a mouse, the text must not move when the bars hide. The insets come from
  getInsetsIgnoringVisibility. Use `var(--top-inset)` and `var(--bottom-inset)`
  in CSS, never `env(safe-area-inset-*)` directly.

## Pitfalls

- Unexplained Back presses or folds mean ownership is wrong, not permission to
  stop another session's emulator. Inspect the recorded device/service identity;
  resume only on the run-owned AVD.
- Test highlights belong only to this private emulator notebook. List their ids
  and observed persistence in `TASK_EVIDENCE`, along with motion samples,
  reduced-motion setup, layouts, system-bar evidence, build/APK identity, serial
  and CDP bindings.

## Cleanup

Close the attachment, remove only its recorded
`adb -s "$SERIAL" forward --remove tcp:<port>` bindings, and follow shared
teardown for the named emulator and private AVD.
