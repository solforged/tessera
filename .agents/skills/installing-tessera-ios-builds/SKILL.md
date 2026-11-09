---
name: installing-tessera-ios-builds
description: "Builds Tessera for iOS with the iOS build task and installs it on the physical iPhone with Apple device-control tools or the iPhone 18 Pro simulator; use for device installation, touch-driven QA and Home Screen quick-action checks."
---

# Installing Tessera iOS builds on devices and simulators

iOS support is on main since 43a0e6cf (2026-10-24). The pieces:

- The phone crate is `crates/tessera-mobile`, shared by Android and iOS.
- The pages are the `mobile` build (`web/mobile.html`, `web/src/mobile/`,
  `web/dist-mobile`), made by `mise run mobile:pages`.
- `mise run ios:build` builds the app; see `docs/usage.md#ios-app`.
- `gen/apple/Sources/tessera-mobile/main.mm` is the native bridge:
  - hides WKWebView's form accessory bar;
  - forwards status-bar taps as `tessera:status-bar-tap`;
  - plays haptics (`tesseraHaptic`);
  - puts the edit-menu highlight dots in the selection menu (`tesseraEditMenu`);
  - delivers Home Screen quick actions (`tesseraShortcut`, see below).
- iPhones are portrait-only, set in `project.yml` and Info.plist. `xcodegen`
  regenerates Info.plist from project.yml, so edit both. project.yml also
  carries `NSCameraUsageDescription` for the pairing scanner and
  `UIApplicationShortcutItems`; keep them.

## Platform details

- Bundle ID `dev.tessera.ios`. The notebook lives in the app container under
  `Library/Application Support/dev.tessera.ios/notebook`, and upgrading the app
  in place keeps it.
- iPhone 18 Pro: 402×874 pt @3x, with a 62 pt top and 34 pt bottom safe area.
  Berkeley Mono is not bundled, so apparatus falls back to SF Mono.
- iOS WebKit: `web/src/ui/ios-viewport.ts` adds `maximum-scale=1` on iOS so 15
  px fields don't auto-zoom; don't remove it.
- `tao` 0.37 runs the app on the scene lifecycle on iOS 27, even without a scene
  manifest. Its classes `AppDelegate` and `TaoSceneDelegate` are only registered
  at run time, so main.mm patches them from a
  `UIApplicationDidFinishLaunchingNotification` observer.

## Build and install on `archon` (proven 2026-10-24 and 2026-10-30, ~30 s warm)

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source the iOS build workspace and run. Native Xcode/WebKit
acceptance stays host-side; resolve tools before runtime HOME changes.

1. Install `bun install --cwd "$TASK_SOURCE/web" --frozen-lockfile` under normal
   host HOME. Execute build/mise commands with tool `cwd: TASK_SOURCE` and scope
   Git to that source.
2. Build pages with `bun run --cwd "$TASK_SOURCE/web" build:mobile`, then
   `TESSERA_IOS_SIGNING_IDENTITY="<resolved-development-signing-identity>" CARGO_TARGET_DIR="$TASK_TARGET" mise run ios:build`
   there. Use shared target/exception handling. The IPA is
   `"$TASK_SOURCE/crates/tessera-mobile/gen/apple/build/arm64/Tessera.ipa"`;
   record its hash/build and retain selected artifacts in `TASK_EVIDENCE`.
   - Resolve the device UDID with `xcrun devicectl list devices` and the
     team/signing identity from project memory before building; set
     `TESSERA_IOS_SIGNING_IDENTITY` explicitly so Xcode does not choose another
     account.
3. Physical installation/termination is a separate exact user-authorized action,
   not implied by QA. Coordinate with the device owner and ask before
   interrupting active use. Install with
   `xcrun devicectl device install app --device <confirmed-UDID> <verified-ipa>`,
   then launch with
   `xcrun devicectl device process launch --device <same-UDID> --terminate-existing dev.tessera.ios`
   only within that authorized scope. Never uninstall or replace its notebook
   for a test.
   - Install works while the phone is locked; launch fails with
     CoreDeviceError 10003. Don't rebuild: the app is installed, so tell the
     user to open it.
4. Verify:
   - `xcrun devicectl device info processes --device <UDID> | grep Tessera.app`;
   - `xcrun devicectl device info apps --device <UDID> --bundle-id dev.tessera.ios`;
   - `device info files --domain-type appDataContainer --domain-identifier dev.tessera.ios`
     lists `notebook/notebook.db` with fresh WAL and `shm` times.
