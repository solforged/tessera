---
name: distributing-tessera-android-apks
description: "Distributes fresh Tessera Android builds to phones without USB using the tailnet download page or wireless Android debugging; use for signer-compatible updates and API-based re-pairing of the Fold as a replica."
---

# Distributing Tessera APKs to phones without USB

Use this when the phone isn't on USB. For USB installs, use
`smoke-testing-tessera-android-app`.

## Workspace, run and authority

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source the workspace at the exact landed build. Record the selected
phone as `SERIAL`; every device-targeting command or abbreviated shell fragment
below uses `adb -s "$SERIAL"`.

Authorize Mac shipping, tailnet APK replacement, phone installation and pairing
for their exact targets independently. Keep intermediates in `TASK_RUN`,
retained APKs/proofs in `TASK_EVIDENCE`, and leave managed ship/publish
infrastructure under its persistent owner.

## Signers decide what can update what

Android only installs an update when the signing certificate matches; otherwise
it requires an uninstall, which **deletes that phone's notebook**. Never
uninstall on the user's behalf.

- **Debug key** `~/.android/debug.keystore`, cert SHA-256 `f160ca64…568399`.
  Every `ts-android-build` output.
- **Release key** `~/.android/tessera-release.jks` (PKCS12, alias `tessera`,
  cert `985788…6eff`). Store and key share one password: login Keychain service
  `tessera-android-release-keystore`
  (`security find-generic-password -s tessera-android-release-keystore -w`, no
  prompt), also 1Password Private item "Tessera Android release key" (fields
  `password`, file `keystore`). GitHub release APKs (CI secrets
  `ANDROID_KEYSTORE`, `ANDROID_KEYSTORE_PASSWORD`) and the tailnet page use it.
  The physical Fold runs this signer since 2026-10-12 (confirmed again
  2026-10-22).
- `dumpsys package` on the Fold still shows `DEBUGGABLE`: `ts-android-publish`
  strips and re-signs a _debug_ build with the release key. Do not read that
  flag as "debug signer".
- So: update the Fold ONLY with the release-signed tailnet APK.
  `adb -s "$SERIAL" install -r <plain-debug-apk>` fails with
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (harmless, nothing lost; seen
  2026-10-22). If the page already serves the wanted commit, skip publishing:
  download `/tessera.apk`, check SHA-256 and signer against the page, and
  install that APK only when authorized.
- Check a phone's signer before installing:
  `adb -s "$SERIAL" shell pm dump dev.tessera.android` or compare with
  `apksigner verify --print-certs`.

## Fast path: "update the phone app" (worked 2026-10-12 and 2026-10-22, ~2 min)

1. Coordinate over intercom (one session owns Mac+Fold ships). Wait for peers'
   PRs to land through `ts-land` on `origin/main`; ship only landed shas.
2. Check live build (`curl -s 127.0.0.1:4318/api/service`). If authorized Mac
   shipping and APK publication are needed, run `ts-ship <landed-sha>` and
   `ts-android-publish <landed-sha>` with tool `cwd: TASK_SOURCE` under
   normal host HOME. Mac and Fold must match schema (~50 s warm for both,
   publish ~20 s).
3. Download to `"$TASK_RUN/downloads/tessera-<sha>.apk"` from
   `https://hyperion.ussuri-alphard.ts.net:8443/tessera.apk`; run
   `shasum -a 256` and compare the page's Commit/SHA-256/Signer `<dd>` lines.
   Retain those proofs in `TASK_EVIDENCE`.
4. Run `adb devices -l`; select `SERIAL`. If empty, use the authorized wireless
   discovery below, connect candidates and select the entry reporting `device`;
   disconnect only connections made by this run that remain `offline`.
5. Inspect `adb -s "$SERIAL" shell dumpsys window` and
   `adb -s "$SERIAL" shell dumpsys power`; ask before interrupting an active
   reader. Install with
   `adb -s "$SERIAL" install -r "$TASK_RUN/downloads/tessera-<sha>.apk"`,
   inspect `adb -s "$SERIAL" shell dumpsys package dev.tessera.android` for
   `lastUpdateTime`, then launch with
   `adb -s "$SERIAL" shell monkey -p dev.tessera.android -c android.intent.category.LAUNCHER 1`
   only within the authorized scope.
6. Proof of sync without CDP: `curl -s 127.0.0.1:4318/api/sync/devices` shows
   device `sophus` with a fresh `last_attempt_at`, `attempts[0].ok: true`,
   `version.schema` = Mac schema (`version.build` is null for phones, so the sha
   itself needs the CDP check below if required).
7. Retain the selected final APK and verification evidence in `TASK_EVIDENCE` if
   needed, remove only this run's disposable download, and tell the other
   Tessera sessions the actual sha and signer installed.

## Re-pair the Fold as a replica without touching its UI

