---
name: testing-tessera-emulator-ime-editor
description: "Tests Tessera outline typing, backspace and picker behavior with the real Android Gboard keyboard on the foldable emulator; use for phone-only editor QA when the physical Fold is unnecessary or disconnected."
---

# Testing the Tessera editor with real Gboard on the emulator

Desktop `page.keyboard.type` cannot show phone-only bugs. On Android WebView,
CodeMirror uses EditContext: printable keys arrive as
`keydown key=Unidentified/229`, only Backspace and Enter arrive as real keys,
and composition events never reach contentDOM handlers. Any behavior keyed on
printable `keydown` silently fails on phones; use `EditorView.inputHandler`.

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source this audit's workspace, matching CLI/assets and device run.

Prerequisites: an installed foldable image/template, Gboard, a Tessera WebView
build and its Android toolchain. A fresh checkout does not supply a seeded
emulator.

## Setup

1. Create and boot a private run-owned AVD per
   `smoke-testing-tessera-android-app`, with its `userdata` under
   `TASK_RUN/tools/avd`, a unique AVD/service identity and owned emulator port
   pair. Record its actual `SERIAL` from `adb devices -l` and verify Gboard is
   the IME. Do not reuse a peer's `emulator-5554` or navigate its app.
2. Serve
   `task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/ime" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"`
   as a unique named service (never 4317/4318/4320/5173). Record readiness and
   both actual ports. Use only this run's fresh notebook, never shared dev data.
3. Inspect `adb -s "$SERIAL" reverse --list`, then
   `adb -s "$SERIAL" reverse --no-rebind tcp:<owned-http> tcp:<owned-http>` and
   record that exact binding.
4. Do not use Chrome on the emulator (first-run ToS must not be accepted). Use
   the private app's WebView:
   `adb -s "$SERIAL" shell am start -n dev.tessera.android/.MainActivity`, then
   read its pid in a separate call with
   `adb -s "$SERIAL" shell pidof dev.tessera.android`. Forward with
   `adb -s "$SERIAL" forward tcp:0 localabstract:webview_devtools_remote_<pid>`
   and record the returned port.
5. Attach
   `browser.open({name:'<TASK_ID>-emu-webview', app:{cdp_url:'http://127.0.0.1:<recorded-forward>', target:'tauri.localhost'}, persist:true})`,
   then navigate that owned WebView to `http://127.0.0.1:<owned-http>/`.
   Preserve this origin for persistence checks; each concurrent lane uses a
   separate run/profile/notebook.

## Driving input

- Screenshot via `adb -s "$SERIAL" exec-out screencap -p` with binary capture
  (strip only bytes preceding the PNG signature), save the original under
  `TASK_EVIDENCE`, read it and map Gboard key centers. Physical px = displayed
  px × (1080/716) on the historical 1080×2364 screen; CSS px × the measured
  devicePixelRatio (historically 2.4375) for page elements.
- Tap with `adb -s "$SERIAL" shell input tap X Y`. `[` and `]` live on `?123` →
  `=\<` layer; `#` on `?123`. All guest input/inspection uses the same selected
  serial.
- Read state from `document.querySelector('.cm-content').cmTile.view` (doc,
  selection head) and `[role="listbox"] [role="option"]`.
- Instrument contentDOM with capture listeners for
  keydown/beforeinput/composition* to see what the IME actually sends.
- Check row geometry (`[data-index]` rects) before/after taps to catch jitter.
- Check junk pages via `GET /api/complete?q=`.

## Scenario matrix (links)

Type `[[`, query, Backspace inside query, Backspace on empty pair, pick by tap
and by Enter, punctuation after chosen reference, tap a reference widget
mid-block, `#tag` typed slowly (≥500 ms/key), hand-typed `]]`.

## Cleanup

Retain the scenario matrix, actual IME events, geometry/API evidence and
screenshots in `TASK_EVIDENCE`. Navigate only the owned WebView back to
`http://tauri.localhost/android.html`, close its attachment, and remove recorded
bindings with `adb -s "$SERIAL" forward --remove tcp:<recorded-forward>` and
`adb -s "$SERIAL" reverse --remove tcp:<owned-http>`. Follow shared teardown for
the exact server/emulator handles and private AVD.