5. Retain the confirmed UDID, signing/build identity, IPA hash and checks in
   `TASK_EVIDENCE`, then follow shared teardown.

Simulator build, normal host HOME and tool `cwd: TASK_SOURCE`:
`CARGO_TARGET_DIR="$TASK_TARGET" mise run ios:build -- --debug --target aarch64-sim`
makes `gen/apple/build/arm64-sim/Tessera.app` (~35 s warm, ~6 s for only
main.mm). Select release instead for timing/profile acceptance; a debug
simulator is functional QA, not release performance proof.

Build pitfalls:

- **Stale pages.** `ios:build` depends on `mobile:pages`, which `mise` skips when
  its sources look unchanged, so a fixed build can still embed the old
  `web/dist-mobile`. Run `bun run --cwd web build:mobile` yourself first; step 2
  does.
- **Blank app** with
  `ReferenceError: Cannot access '<x>' before initialization`: the Solid runtime
  may be split. Inspect only the owned `TASK_SOURCE/web` install for a
  nested/self-symlink, then reinstall from the lockfile there and rebuild the
  pages. Never delete another checkout's install as a repair.
- **Relative paths.** Bind tools to `TASK_SOURCE` (or use its absolute paths),
  not an implicit shared checkout. Creating a worktree does not move the
  caller's working directory.

## Home Screen quick actions (2026-10-30)

- Info.plist and project.yml declare
  `dev.tessera.ios.{capture,today,review,library}` with SF Symbols. `main.mm`
  stores the action's suffix in a pending slot:
  - on a cold launch, from the scene's connection options (it swizzles
    `scene:willConnectToSession:options:`);
  - in a running app, from
    `windowScene:performActionForShortcutItem:completionHandler:`, or the app
    delegate's equivalent;
  - then it fires `tessera-shortcut`.
- `web/src/shell/home-shortcuts.ts` takes the action with
  `webkit.messageHandlers.tesseraShortcut.postMessage('take')`, which has a
  reply handler. App.tsx then runs it: Capture calls
  `quickCreate(blankCapture())`; a tab calls `selectPhoneTab(tab, true)`,
  landing at the tab's root.
- **Keyboard after a capture.** WebKit never shows the keyboard for a script's
  focus without a user touch. It doesn't even call
  `-[WKContentView _elementDidFocus:userIsInteracting:…]`, so swizzling that
  does nothing. Instead:
  1. The page waits until the focused editor's rect has held still for 3 frames,
     then posts `{ keyboard: [x, y, w, h] }`.
  2. Native calls WKWebView's private Scribble API,
     `_requestTextInputContextsInRect:completionHandler:` then
     `_focusTextInputContext:placeCaretAt:completionHandler:`, which raises the
     keyboard.
- Test in the simulator:
  1. Press Home (`axe button home --udid "$SIM"`) twice; the second press leaves
     jiggle mode.
  2. Find the icon frame with `axe describe-ui --udid "$SIM"` (`AXLabel`
     `Tessera`).
  3. Long-press with selected-simulator `axe touch --down` immediately followed
     by `axe touch --up`, and no sleep: separate calls already hold about 0.5 s,
     and a longer hold enters jiggle mode. Pass `--udid "$SIM"` to both calls.
  4. Tap the item whose `AXLabel` matches in `describe-ui`, again selecting `SIM`.
     For a cold launch, use `xcrun simctl terminate "$SIM" dev.tessera.ios` on
     this run's simulator first. Native `NSLog` output appears in
     `xcrun simctl spawn "$SIM" log show --last 2m --predicate 'process == "Tessera"'`;
     retain relevant output in `TASK_EVIDENCE`.

## Live inspection on the physical phone

`devicectl` install and launch work over Wi-Fi (`Transport Type: localNetwork` in
`devicectl device info details`).

`ios_webkit_debug_proxy -c <UDID>:9621,:9622-9630` needs the phone on USB
through `usbmuxd`. If `ideviceinfo` says "No device found" and
`system_profiler SPUSBHostDataType` lists no iPhone, the proxy never listens,
even when the user says the phone is plugged in. The causes are a charge-only
cable, a locked phone, or an unanswered "Trust this computer?". Ask the user to
unlock and trust, or to swap cables; don't retry the proxy blindly. Web
Inspector must also be on (Settings › Apps › Safari › Advanced).

## Simulator (headless, scriptable)