`/api/sync/devices` on the Mac showing `devices: []` while the phone's
`/api/sync/state` says `role: none` can indicate a lost replica (a reinstall or
wiped workshop). This is diagnosis, not permission to pair. The following is a
**real host-side pairing operation**, not a smoke test: require separate exact
user authorization for these Mac/phone endpoints and the clone, and coordinate
with their owners immediately before proceeding. Never exercise Sharing/Pair UI
against the host's live route for QA.

1. Mac:
   `curl -s -X POST -H 'Content-Type: application/json' 127.0.0.1:4318/api/sync/pairing`
   → `{code, url}` (code lives 5 min; `GET` the same path polls
   `waiting|paired`).
2. Phone, in the attached CDP tab (below):
   `__TAURI_INTERNALS__.invoke('notebook_request', {request:{method:'POST', path:'/api/sync/join', headers:[['content-type','application/json']], body: btoa(JSON.stringify({url, code, name:'sophus'}))}})`.
3. The join clones the Mac workshop and blocks past the 30 s `tab.evaluate`
   limit; the tool times out and later kills the tab. That is fine: wait ~45 s,
   re-forward DevTools, open a new tab and read `/api/sync/state`
   (`role: replica`, `attempts[0].ok: true`, `pending: 0`). The Mac's
   `/api/sync/pairing` then says `paired` and `/api/sync/devices` lists `sophus`
   as `active`. Join refuses with `already_replica` if the phone still thinks it
   is one. Deleting Mac membership with `DELETE /api/sync/devices/{id}` requires
   separate authorization for the exact device; do not automatically forget it
   as a retry. Preserve the observed state and ask for that action if needed.

## Tailnet download page (browser-based installs)

- Run `ts-android-publish <explicit-landed-commit>` with tool
  `cwd: TASK_SOURCE` under normal host HOME. It builds in managed persistent
  `~/.cache/tessera/android-publish` (detached worktree, so dirty edits never
  ship), strips debug info (~90 MB), re-signs with the release key, and replaces
  the APK at `https://hyperion.ussuri-alphard.ts.net:8443/` (stable
  `/tessera.apk`, page shows commit, SHA-256 and signer). ~25 s warm. Do not
  reallocate or delete this cache through task-worktree cleanup.
- Key lookup order: `TESSERA_ANDROID_KEYSTORE`/`_PASSWORD` environment variables, then
  `~/.android` + Keychain, then 1Password (1Password needs a desktop approval
  and times out unattended, so the Keychain path matters).
- Infrastructure, set up by the task's first run and persistent: launch agent
  `dev.tessera.downloads` (python http.server on 127.0.0.1:18791, logs
  `~/.local/state/tessera/logs/downloads.log`) and
  `tailscale serve --https=8443`. The Mac App Store Tailscale cannot serve a
  folder directly (sandbox), hence the local server. Never touch the `:443`
  entries (`hyperion` → 18790, `sigil` → 8787) or 4319 (Tessera sync).
- Verify: download via the tailnet URL, `apksigner verify --print-certs` shows
  `985788…`, `aapt dump badging` shows `versionName` = workspace version.
- Coordinate: one session owns combined Mac+Fold ships; ask over intercom before
  publishing or touching the publish cache.

## Before building for the Fold

- Coordinate first. The user wants **one** build matching the Mac:
  `curl -s 127.0.0.1:4318/api/service` for the live `build`, `/api/notebook` for
  `schema_version`. A schema mismatch refuses sync, so the Fold must run a build
  at or after the Mac's last migration.
- Select the exact authorized landed SHA through the shared preparation; use an
  owned checkout at that SHA, not local main plus peers' changes. Install with
  `bun install --cwd "$TASK_SOURCE/web" --frozen-lockfile`. Never symlink
  `node_modules` into an installation (Vite can bundle Solid twice and hang).
- If its Gradle configuration cache must be discarded, remove only the exact
  `crates/tessera-mobile/gen/android/.gradle/configuration-cache` within the
  verified owned `TASK_SOURCE`, with no consumer still using it. Do not touch a
  peer or managed publish cache.
- A reused Cargo target can skip writing `generated/TauriActivity.kt`
  (`Unresolved reference 'TauriActivity'`). Do not `cargo clean` the shared
  target as a private repair. When this generated-source isolation is required,
  record the reason and build with
  `CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$TASK_RUN/target"`; remove that owned
  exception only after consumers stop.

## Build, strip, sign (debug, for emulators only; the Fold takes the release-signed page APK)

