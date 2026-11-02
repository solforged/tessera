---
name: smoke-testing-tessera-android-app
description: "Builds, installs and verifies the Tessera Tauri Android app on the physical Fold or the named foldable emulator; use for Android app changes, fold layouts, reader input and persistence checks."
---

# Smoke-testing the Tessera Android app on the Fold

Use for `crates/tessera-mobile` changes. For the Brave and loopback-service
trial, use `smoke-testing-tessera-android-usb-reader`. Prefer the foldable
emulator below for fold tests (the user's preference); it folds on command, no
human needed. Use the real Fold only when the emulator cannot show the thing
(Samsung cover behavior), and never act in the live notebook there beyond
reading and page turns.

## Workspace and device ownership

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source the owned build workspace and device run. Resolve the SDK/ADB
executables first and record the selected `SERIAL`; every abbreviated guest
command below uses `adb -s "$SERIAL" shell`.

## The physical Fold

The physical Fold is a Galaxy Z Fold 8 (SM-F971U1, the wide model, not the
Ultra): inner 2448×1848 (CSS 1088×821 unfolded), cover 1248×1972 (CSS 554×876),
DPR 2.25. It is often reachable over wireless `adb` on the tailnet (`adb devices`
shows `100.96.167.83:<port>`); USB serial was `RFGL718CJYD`. Select the
currently listed `model:SM_F971U1` device as `SERIAL`, rather than assuming that
historical address. It is paired with the Mac and runs the **release** signer
(since 2026-10-12): update it only with the release-signed tailnet APK per
`distributing-tessera-android-apks`. A debug `android:build` APK fails there
with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (harmless, nothing lost). Check with
`adb -s "$SERIAL" shell pm dump dev.tessera.android`; never uninstall or clear
data, because that deletes the notebook.

- Before an authorized install, inspect `adb -s "$SERIAL" shell dumpsys window`
  and `adb -s "$SERIAL" shell dumpsys power`. Tessera focused with the screen
  Awake means the user is probably reading: ask before interrupting, since
  installation restarts the app. Do not create test annotations or change
  pairing in its live notebook.

## Build and install (emulators; debug-signed)

```sh
(cd "$TASK_SOURCE" && CARGO_TARGET_DIR="$TASK_TARGET" mise run android:build)  # normal host HOME; serialize the build
APK="$TASK_SOURCE/crates/tessera-mobile/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
adb -s "$SERIAL" install -r "$APK"  # owned emulator only; -r preserves its throwaway notebook
sleep 2   # launching right after install can lose a race with the package-update close
adb -s "$SERIAL" shell am start -W -n dev.tessera.android/.MainActivity
```

- Confirm with `shell pidof dev.tessera.android`. Empty means the app is not
  running; relaunch before attaching.
- Prove the build carries a change: attach CDP (below), collect script/CSS URLs
  from `performance.getEntriesByType('resource')`, fetch each and search for a
  new class name. Panes are code-split chunks (`ReaderPane-*.js`), so the entry
  script alone proves nothing.
- Install with `bun install --cwd "$TASK_SOURCE/web" --frozen-lockfile` in the
  owned source. Never symlink the main tree's `node_modules` (it can miss newly
  added dependencies such as `@tauri-apps/plugin-barcode-scanner`, and nested links
  double-bundle solid-js).
- `device unauthorized` or a locked phone: ask the user to unlock and accept USB
  debugging. Don't retry blindly.
- A black screenshot usually means the screen is dozing. Check `dumpsys power`
  (`mWakefulness`) before debugging the app; on the emulator, `input keyevent 224`
  and `wm dismiss-keyguard`.
- If `dumpsys window | grep mCurrentFocus` shows another app (Moshi etc.), the
  user may be using the phone; check before taking over.
- Do not package peers' uncommitted source and merely disclose it. Select an
  owned source state first, record `TASK_BASE` plus any intentional changes and
  the APK hash, and coordinate physical installs with the device owner.
  Afterwards report the actual sha and signer installed.

## Foldable emulators (no phone needed)

- Template prerequisite: a stopped, permitted foldable AVD and its installed
  Android image. `tessera_fold8` was configured for Z Fold 8 size with
  `hw.lcd.width=2448`, `hw.lcd.height=1848`, `hw.lcd.density=360`,
  `hw.sensor.hinge.areas=1224-0-0-1848`, `hw.displayRegion.0.1.width=1248`,
  `height=1972`, `hw.initialOrientation=landscape`, `showDeviceFrame=no`, device
  name `tessera_z_fold8`. Viewports: unfolded 1088×822, cover 555×877 at DPR
  2.25. Its old `userdata` contained The Waning of the Middle Ages and The Tudors;
  do not assume those fixtures exist in a fresh run.
