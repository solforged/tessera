---
name: smoke-testing-tessera-android-usb-reader
description: "Smoke-tests Tessera's real Solid reader in Brave on a USB-connected physical Fold; use for Android CDP trials of native selection, keyboard entry and saved annotations before or alongside Android packaging."
---

# Smoke-testing the Tessera Android USB reader

Use for a physical-device trial of the existing web reader before or alongside
Android packaging. This is not a native Android build or offline/sync proof.

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source the trial's workspace, matching CLI/assets and private
runtime. The authorized physical-browser trial stays host-side; resolve ADB
before runtime HOME changes.

## Boundaries

- The user prefers Brave and ultimately wants an installable Android app. The
  browser trial is interim verification.
- Use an isolated notebook; never mutate the installed notebook or
  `.tessera/dev` for trial annotations.
- Keep the notebook service loopback-only. USB reverse forwarding avoids network
  exposure and preserves its host/origin policy.
- Do not enable debugging, change security settings, or approve device trust on
  the user's behalf. Ask the user to enable USB debugging and approve this Mac
  when required.
- Do not inspect or navigate unrelated browser tabs. Screenshots can contain
  private tab titles; keep artifacts local.
- Do not force-stop Brave to simulate process death; it contains the user's
  other tabs.

## Connect and launch

`adb` comes from devenv's android profile:

```sh
ADB="$(devenv --profile android shell -- sh -c 'echo "$ANDROID_HOME/platform-tools/adb"' 2>/dev/null)"
"$ADB" devices -l
```

Discover again if absent. Explicitly select the listed device serial for
subsequent commands. If the list is empty, inspect the USB device connection
separately; a physically detected Samsung without an ADB entry needs debugging
enabled. An unauthorized entry needs on-device approval.

Use a fresh `NOTEBOOK="$TASK_RUN/notebooks/usb-reader"`, an owned free
`HTTP_PORT` and independently selected `SYNC_PORT`; 4398 is only the first
trial's historical port. Record the actual origin and start the service as a
unique named service with verified readiness:

```sh
task_run "$TASK_BIN" --workshop "$NOTEBOOK" serve --port "$HTTP_PORT" --sync-port "$SYNC_PORT" --assets "$TASK_DIST"
task_run "$TASK_BIN" --workshop "$NOTEBOOK" add --wait "$TASK_SOURCE/web/src/demo/meditations.epub"
```

Keep the notebook service persistent while the user is trying it. Inspect
existing reverses before adding a non-rebinding forward:

```sh
"$ADB" -s "$SERIAL" reverse --list
"$ADB" -s "$SERIAL" reverse --no-rebind "tcp:$HTTP_PORT" "tcp:$HTTP_PORT"
"$ADB" -s "$SERIAL" shell am start -a android.intent.action.VIEW -d "http://127.0.0.1:$HTTP_PORT/" -p com.brave.browser
```

Chrome was installed but disabled on the first trial; do not enable or use it
instead of Brave.

## Attach the actual phone browser

Read `xd://eval/browser` before using browser helpers. Brave exposes the
`chrome_devtools_remote` abstract socket:

```sh
"$ADB" -s "$SERIAL" forward tcp:0 localabstract:chrome_devtools_remote
```

Use the returned host port. Read `http://127.0.0.1:<port>/json/version` and
verify `Android-Package` is `com.brave.browser`. Attach only the trial tab:

```js
const phone = await browser.open({
  name: '<TASK_ID>-fold-brave-usb',
  app: {
    cdp_url: 'http://127.0.0.1:<port>',
    target: 'http://127.0.0.1:<owned-http-port>/'
  },
  persist: true
});
console.log(await phone.observe());
```

Do not emulate viewport dimensions: measure the physical browser's layout and
visual viewport.

The initial Android VIEW-intent navigation returned `forbidden_origin` in the
first trial. Direct `phone.goto('http://127.0.0.1:4398/')` succeeded without
changing service security. Inspect the response before acting; do not weaken
host/origin checks for this trial.

## Reader and real touch input

- Navigate Library → the imported `[data-library-row]` → Read. Wait for
  `.reader-passage`.
- Collapse the sidebar for reading.
- Contents opens a textbox and listbox. Filter for `THE SECOND BOOK`, then use
  `phone.press('Enter', {selector: 'role/textbox[name="Contents" exact]'})`.
- Use a fresh actual-device screenshot to locate native touch coordinates. CDP
  page screenshots omit browser/system chrome and cannot directly supply
  whole-screen coordinates.
- CDP `Input.dispatchTouchEvent` long-press produced no selection in the first
  trial. Native ADB input did:

```sh
"$ADB" -s "$SERIAL" shell input touchscreen swipe X Y X Y 900
```

Verify `getSelection().toString()` and the displayed controls. Inspect the
native selection menu and handles before tapping the application's Highlight and
note action.

Native `"$ADB" -s "$SERIAL" shell input tap X Y` can exercise the actual
on-screen keyboard. Four taps entered `test` through Samsung's split keyboard in
the first trial. This is stronger evidence for keyboard integration than
programmatic DOM text insertion.

## Capture Android screenshots

`"$ADB" -s "$SERIAL" exec-out screencap -p` may prepend a multiple-display
warning to stdout before the PNG bytes. Prefer explicitly identifying/selecting
the active display when needed. If a warning precedes a valid screenshot, locate
the PNG signature `[137,80,78,71,13,10,26,10]` and save the binary payload
starting there; never alter the image pixels.

Capture via Eval's Node child-process API with binary output and an adequate
buffer. Save under `TASK_EVIDENCE`, then inspect with the image-capable read
tool. An invalid UTF-8/binary-file error on a `.png` can mean the diagnostic
prefix was retained. Record the device/serial, origin, CLI build, seed, browser
attachment, actual HTTP/sync/CDP ports and forward/reverse bindings with the
screenshots.

## Verification and handoff

1. Select text using a real long-press.
2. Tap Highlight and note; capture the keyboard-open layout.
3. Enter a short note using the actual keyboard.
4. Verify `.pane-save-state` has title `Saved`.
5. Send `KEYCODE_BACK`; confirm the keyboard closes without losing the note.
6. Reload the trial tab; wait for saved state and reader loading, then confirm
   both the note and `.reader-highlight` return.
7. Do not claim fold/unfold, offline, process-death, or multi-device behavior
   unless actually exercised. Ask the user for physical folding when that check
   is in scope.

The first trial exposed desktop source-header overhead above the keyboard; the
approved compact mobile composer is intended to recover that space. No mobile
layout changes were made during that trial.

Release the browser attachment with
`browser.close({name:'<TASK_ID>-fold-brave-usb'})`; CDP-attached user pages
remain open. Remove only the recorded inspection forward with
`"$ADB" -s "$SERIAL" forward --remove tcp:<recorded-port>`. Intentionally leave
the notebook service and the exact USB reverse active only with an explicit
user-trial handoff naming their next owner, service handle, serial, binding,
origin and backing `TASK_RUN` path. Explain dependence on the cable and Mac
service, and do not delete that runtime while the trial is retained. Preserve
selected evidence in `TASK_EVIDENCE`; when the user finishes, stop only those
recorded resources, remove only that reverse with
`"$ADB" -s "$SERIAL" reverse --remove "tcp:$HTTP_PORT"`, and follow shared
non-forced cleanup. Never stop Brave or remove unrelated forwards, tabs or data.