1. **Runtimes.** iOS 27.0, 27.1 and 27.2 (24B114) were installed during earlier
   rounds; verify the required installed runtime before use. The historical 27.2
   download used `xcodebuild -downloadPlatform iOS -buildVersion 27.2` (8.3 GB,
   2026-10-29), and Xcode 27.1 ran it. A missing runtime is an explicit host
   prerequisite, not an automatic download/terms-acceptance step.
   - Create a unique device with
     `xcrun simctl create "$TASK_ID" com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-2`,
     record the returned UDID as `SIM`, then `xcrun simctl boot "$SIM"` and
     `xcrun simctl bootstatus "$SIM" -b`. Select only that identity in every
     simulator, AXe and proxy action. Record runtime/device identity in the run
     ledger.
   - Historical device `tessera-18pro` (086F158D…, iOS 27.0) has a hardware
     keyboard attached (see "Real touches"); do not reuse that or another
     session's active simulator. Each concurrent lane creates its own device and
     proxy ports.
   - A fresh install shows "Where is your workshop?". Tapping "Start a workshop"
     at about (118, 759) gives an empty workshop.
2. **Seed.** Stage a matching built or explicitly selected shipped CLI at
   `TASK_BIN` per the shared procedure (record its build; do not assume the
   installed app matches the source). Run
   `task_run env TESSERA_BIN="$TASK_BIN" bun "$TASK_SOURCE/mise-tasks/seed/clickaround" "$TASK_RUN/notebooks/ios-seed"`.
   In only this verified owned seed copy, remove any copied `service.lock` and
   use `/usr/bin/sqlite3` to clear `sync_hub` before launch; never edit a live
   notebook/registry.
   - Install the simulator app on the recorded `SIM`, launch it once and
     terminate only that app on that simulator.
   - Resolve `xcrun simctl get_app_container "$SIM" dev.tessera.ios data` and
     verify it belongs to this fresh run-owned simulator. Replace only its
     `Library/Application Support/dev.tessera.ios/notebook` with the detached
     seed's `notebook.db` and `objects/`, then relaunch. No wildcard container
     writes, physical-phone copies or peer simulator writes.
   - Uninstalling also wipes WKWebView `localStorage` and saved navigation; if
     needed for a first-launch check, do it only on the recorded throwaway
     `SIM`.
3. **Drive the WKWebView.** `ios_webkit_debug_proxy`, AXe and the external
   simulator helper below are prerequisites, not supplied by this checkout.
   Resolve/inspect them under normal host HOME; do not silently install tools or
   accept account/security prompts.
   - Run the selected proxy under `task_run` as a unique named service, with
     `-s unix:<verified-SIM-socket> -c null:<owned-list-port>,:<owned-page-range>`.
     Record its exact handle, socket, UDID and actual ports.
   - Use `lsof -U -c launchd_sim` and simulator process identity to select the
     `webinspectord_sim` socket for **this** `SIM`; there is one per booted
     simulator and a new one per boot. Do not choose the first socket or reuse a
     peer's range.
   - Historical helper source:
     `~/artifacts/tessera/2026-10-29-ios/tools/sim.mjs`. It must be
     present and support explicit `SIM` and `PORT`; copy the required helper
     into `TASK_RUN/tools` and inspect its dependencies/output behavior before
     use. If unavailable, report that prerequisite rather than invent a
     replacement. It offers `connect`, `evaluate`, `shot`, `tap`, `swipe`;
     import it in `Eval` with this run's SIM/PORT and keep one connection
     (`c = await sim.connect(); ev = s => c.evaluate(s)`). Expressions are
     async-function bodies, so `return` values. Direct captures to
     `TASK_EVIDENCE`.
   - Reconnect after every reinstall or relaunch.
4. **Screenshots.**
   - `xcrun simctl io "$SIM" screenshot "$TASK_EVIDENCE/<shot>.png"` makes a
     1206×2622 image. Don't redirect its output to /dev/null; that once made it
     skip the write.
   - Never read the PNG in the same parallel batch as the call that writes it.
   - Set the theme with `xcrun simctl ui "$SIM" appearance dark|light` only on
     the recorded owned simulator.
5. **DOM handles.**
   - Bottom nav: `.bottom-nav button`. Labels include badge text (`Agenda2`),
     and the nav is hidden in the reader and in review sessions.
   - Find: `.bottom-find`.
   - Header: `.pane.active .pane-header button`, by aria-label (`Index`, `Back`,
     `New`, `New task`, `Atom menu`). Index has a `Settings` row.
   - Scroll boxes: `.outline-pane` (Today, notes) and `.directory-pane` (Index).
   - Library: the reading card `.library-reading-card` opens the reader, whose
     buttons are `Reader settings`, `Reader actions`, `Contents` and
     `Highlights`.
   - Review: `Start…`, then `Reveal answer`.
   - Sheets close through `.popup button` "Close"; Find closes through "Cancel".
   - Tapping the active tab pops to its root.
   - Phone tab history is in `localStorage` `tessera.navigation.<workshop id>` →
     `phone.<pane>.{tab, stacks}`.