- Create a fresh per-run AVD under `TASK_RUN/tools/avd` with the installed SDK
  tooling, or clone a **stopped** permitted template there. Use a unique AVD
  name derived from `TASK_ID`, update its `.ini` path, and remove only the
  copied template's exact stale snapshot/lock/generated-state files. Do not edit
  or delete files in the source AVD. If no stopped template/image is available,
  that is an explicit prerequisite, not permission to reuse a peer's active
  device.
- Boot with `ANDROID_AVD_HOME="$TASK_RUN/tools/avd"` and the selected SDK's
  emulator under `task_run`, as a uniquely named service with readiness
  `Boot completed`. Select a free emulator port pair and record its resulting
  `SERIAL` (for example `emulator-<owned-even-port>`), AVD name and window
  title. A read-only AVD instance is not a substitute for private writable
  runtime state.
- Fresh builds since sync stage 4 open a "Where is your notebook?" sheet on an
  unpaired notebook; in this owned throwaway emulator click **Start a notebook**
  before testing. Never join the live hub. Seed the run's own books through
  Library.
- To make another size, change only the private clone's configuration keys above
  and drop its copied `hw.device.hash2`. The cover region may be taller than the
  LCD height. Historical `tessera_fold` (Pixel 10 Pro Fold profile, Android 36
  Google APIs arm64) measured inner 852×883 and cover 444×970 at DPR 2.4375.
- Resolve the installed SDK under normal HOME; the historical path was
  `~/.local/share/mise/installs/android-sdk/23.0`. `avdmanager` needs the selected
  `JAVA_HOME` from `mise`. Keep its image/toolchain prerequisites on the host
  rather than assuming isolated HOME provides them.
- If the selected serial disappears, inspect the recorded emulator service and
  ownership before restarting only that run's emulator. Do not adopt whichever
  device appears as `emulator-5554`.
- Fold/unfold ONLY with `adb -s "$SERIAL" emu fold` /
  `adb -s "$SERIAL" emu unfold`. `shell cmd device_state state 0` changes the
  guest display but stretches the cover across the inner emulator frame,
  producing a misleading squashed screen.
  `adb -s "$SERIAL" shell cmd device_state print-state` gives 0 folded and 2
  unfolded on the emulator (3 unfolded on the real Fold).
- To see the actual emulator frame, screenshot the recorded run-owned window
  with
  `computer.window({ title: '<recorded-emulator-window-title>' }).screenshot()`
  (string title; a RegExp throws).
- Seed a book without the system picker: in the attached tab, open Library, then
  build a `File` from base64 bytes (read the EPUB host-side, pass the base64
  into `tab.evaluate`), put it in a `DataTransfer` and dispatch a `drop`
  `DragEvent` on `.library-pane`. It uses the same upload path as Choose file.
- Folding does not reload the WebView; the reader pane is not remounted. It
  sends ~8 animated ResizeObserver steps over ~250 ms.
- The emulator is slow: right after opening the reader, page turns are ignored
  while it is still restoring. Wait ~2 s.
- `adb -s "$SERIAL" shell input tap X Y` lands on the folded emulator's cover
  (device px; center ≈ 624,1100, right-edge page turn ≈ 1180,1100).
  `adb -s "$SERIAL" shell input keyevent 4` (Back) with no popup open leaves the
  app.
- Headless Chromium cannot fake `(pointer: coarse)` (touch emulation, `hasTouch`
  and `--blink-settings` pointer types all leave it false), so cover-screen CSS
  must be checked on the emulator.

## Attach to the app WebView

1. `P=$(adb -s "$SERIAL" shell pidof dev.tessera.android)`; the socket is
   `webview_devtools_remote_$P`. Read it after launch; the pid changes after
   every restart.
2. Forward it with
   `adb -s "$SERIAL" forward tcp:0 "localabstract:webview_devtools_remote_$P"`.
   Record the returned host port and selected serial.
3. Attach with
   `browser.open({name:'<TASK_ID>-webview', app:{cdp_url:'http://127.0.0.1:<returned-port>', target:'tauri.localhost'}})`.
   Do not pass `url`; it tries to navigate and fails.
4. Use `tab.evaluate(fn, ...args)` for page JS (`tab.run` runs in a Node-side
   runtime, not the page). `tab.press('ArrowRight')` sends real key events. DOM
   `.click()` in `tab.evaluate` is the reliable way to navigate; `input tap` on
   the real Fold's cover display did not land. Library opens on its last tab;
   click the `Reading N` tab, then `.library-reading-card`, then the
   `Read`/`Continue reading` button.
5. Close the attachment and remove only this inspection binding with
   `adb -s "$SERIAL" forward --remove tcp:<recorded-port>` when done.
6. Query the notebook from the page:
   `__TAURI_INTERNALS__.invoke('notebook_request', {request:{method, path:'/api/...', headers:[], body: base64|null}})`
   returns a frame: u16 status, u16 content-type length, content type, body.
   Useful: `GET /api/pages/<sourceId>`,
   `POST /api/highlights/query {unprocessed:false, limit}`,
   `GET /api/library/jobs?limit=50`, `GET /api/sync/state`.