```sh
(cd "$TASK_SOURCE" && CARGO_TARGET_DIR="$TASK_TARGET" ts-android-build)
# Resolve SDK, NDK, BT, STRIP and JDK under normal host HOME first, from the android profile:
# `devenv --profile android shell -- sh -c 'echo "$ANDROID_HOME $NDK_HOME $JAVA_HOME"'`.
# STRIP is that NDK's llvm-strip; BT is the selected Android build-tools directory.
W="$TASK_RUN/downloads/apk"; mkdir -p "$W/x"
cp "$TASK_SOURCE/crates/tessera-mobile/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk" "$W/in.apk"
(cd "$W/x" && unzip -q ../in.apk 'lib/*')
for so in "$W"/x/lib/*/*.so; do "$STRIP" --strip-debug "$so"; done
cp "$W/in.apk" "$W/stripped.apk"
(cd "$W" && zip -q -d stripped.apk 'META-INF/*' && cd x && zip -q -0 ../stripped.apk lib/*/*.so)
"$BT/zipalign" -f -P 16 4 "$W/stripped.apk" "$W/aligned.apk"
JAVA_HOME="$JDK" "$BT/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-pass pass:android --ks-key-alias androiddebugkey --out "$TASK_EVIDENCE/tessera-<sha>-debug.apk" "$W/aligned.apk"
```

Verify freshness in the owned `TASK_SOURCE`: inspect `web/dist-mobile` mtimes
and its asset contents for a string from the new commit. Record the build base,
output hash and signer. If using the documented private-target exception,
substitute that target in the build command; never clean the shared target.

## Install over wireless `adb`

- `adb`: `$ANDROID_HOME/platform-tools/adb` from the android profile, or
  `devenv --profile android shell -- adb`. The Fold is tailnet host `sophus`, 100.96.167.83. Try `adb devices` first.
- Wireless debugging is off by default after a reboot: if the scan finds only
  one port that connects as `offline` (the pairing port, e.g. 39411), ask the
  user to turn on Developer options › Wireless debugging, then rescan; a second
  port (e.g. 41319) connects as `device`.
- Scan: TCP-scan 30000–49999 from JS `Eval` with `Bun.connect` in batches of ~300,
  2 s timeout, cell timeout 300+. Record the port as open _before_ `s.end()`
  (end fires close synchronously). `adb connect` each open port; disconnect the
  `offline` ones. (Sanity-checking on 127.0.0.1:4318/4319 may return empty when
  the Mac's loopback refuses raw connects; ignore.)
- Inspect `adb -s "$SERIAL" shell dumpsys window` and power state first in case
  the user is reading. After exact authorization,
  `adb -s "$SERIAL" install -r <verified-release-apk>`, then inspect
  `adb -s "$SERIAL" shell dumpsys package dev.tessera.android` for
  `lastUpdateTime`.

## Prove the Fold runs the new sha

Read `P` with `adb -s "$SERIAL" shell pidof dev.tessera.android` after launch,
then
`adb -s "$SERIAL" forward tcp:0 "localabstract:webview_devtools_remote_$P"`.
Record the returned host port and serial; attach
`browser.open({name:'<TASK_ID>-fold', app:{cdp_url:'http://127.0.0.1:<returned-port>', target:'tauri.localhost'}})`.
In `tab.evaluate(async () => …)`, list
`performance.getEntriesByType('resource')` JS URLs, fetch each and search for a
string unique to the new commit (panes are code-split, so the entry script alone
proves nothing). `window.__TAURI_INTERNALS__.invoke('notebook_request', …)`
works in the release-signed build (2026-10-22); frames are u16 status, u16
content-type length, content type, body. Remove only that recorded forward with
`adb -s "$SERIAL" forward --remove tcp:<returned-port>`. Locked-phone
screenshots are black; `hub_unreachable` right after an install while locked is
expected. A first sync once briefly showed `block … not found (operation None)`
and cleared on its own; report actual current behavior rather than assuming that
explanation.

## Other device notes

- The Fold has two displays: `adb -s "$SERIAL" exec-out screencap -p -d <id>`
  (ids from `adb -s "$SERIAL" shell dumpsys SurfaceFlinger --display-id`).
  `adb -s "$SERIAL" shell cmd device_state print-state` is 3 when unfolded.
  Store selected original screenshots locally in `TASK_EVIDENCE`.
- Unfolded WebView is 1088 CSS px wide.
- Launcher-shortcut repro on the authorized selected device:
  `adb -s "$SERIAL" shell am start -n dev.tessera.android/.CaptureShortcutActivity -a dev.tessera.android.CAPTURE --es dev.tessera.android.CREATE_KIND note -f 0x10008000`
  (NEW_TASK|CLEAR_TASK, the launcher's flags; `--activity-new-task` is not an
  `am` option). `adb -s "$SERIAL" shell pidof dev.tessera.android` must stay the
  same across launches since 3ffe5666. Do not create a note in a live phone
  notebook merely for QA.
- Self-update: Android can't silently update a sideloaded app; an in-app updater
  would need `REQUEST_INSTALL_PACKAGES` and a PackageInstaller session (first
  update still prompts). Not built as of 2026-10-22.

## Teardown

Preserve the selected APK and signer/hash/build/device proof in `TASK_EVIDENCE`.
Remove only recorded inspection bindings with
`adb -s "$SERIAL" forward --remove tcp:<port>`, report the actual installed
sha/signer, then follow shared teardown. Leave the managed publish cache,
download launch agent and Serve entries running with their owner; explicitly
hand off any retained user trial.