6. **Pitfall.** The calendar glyph on a task row is "Schedule for tomorrow",
   which reschedules in one tap; don't click it looking for a date picker.
7. **When done.** Retain native screenshots/UI evidence in `TASK_EVIDENCE`; stop
   the exact proxy/connection handles, then `xcrun simctl shutdown "$SIM"` and
   `xcrun simctl delete "$SIM"` only for this run's throwaway device. Follow
   shared teardown, with explicit handoff for any retained simulator/gallery.

## Real touches

AXe is an external prerequisite (historically installed via
`brew install cameroncooke/axe/axe`), not guaranteed by the checkout. Resolve it
before use; installation is not an implicit QA step. Coordinates are points on a
402×874 screen, and every action must include the recorded simulator UDID:

- `axe tap -x X -y Y --udid <sim>`;
- `axe swipe --start-x … --end-y … --duration 0.3 --udid "$SIM"`;
- `axe touch -x X -y Y --down|--up --udid "$SIM"`. In the app, a long press is
  down, sleep 1.2, up: it selects a word and shows the system edit menu with
  highlight dots. On the Home Screen, use no sleep.
- `axe button home --udid "$SIM"` presses Home.

Map DOM rect centers to points; the mapping is wrong while
`visualViewport.scale != 1`. Tapping a block's text puts the caret there and
opens the keyboard with the Outdent, Indent and Done bar. Tap software keys with
`axe tap` to type.

- **Never `axe type`.** It attaches a hardware keyboard to that device
  permanently, surviving reboots, and the software keyboard stops appearing.
  Insert text through JS instead: the native value setter plus an `input` event.
- An edge swipe from x=2 tests Back, and a tap at y≈15 tests status-bar
  scroll-to-top. A tap on the reader while its chrome is hidden only shows the
  chrome.

## Pitfalls (device)

- `iOS platform not installed`: the required runtime is an explicit
  prerequisite; downloading via `xcodebuild -downloadPlatform iOS` (~16 GB) is a
  host installation, not something to perform silently during QA. Obtain
  authorization if it is missing.
- `Your team has no devices`: provisioning/device registration requires exact
  user authorization for the team/device. Only then run plain
  `xcodebuild -workspace gen/apple/tessera-mobile.xcodeproj/project.xcworkspace -scheme tessera-mobile_iOS -destination id=<confirmed-UDID> -allowProvisioningUpdates -allowProvisioningDeviceRegistration build`
  with tool `cwd: TASK_SOURCE`; its Rust phase can then fail as previously
  observed.
- `Developer Mode disabled`, untrusted developer or unanswered device trust: the
  user enables/trusts in Settings; do not bypass those prompts.
- A wrong-certificate profile requires diagnosis of the exact cached profile for
  `dev.tessera.ios`. Changing host provisioning state is separately authorized;
  never delete
  `~/Library/Developer/Xcode/UserData/Provisioning Profiles/*.mobileprovision`
  as a wildcard repair. Rebuild with the explicitly selected identity after any
  authorized exact-profile correction.

## Known gaps

- Opening EPUBs from other apps and sharing are Android only.
- Development signing expires; rebuild when it does.
- The iPhone has no Mac sync configured yet; it keeps its own notebook.

## Design rounds

- 2026-10-24: the plate kit and proposals are in
  `~/artifacts/tessera/2026-10-24-iphone/` (`kit/`, `BRIEF.md`, `tools/`,
  `clk/`, `fix/`, `reqa/`).
- 2026-10-29: the walkthrough is in
  `~/artifacts/tessera/2026-10-29-ios/`: `shots/00-33`, `notes.json` with
  themes/bugs/per-screen notes, and `tools/index.mjs` for `index.html`. These
  are external historical assets/prerequisites, not checkout-generated tools.
  For a new walkthrough, place captures/notes/gallery under `TASK_EVIDENCE`, use
  an owned free loopback port and a uniquely named server through `task_run`,
  and discuss the gallery before plates or code. If the gallery is retained,
  hand off its exact service handle, persistent files and next owner explicitly.
- The build kit (`BUILD-BRIEF.md`, `FOUNDATION-API.md`, `phone.mjs`, `walk.mjs`)
  is in `.../2026-10-29-ios/build/`.