7. Preview CSS before rebuilding: the app's CSP blocks injected `<style>` (its
   `.sheet` is null). Use a constructable sheet:
   `const s = new CSSStyleSheet(); s.replaceSync(css); document.adoptedStyleSheets = [s];`.

## Interact natively

Push fixture EPUBs from `TASK_RUN/downloads`, not the user's unrelated files.

- Use `adb` input for touches. CDP touch events do not create selections.
- Device pixels = CSS box center × devicePixelRatio (2.25 on both Fold screens).
  Get boxes via `getBoundingClientRect` in `tab.evaluate`.
- Long-press to select a word: `input touchscreen swipe x y x y 900`. For a
  whole sentence, set a DOM Range in the passage row with `tab.evaluate`; the
  reader's `selectionchange` handler shows the same toolbar. Then tap the toolbar
  button natively so the keyboard opens from a real gesture.
- Type with `input text` (`%s` = space). Avoid apostrophes and quotes; the
  remote shell breaks on them.
- `input keyevent 111` is Escape (closes the touch note sheet); `keyevent 4` is
  Back (hides the keyboard); 21/22 are arrow left/right.
- In the system file picker, read node bounds from `uiautomator dump /dev/tty`.
  Push a test EPUB to `/sdcard/Download` first. Never open the user's own files.

## Keyboard

- Edge to edge, Android does not resize the window for the IME and the WebView
  ignores `interactive-widget`. `MainActivity` pads `android.R.id.content` by
  the IME inset. With the keyboard open, `innerHeight` should equal
  `visualViewport.height` (about 493 unfolded, 544 on the cover) and
  `visualViewport.offsetTop` should be 0. If `innerHeight` stays 821 with
  `offsetTop` > 0, the lift is broken and fixed overlays slide off screen.

## Screenshots

`adb -s "$SERIAL" exec-out screencap -p` can prepend a multiple-display warning.
Save under `TASK_EVIDENCE` using binary capture, slicing only bytes before the
PNG magic, or select `-d <id>` from
`adb -s "$SERIAL" shell dumpsys SurfaceFlinger --display-id`. IDs differ per
device and AVD. Preserve the original pixels.
`adb -s "$SERIAL" shell cmd device_state print-state` returns 3 unfolded and 0
folded on the real Fold.

## Checklist

- Journal loads with **Saved** and no time-zone error (jiff needs
  `tzdb-concatenated`).
- Shell clears the status and gesture bars (safe-area padding).
- Import an EPUB through Library → Add; the cover image renders.
- Reader on touch: select → **Highlight and note** → the full-screen note sheet
  (`.reader-compose`) opens with the keyboard, the whole quotation visible above
  it → type → **Keep note** → the note is the highlight's child in the source
  outline. Escape or **Back to reading** with nothing typed removes the empty
  child.
- Cover-screen reader chrome (since 725f06d): the masthead, toolbar and book map
  lie over the page. Hidden: `.reader-body` runs from the masthead's top to the
  foot (~692 px tall on the Fold 8 cover). A center tap shows them; a page turn,
  a contents jump, a scroll or opening the book hides them
  (`.reader-chrome-hidden`). Unfolded, `.reader-pane` stays `display: flex` with
  the header above the body.
- Paged reader (Aa → Pages):
  - The in-memory anchor is the first character on the page after a turn, but
    `{ordinal, 0}` after a jump or restore. Check that the anchor character is
    visible after a fold, not that the page starts with it.
  - Fold/unfold: record the first visible character, fold, check it is on
    screen, unfold, check again. Repeat several rounds deep in a chapter.
  - Restart: turn to a page that starts mid-passage, wait 3 s for the navigation
    write, `am force-stop`, relaunch. The same page must come back, also after a
    second restart.
- On the owned emulator, force-stop and relaunch: highlight and note persist.
  Its notebook is at `/data/user/0/dev.tessera.android/notebook`; do not copy
  test data into a physical phone's live container.
- Fold testing on the real Fold requires the user's participation and separately
  authorized scope; ask for the physical fold and wait. Otherwise report
  emulator-only acceptance.

## Checks before committing

- With tool `cwd: TASK_SOURCE` under normal host HOME, run
  `CARGO_TARGET_DIR="$TASK_TARGET" cargo clippy -p tessera-mobile --target aarch64-linux-android -- -D warnings`.
  Set CC/AR to the selected NDK's `aarch64-linux-android24-clang` and `llvm-ar`,
  and run `mise run mobile:pages` there first.
- `bun run --cwd "$TASK_SOURCE/web" build`; for reader changes, run
  `task_run bun test src/reader` with tool `cwd: TASK_SOURCE/web`.

## Retain and tear down

Retain screenshots, keyboard/layout measurements, APK/build identity, seeded
books and AVD/serial/CDP bindings in `TASK_EVIDENCE`, then follow shared
teardown. Delete only this run's private AVD after its recorded emulator stops;
never delete physical-phone data.
