# Using Tessera

## macOS app

Download `Tessera_<version>_aarch64.dmg` from the [latest release](https://github.com/solforged/tessera/releases/latest), check `SHA256SUMS` on that release, and drag Tessera into Applications. The app is ad-hoc signed, not notarized, so macOS blocks its first launch. Open it once, then choose Open Anyway under System Settings → Privacy & Security, or run:

```sh
xattr -dr com.apple.quarantine /Applications/Tessera.app
```

Later updates need no quarantine step.

### Service and updates

The window uses a workshop service that runs as a launch agent. Closing the window leaves the service, command line, agents and ingestion jobs running. An existing agent keeps its workshop and port.

At launch, the app checks that the agent runs its bundled `tessera`. If it runs another build, the app:

1. Stops the service and backs up the workshop.
2. Starts the bundled build and waits for an answer.
3. If it does not answer, the previous build restores the backup and runs again; the app reports the failure.

The app checks the latest GitHub release a minute after launch, every six hours, and through Tessera → Check for Updates…. It downloads and verifies a signed update, then asks to restart. Restarting backs up the workshop before moving the service onto the new build.

| Action | Effect |
|---|---|
| Close the window | Hides it. |
| Quit | Stops the window, not the service. |
| View → Reload | Reloads the page; it also reloads automatically when another build starts serving. |
| Help → Show Service Log | Opens `~/.local/state/tessera/logs/serve.log`. The app records its own steps in `desktop.log` beside it. |

To put the bundled command line on your path:

```sh
ln -s /Applications/Tessera.app/Contents/MacOS/tessera ~/.local/bin/tessera
```

### Import and capture

Opening an EPUB from Finder imports it into the workshop and shows the Library. To make Tessera the default, select an `.epub` in Finder and choose **Get Info → Open with → Tessera → Change All…**. The Library shows upload errors and ingestion progress.

- While Tessera runs, **⌘⇧E** from any app opens a small Add to today panel. Type a line and press Enter to append it to today's journal; focus returns to the previous app.
- Inside Tessera, **⌘E** (File → Add to Today) opens the same line over the current page.
- If another app holds ⌘⇧E, Tessera starts without it and records this in `~/.local/state/tessera/logs/desktop.log`.

## Android app

[`crates/tessera-mobile`](../crates/tessera-mobile) is a Tauri 2 app for Android phones, foldables and iPhones. Its workshop lives in private app storage; pages reach it over Tauri's IPC, with no listening port. A paired phone copies the Mac's workshop and syncs with it. An unpaired phone keeps a workshop of its own. Web articles, backups and service details are omitted.

### Import and capture

- Library → Add opens Android's file picker for EPUBs.
- In an EPUB's **Open with** chooser, choose **Tessera**, then **Always** to make it the default. **Share → Tessera** also imports EPUBs.
- Android reads the sender's content URI while permission is active, copies it into a private inbox and clears the copy after submitting the import. The Library shows upload errors and ingestion progress.
- Long-pressing the app icon offers New atom and New task. Both open Add to today over the current page with the keyboard up.
- Sharing text or a link to Tessera opens Add to today with that text.

### Build and install

Build a debug APK for arm64 and install it on a phone with USB debugging enabled. Run these commands from the repository root:

```sh
mise run android:build
adb install -r crates/tessera-mobile/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

mise supplies the JDK and Android SDK. The SDK needs an NDK (`sdkmanager --install 'ndk;<version>'`), or `NDK_HOME` must name one.

Extra arguments go to `tauri android build`. For a release APK:

```sh
mise run android:build --target aarch64 --apk
```

It is signed when `TESSERA_ANDROID_KEYSTORE` names a keystore with a `tessera` key and `TESSERA_ANDROID_KEYSTORE_PASSWORD` unlocks it. The Gradle project in `crates/tessera-mobile/gen/android` is committed; `tauri android init` regenerates it.

### Tailnet download

`mise run android:publish [commit]` (default `HEAD`) builds the commit in its own worktree, strips the native library's debug info (about 90 MB) and signs it again with the release key. It and the GitHub release APKs can update each other without losing the workshop.

The task replaces the previous APK at `https://<this Mac>.<tailnet>:8443/`. On its first run it starts the `dev.tessera.downloads` launch agent, serving from `127.0.0.1:18791`, and adds the Tailscale Serve entry. The page is reachable only from the tailnet.

The signing key comes from the first available source:

1. `TESSERA_ANDROID_KEYSTORE` and `TESSERA_ANDROID_KEYSTORE_PASSWORD`.
2. `~/.android/tessera-release.jks`, with its password in the login Keychain under service `tessera-android-release-keystore`.
3. The 1Password item "Tessera Android release key".

## iOS app

The iOS app runs the same pages and workshop as the Android app. Library → Add opens the iOS file picker. Opening EPUBs from other apps and sharing to Tessera are Android only.

Long-press the app icon for its quick actions: Quick capture opens New with the keyboard up, and Today, Review and Library open their tab at its top. Quick capture returns to an unsaved draft instead of starting another.

iPhones stay in portrait; iPads keep their portrait and landscape layouts. The native web form toolbar (Previous, Next and Done) is hidden above the keyboard. The outline editor provides its own Indent, Outdent and Done controls without changing text input or the pairing camera.

### Build and install

Build a debug IPA and install it on an iPhone connected over USB or the local network. Run these commands from the repository root:

```sh
mise run ios:build
xcrun devicectl device install app --device <UDID> crates/tessera-mobile/gen/apple/build/arm64/Tessera.ipa
```

`xcrun devicectl list devices` lists the UDIDs. The build needs Xcode with its iOS platform (`xcodebuild -downloadPlatform iOS`), plus xcodegen and CocoaPods (`brew install xcodegen cocoapods`). It signs for the development team in `crates/tessera-mobile/tauri.ios.conf.json`. When the keychain holds several Apple Development certificates for that team, `TESSERA_IOS_SIGNING_IDENTITY` names the one to use, for example `"Apple Development: sol@sowilo.io (82673GC873)"`.

Before the first install on a new phone:

1. Turn on Developer Mode on the phone (Settings › Privacy & Security › Developer Mode), which restarts it.
2. Register the phone with the team. `tauri ios build` cannot do this, so run Xcode's build once with the phone connected. The Rust step fails because the Tauri CLI is not running, but the phone stays registered:

   ```sh
   xcodebuild -project crates/tessera-mobile/gen/apple/tessera-mobile.xcodeproj -scheme tessera-mobile_iOS \
     -destination id=<UDID> -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
   ```

3. After installing, trust the certificate on the phone (Settings › General › VPN & Device Management) before the first launch.

Extra arguments go to `tauri ios build`. To build and launch in an Apple silicon simulator:

```sh
mise run ios:build -- --debug --target aarch64-sim
xcrun simctl boot <SIMULATOR-UDID>
xcrun simctl bootstatus <SIMULATOR-UDID> -b
xcrun simctl install <SIMULATOR-UDID> crates/tessera-mobile/gen/apple/build/arm64-sim/Tessera.app
xcrun simctl launch <SIMULATOR-UDID> dev.tessera.ios
```

`xcrun simctl list devices available` lists simulators. The simulator does not need a device provisioning profile.

The Xcode project in `crates/tessera-mobile/gen/apple` is committed. `project.yml` keeps the iPhone orientation limit and camera usage string when `xcodegen generate` rebuilds the project and its plist. `Sources/tessera-mobile/main.mm` hides only the web form accessory, leaving native keyboard and camera views alone.

The same native entry point sends `tessera:status-bar-tap` to the page when iOS asks the outer web view to scroll to the top. The shell keeps the outer document one pixel from the top so UIKit delivers that callback, then scrolls the active pane instead. Other scroll delegate methods still reach WebKit.

The entry point also bridges the page to the phone's hardware. At document start it defines `window.tesseraNative = { haptics: true, editMenu: true }`, which no other host sets. `window.webkit.messageHandlers.tesseraHaptic.postMessage(kind)` plays `light`, `medium`, `selection`, `success` or `warning` feedback and ignores other kinds. `tesseraEditMenu.postMessage({ mode: 'highlight', actions: [{ id, label, color? }] })` puts those actions at the front of the system's text-selection menu: an action with a hex `color` is a filled dot, one without is its label, and Copy, Look Up, Translate and Share follow behind the menu's arrow. Tapping one dispatches `tessera:edit-menu` on `window` with `detail: { id }`. `{ mode: 'none' }` leaves the system menu alone, and so does every new document until the page posts again. Only the main frame is heard. The page posts the state while the selection exists, since the menu is built each time it opens.

The web view's tint is the theme's gilt (`--accent`, `#d8aa55` by night and `#93650f` by day, following the system appearance), so the caret and selection handles are gilt rather than system blue.

`tauri ios init` replaces these hand edits as well as the app icons, which are cut from `crates/tessera-desktop/icons/icon.svg` without the rounded tile because iOS masks the corners itself. Preserve those changes when regenerating the project.

## Browser app

<https://tessera.solforged.io> keeps a workshop in the browser's private storage on one device. Chromium browsers can install it as an app (tested in Brave and Helium): use the install button in the address bar or the browser menu. The app opens in its own window, starts without a network connection, and loads the newest version whenever it is online.

- **Storage:** the app asks the browser to keep its storage. Settings › Backups shows whether it does and how much is used, and downloads the workshop as one file. That file is the only copy outside the browser.
- **One window at a time:** a second window or tab says `Tessera is open in another window.` Use it here moves the workshop there: the first window saves what you typed, closes the workshop and offers Use it here to take it back. A window that does not answer within five seconds has to be closed first.
- **Title bar:** the chevron in the window's title bar hides it. Tessera's top bar then holds the window buttons and moves the window.
- **Shortcuts:** in the app window, ⌘N makes a page, ⌘T opens today and ⌘, opens Settings. A browser tab keeps those for the browser. ⌘E adds to today in both.

### Import and capture

- **Opening EPUBs:** Finder's **Open with** lists Tessera once the app is installed. The first open asks permission, then the book goes into the open window's Library.
- **Capture hotkey:** a launcher such as Raycast can open Add to today with either command. The link asks once before the app may open it. Opening the app with a URL (`open -a Tessera.app <url>`) drops the query and opens no capture.

```sh
open "web+tessera:capture"
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --app-id=<id> \
  --app-launch-url-for-shortcuts-menu-item=https://tessera.solforged.io/?capture
```

The app id is `CrAppModeShortcutID` in `Contents/Info.plist` of the installed app, under `~/Applications/Brave Browser Apps.localized/` (Helium: `Chromium Apps.localized`).

## Command line

Build a self-contained binary with [mise](https://mise.jdx.dev). It installs the pinned Rust, Bun and wasm tools from [`mise.toml`](../mise.toml). From the repository root, run:

```sh
mise install
mise run cli:install
tessera install
```

On macOS, `tessera install` starts a launch agent and opens the service at <http://127.0.0.1:4318>; open that URL in a browser. The agent starts at login, restarts the service if it exits and writes stdout and stderr to `~/.local/state/tessera/logs/serve.log`.

`tessera uninstall` stops the agent and removes its plist, not the workshop. Install and uninstall are macOS-only; on Linux, run `tessera serve` directly.

### Installing a new build

Install stops the running service, migrates the old layout if needed, backs up the workshop in the shared backup store, then starts the new service. An unchanged workshop reuses its newest backup. The new build has up to a minute to answer. Settings › Backups lists the restore points. With `--rollback /path/to/previous/tessera`, an unresponsive build is replaced by that executable, which restores the backup first. The first upgrade from a build that only accepts the removed CLI flag needs manual supervision; its old executable cannot use the new flag during automatic rollback.

Install refuses a binary under `target/debug` unless you pass `--allow-debug`.

### Choosing a workshop

To choose a workshop and port:

```sh
tessera --workshop /absolute/path/to/workshop install --port 4397
```

`TESSERA_WORKSHOP` also selects a workshop and persists that choice in the launch agent. The flag and environment variable accept a path. Without either, the service uses the workshop last chosen in Settings › Workshops, or `~/.local/share/tessera/workshops/main`. A missing workshop is created; an existing one is never overwritten. The old flag and environment variable are removed, with no aliases.

Settings › Workshops switches the running service to another folder or creates an empty workshop. Open or create accepts a name such as `reading`, an absolute path, or `~/Documents/reading`. A name resolves inside the workshops folder. Names are trimmed, nonempty, at most 64 Unicode characters, contain no slash and start with neither `.` nor `~`. The list includes registered workshops and workshop folders found inside the workshops folder. Each name is its folder name with the first letter capitalized.

- The service drains, releases the old workshop and restarts on the new one at the same ports. Every open window reloads.
- A window still holding the old identity gets `409 notebook_changed` rather than writing into the new workshop.
- The registry lives at `~/.local/state/tessera/workshops.json`, or its XDG state override. Its JSON fields remain `current` and `notebooks`.
- A service started with `--workshop` can switch too, but that choice lasts only until it restarts.

The API names stay unchanged: `GET /api/notebooks` lists workshops, `POST /api/notebooks/open` accepts `{"path":"reading","create":true}`, and `POST /api/notebooks/forget` accepts a full `path`. Use `create:false` to open an existing workshop. List entries include `display_path`, with home shown as `~`, and `named`, which marks a direct child of the workshops folder.

### Assets and logs

The `embed-web` feature compiles `web/dist` into the binary, so `tessera serve` needs no `--assets` flag. During development, `--assets web/dist` overrides the embedded editor. Without the feature, builds serve only the API unless given `--assets`. The service binds to loopback only and rejects other hosts and browser origins.

Logs go to stderr through `tracing`. `RUST_LOG` selects the filter, defaulting to `info`; the launch agent sets `RUST_LOG=info`. CLI JSON and exports remain on stdout. `tessera info` prints the workshop's identity as JSON.

All desktop platforms use XDG directories, including macOS. Only absolute XDG overrides count. The paths below use the defaults:

| Kind | Default path | Override |
|---|---|---|
| Data | `~/.local/share/tessera` | `XDG_DATA_HOME` |
| State | `~/.local/state/tessera` | `XDG_STATE_HOME` |
| Cache | `~/.cache/tessera` | `XDG_CACHE_HOME` |

Data holds `workshops/main`, named `workshops/<name>`, `backups/<workshop id>/<UTC timestamp>` and the previous desktop executable at `previous/tessera`. State holds `workshops.json`, `agent.json`, `desktop.json` and `logs/{serve,desktop,downloads}.log`. Cache holds `ship`, `android-publish` and `android-downloads`. An override names the base directory; Tessera adds its `tessera` folder.

Registry-following service startup and installation migrate the old layout automatically:

- `~/Library/Application Support/tessera/notebook` moves to `~/.local/share/tessera/workshops/main` on macOS. The old platform default on other desktops moves to the same XDG layout.
- Old `backups/<id>/<timestamp>` folders move into the XDG data backup store.
- `notebooks.json` moves from the old data folder to `~/.local/state/tessera/workshops.json`. Entries merge with an existing new registry; its current selection wins.
- `~/.local/share/tessera/notebooks/<name>` moves to `~/.local/share/tessera/workshops/<name>`. Registry paths follow moved folders.
- Old `agent.json` moves to the state folder, and `android-downloads` moves to the cache folder. Desktop startup moves its old `state.json` to `~/.local/state/tessera/desktop.json`.

Existing targets are never overwritten. A folder collision leaves both workshops and their registry paths in place. Cross-filesystem moves copy and sync before removing the source. Invalid registry data or a workshop owned by a live service stops migration without discarding it.

New logs use `~/.local/state/tessera/logs`, not `~/Library/Logs/tessera`. New caches use `~/.cache/tessera`, not `~/Library/Caches/tessera`. Those old folders and the old desktop rollback executable are left intact. Launch-agent plists stay in `~/Library/LaunchAgents`. Tauri's window-state file stays at `~/Library/Application Support/dev.tessera.desktop/.window-state.json`. Android app-private storage and browser OPFS do not move. Workshops stored elsewhere stay where they are.

## Backup and restore

The desktop service backs up once a day while it runs, before installing an update, and when you choose Back up now in Settings › Backups. The first daily check is two minutes after startup; later checks run hourly. A backup is due when none exists or the newest is at least 24 hours old. When a due check finds nothing changed, later checks skip the snapshot until the database or its write-ahead log changes on disk.

These backups share one store at `~/.local/share/tessera/backups/<workshop id>/<UTC timestamp>`, or its XDG data override, wherever the live workshop lives. A snapshot is skipped when its database hash and object count match the newest backup. Immutable files are hard-linked rather than copied; if a hard link fails, that file is copied. Deleting a backup does not delete the live files or another backup's links.

Retention runs after every backup attempt that creates a snapshot or finds it unchanged. It keeps the newest backup, plus the newest in each of seven UTC calendar days including today, plus the newest in each seven-day window for days 8 through 35, so at most 11. A backup taken before an update or a restore is marked as a safety backup in its manifest and kept for seven days beside these; when nothing changed, the newest backup it reuses takes the mark. A backup can satisfy more than one tier. Explicit command-line destinations below are separate from this store and its retention.

Settings › Backups shows the latest time, backup count and store size beside Database and files, with Back up now. Store size counts each linked file once. Stored backups, closed by default, lists every backup with Restore and confirmation, and all but the newest also offer Delete. A failed automatic backup shows its time and reason there until a later backup succeeds. The failure is kept in memory, and a restart retries within two minutes.

Restore first backs up the current workshop unless nothing has changed, keeps the chosen restore point out of retention, writes a `restore.pending` marker beside the database and drains and restarts the service on the same workshop and ports; the restore itself runs at startup under the service's own lock, so an interrupted restore finishes on the next start and a missing or invalid source is discarded with a warning. The window shows Restoring… until the service answers again; `/api/notebook` answers `503 switching` while it drains. Paired phones keep changes made since the backup until they sync again. Other workshops lists stores for other workshop IDs, including workshops no longer registered; Delete removes that ID's backups, not its live workshop. Both deletion actions ask for confirmation. There is no Keep the latest 10 control.

| Endpoint | Result |
|---|---|
| `GET /api/backups` | `{backups, store_size, others}`; backups are newest first. |
| `POST /api/backups` | `{created, backups}`; `created` is false when unchanged, and `backups` is the full listing envelope. |
| `DELETE /api/backups/{name}` | Deletes one backup and returns the listing envelope. The newest backup is kept. |
| `DELETE /api/backups/others/{workshop_id}` | Deletes another workshop ID's backup store and returns the listing envelope. |
| `POST /api/backups/{name}/restore` | `202 {restoring, backup, safety}` and restarts on the restored workshop; `safety` is the pre-restore backup, or null when unchanged. `409 conflict` during a backup or switch; `404 not_found` for a missing backup or a service started with `--workshop`. |

The manual prune route is removed. Sync recovery copies are separate from this store; only the newest copy of each kind is kept.

For a backup at an explicit destination:

```sh
tessera backup /path/to/new-backup
tessera info --workshop /path/to/new-backup
tessera --workshop /path/to/restored-workshop restore /path/to/new-backup
```

Backup can run while the service runs, but its destination must be empty. It contains:

- An online SQLite snapshot, `notebook.db`.
- Immutable files in `objects/`.
- `manifest.json`: workshop ID, schema version, backup timestamp, object count, database page count and database SHA-256.

Restore preserves workshop identity and checks migrations. Stop the destination service first. A non-empty destination requires `--force`; that flag never bypasses a live service lock.

Both refuse a database that fails SQLite's `quick_check`. `tessera check` runs that check along with the foreign keys, the derived tables and the model's rules, and prints the report as JSON; `tessera check --repair` rebuilds the derived tables. It works through the running service when one owns the workshop.

## Syncing a replica

A running service is the hub. Use these commands with a replica:

```sh
tessera --workshop /path/to/replica sync clone http://127.0.0.1:4318
tessera --workshop /path/to/replica sync
tessera --workshop /path/to/replica sync status
tessera --workshop /path/to/replica sync conflicts
tessera --workshop /path/to/replica sync pin <source-id>
tessera --workshop /path/to/replica sync reclone
```

| Command | Behavior |
|---|---|
| `sync clone` | Copies the hub's workshop, without original book files, into an empty directory and registers a new device. The clone counts as the replica's first sync. On another machine, pass `--code` from the hub's Settings › Devices. |
| `sync` | Pushes the replica's changes, files and reading positions and pulls the hub's. |
| `sync conflicts` | Lists conflict copies and changes the hub could not apply. If both sides changed a block's text, the hub keeps its text and adds the replica's wording immediately after it. |
| `sync pin` | Keeps a book's original file and images ahead of time. Every cover is kept; otherwise, images arrive when the book is opened. |
| `sync reclone` | Re-clones in place, keeping pins and files. After 30 days without syncing, a replica is retired: its next `sync` sends its changes, then asks for a new clone. |

A service running on a replica syncs automatically and logs each sync that moves something, and each failure. While it runs, `sync`, `sync status` and `sync conflicts` go through it; the other commands need it stopped. See [Sync](sync.md) for the protocol.

## Agents

`tessera mcp` is a Model Context Protocol server on stdin and stdout. It talks to the running service.

### MCP setup

Start the service with `tessera install` or `tessera serve`, then register the command with an MCP client. For Claude Code:

```sh
claude mcp add tessera -- tessera mcp
```

Other clients use this JSON configuration:

```json
{"command": "tessera", "args": ["mcp"]}
```

For a non-default workshop, add `--workshop /path` before `mcp`.

The server stays with the workshop it starts with:

- Each tool call finds the service through the workshop's `service.lock`, checks that the service has that workshop's folder open and sends the workshop's ID in `X-Tessera-Notebook`.
- After a switch in Settings › Workshops, or when the lock names a port that serves another workshop, calls are refused with both folders named, and nothing is written. Switch the service back, or restart the MCP server to work in the other workshop.
- Requests to the running service, from `tessera mcp` and from other commands, bypass `HTTP_PROXY` and other proxy settings.

Messages are newline-delimited JSON-RPC 2.0. A batch is accepted only under protocol version 2025-03-26, the one version that defines batches. A malformed message gets a JSON-RPC error, and the session keeps serving. A tool refuses an argument its schema does not declare, naming the ones it takes.

### Read tools

Eleven tools read:

| Tool | Returns |
|---|---|
| `tessera_search` | Blocks matching text, with their pages, up to 200. |
| `tessera_list_pages` | Page titles, optionally with journal days, up to 1000 from `offset`. A list that stops short names the `offset` that lists the rest. |
| `tessera_read_page` | A page, journal day or one block's subtree as an indented Markdown outline that `tessera_add_note` reads back. Each block's comment gives its ID and revision, tags, task planning, project, question, assessment, position, relation, source, revisit date, resolution, citations, and cards with their IDs and revisions. The title's comment does the same for the page. Field entries show as `Name::` and choice values under them as `[[Option]]`, multi-word tags as `#[[Title]]` and image blocks as `![caption](/api/images/<sha>)`. A text line that would read back as structure starts with `\`, and `-->` shows as `--\>`. |
| `tessera_tasks` | The agenda for a day or a run of days, or tasks filtered by status, dates, priority, project or a saved task view. Each view refuses the other's arguments. When `status` names `done` or `cancelled`, `include` defaults to `all`. |
| `tessera_cards` | A block's or page's cards, the due, new or full queue (optionally a saved deck's, a tag deck's or a type's), review statistics, or decks. A page is a title, a page or journal day ID, `YYYY-MM-DD` or `today`. A deck's queue uses the deck's own selection unless `selection` is given. Arguments the chosen mode does not use are refused. |
| `tessera_query` | Types, fields and saved views, or notes, questions, positions, sources, tasks and highlights selected by `source`, `type` or `view`; every other argument needs one of those three. Filters and sorts accept field names or `@` attributes; rows include editable field value IDs. Date values are `today`, a signed day count such as `-30d`, or a date, month or year, and `or_empty` includes absent values. |
| `tessera_library` | Sources, a source's contents, its passages in order from an ordinal with passage IDs, passage search, or highlights. A range citation marks every passage it covers. |
| `tessera_sync` | Whether the workshop is a replica, when it last synced, how many of its changes have not reached the hub, and the last sync error; `now` syncs first. |
| `tessera_relations` | Authored argument edges filtered by `kind`, `source`, `target`, `source_holder` or `target_holder`, with an optional `limit`. At least one filter is required. Each row is one line naming both endpoints, their holders and any problem. |
| `tessera_revisits` | Questions and notes due for a revisit by `due`, earliest first, each with its due date, last revisit and proposed next date, up to `limit`. |
| `tessera_recent_changes` | The workshop's history, newest first, with change numbers, actors and whether undo is available, up to 500 entries. `before` lists older ones. |

### Write tools

Eleven tools write:

| Tool | Change |
|---|---|
| `tessera_add_note` | Appends a Markdown [outline](#outlines) to a page, journal day or block, creating a missing page or day; without a target it appends to today's journal. A page title that is a date is refused in favor of the journal day. Tags in a page title, such as `Ada Lovelace #person`, file the page, an existing one too. The result lists each card made, what it shows and asks for, and any card syntax that made none. |
| `tessera_edit_block` | Replaces a block's text or heading level; editing a page's root renames the page, and a page or journal title takes no heading. Text written over an existing field entry as `Name:: value` replaces its first value; naming a different field is refused. |
| `tessera_move_block` | Moves a block and its children after a sibling, or first or last under a parent. |
| `tessera_delete_block` | Deletes a block and its children, or a page. |
| `tessera_set_task` | Makes a block a task or changes its status, scheduled date and time, deadline and time, warning days, repeat or priority; done records a completion. A call gives a status or at least one field, and `status: none` removes the task and takes no other field. Without a status, a block with no task becomes a todo task, or an appointment when only its scheduled date and time are given. Clearing a repeating task's last date clears its repeat. |
| `tessera_set_relation` | Marks a block as `supports`, `disputes`, `qualifies` or `answers`, changes its kind, or removes the capability with `relation: null`. Its first link supplies the target; its ancestors supply the source. The block's text stays unchanged. |
| `tessera_revisit` | Records a revisit (`revisited`, `keep_recurrent`), moves its date (`later`), resolves a note or reopens it. `next_on` gives the next date, or null for none; `resolve` and `reopen` take no `next_on`. |
| `tessera_hold_card` | Holds a card out of review, or releases it. Its revision is the `r` number in the card's label. |
| `tessera_save_deck` | Creates, changes or deletes a saved deck: the cards whose blocks match a type, text or field filters. A tag on a card's own block is already a deck; this tool is for a queue a tag cannot express. Deck names are unique, ignoring case. An `@` filter needs a type, and `@kind`, `@resolved` and `@revisit` are refused, since such a deck would hold no cards. |
| `tessera_cite` | Links existing blocks to library passages: a whole passage, a range, or the first occurrence of a quote. An empty quote, or a citation the block already has, is refused. |
| `tessera_undo` | Reverses one history entry by its change number. |

A relation, revisit, task, deck or text edit that changes nothing is refused rather than recorded. Without a `revision`, `tessera_set_task` and `tessera_save_deck` send the revision they read, so a change made in between is refused instead of overwritten.

### Outlines

`tessera_add_note` reads a Markdown outline the way `tessera_read_page` writes one:

- List items (`-`, `*`, `+`, `1.`) nest by indentation; a tab counts as four columns. A line indented under an item continues it, and every other line is a block of its own.
- `#` to `######` headings, and lines underlined with `===` or `---`, contain what follows until a heading of the same or a higher level. Headings nest by the level written; levels past 3 are stored as 3.
- An item starting `[ ]`, `[x]`, `[doing]`, `[waiting]` or `[cancelled]` is a task, and a bare marker is an empty task. An item starting `## ` is a heading, and one opening a fence is a code block. A fenced code block is one block.
- A `Name::` line takes the items and lines indented under it as its values.
- A leading `\` keeps the structure marker after it as text, and `--\>` reads as `-->`. `tessera_edit_block` undoes the same escapes.
- An outline nests at most 50 levels, and one note adds at most 5000 blocks.

### Text syntax and revisions

Written text follows the editor's syntax:

- `[[Title]]` links the page with that title, creating it when missing. Otherwise a name matching one page's title or alias, ignoring case, accents and punctuation, links that page as `[[id|Name]]` with the wording kept; a name several pages share is refused, naming each page and its ID.
- A new page's title, from a target or a link, has at most 1000 characters, contains no `[[` or `]]`, and is not a date, which names a journal day.
- `[[id|label]]` keeps an authored label. `[[id|label|locator]]` adds a locator, for example `[[Muqaddimah|have a natural life span like individuals|3.12]]`; title resolution keeps both parts. `[[id||3.12]]` uses the target's current title. The first pipe ends the target and the last pipe starts the locator when there are two or more pipes; intervening pipes belong to the label. Markdown and text exports retain the locator.
- Card operators (`>>`, `<<`, `<>`, `>>>`, `>>1.`) and clozes (`{{c1::answer}}`) make cards. `A << B` shows B and asks for A. A tag on that same block, such as `#arabic` after the card, files it into a deck of that name. Review lists the deck without a saved deck. A tag on the page does not file the cards beneath it.
- Beneath a `Mitochondria` block, a child `Function ;; makes ATP` makes a descriptor card asking `Mitochondria › Function`.
- `Name:: value` is always its own block: a field entry on the page at the top level, or on the item it is indented under. It creates the field when missing. A built-in name such as author, lived, published, url or form gets the built-in field's kind.
- A value the field cannot read as its kind (date, span, URL, number, identifier, checkbox or choice) is refused. A choice value names an option, as `Stage:: Budding`, `Stage:: [[Budding]]` or an item indented under `Stage::`, and links that option; it never creates a page. `tessera_edit_block` reads a value under a choice entry the same way.
- A note cannot go on the Fields page; `Name:: value` creates fields.
- A write given a block's, card's or deck's revision is refused if it changed since it was read: `expected revision 1, found revision 2`, or `…, but it no longer exists`.

### Changes and undo

Each write is one change attributed to the agent by its MCP client name, kept to one line of at most 64 characters; a blank name becomes `mcp`. Open windows show the change at once.

- `tessera_recent_changes` lists the workshop's history, from people, windows and agents alike, naming each actor as `agent NAME`, `client NAME` or `a person`. When a list is full, it ends with the `before` value that lists older changes. `tessera_undo` reverses one entry and names the undo's own change number.
- The History pane (from the Settings header or `Open history`) lists the same entries with the actor, time, summary and page, and an Undo button where the change has a stored inverse. Editor batches whose operations all have inverses (text, headings, moves, creates, deletes, tasks, relations, revisits, card holds, decks and citations) are reversible; batches with a split, merge, review grade, ingestion, settings or definition change are listed without Undo. Changes applied from another device are listed with their origin and cannot be undone here.
- Undo refuses to overwrite anyone's later edit, including an edit to a block nested in what the change added, so undo changes newest first. Undoing an undo brings the change back.
- Undoing a page's or journal day's deletion is refused while another page has its title or another journal has its date; the refusal names the later change to undo, or the page to rename or delete.
- A page or field created by the change stays while other blocks use it.
- A write's result lists at most 50 block revisions; `tessera_read_page` shows the rest. When reading back a committed write's cards fails, the result still reports the change and says not to repeat it.

### Clients without MCP

Agents without MCP use the same endpoints:

| Endpoint | Action |
|---|---|
| `POST /api/agent-changes` | Write a change, using a body like the examples below. |
| `GET /api/history?limit=&before=` | List history entries, newest first, up to 500; `before` pages by sequence. |
| `POST /api/history/{seq}/undo` | Undo an entry, with `{"actor": …}`. The response's `seq` is the undo's own history entry, which another undo reverses; `committed.seq` is the editor's cursor. |
| `GET /api/agent/providers` | List configured providers without their keys. |
| `PUT /api/agent/providers` | Save providers and the default provider. |
| `POST /api/agent/providers/{id}/test` | Test a provider with a short request. |
| `POST /api/agent/turns` | Start an agent turn. The body names a configured `provider` by ID and gives the `prompt`, the conversation so far as `messages` (`{role, text}`, with role `user` or `assistant`) and the `context` pages (`{page_id, block_id?}`); all four are required. |
| `GET /api/agent/turns/{turn}/events?after=N` | Wait for events after event N, up to 25 seconds. |
| `POST /api/agent/turns/{turn}/cancel` | Stop an agent turn. |

A change body has an `actor`, an optional `reason`, a `kind` and that kind's fields. An `add_note` appends `blocks` to a `target`:

```json
{"actor": {"kind": "agent", "name": "my-agent"}, "kind": "add_note", "target": {"kind": "page", "title": "Inbox"}, "blocks": [{"text": "A thought", "children": []}]}
```

| Target | Appends to |
|---|---|
| `{"kind": "page", "title": "Inbox"}` | The page with that title, ignoring case and tags. A missing page is created; a title that is a date is refused in favor of a journal target. |
| `{"kind": "journal", "date": "2026-10-31"}` | That journal day, or today without `date`. A missing day is created. |
| `{"kind": "block", "id": "<block ID>"}` | The end of an existing block's children. |

Each block is `{text, heading?, task?, children}`:

- `text` is one block's text in the syntax above. It is not Markdown: `## Plan`, `- item` and `**bold**` are stored as written. Give a heading with `heading` and nesting with `children`.
- `heading` is a level from 1 to 3.
- `task` makes the block a task, such as `{"status": "todo"}` or `{"status": "todo", "scheduled": "2026-11-03"}`.
- `children` lists the nested blocks, empty or left out for none.

A journal note with a heading, a task beneath it and a field entry:

```json
{"actor": {"kind": "agent", "name": "my-agent"}, "kind": "add_note", "target": {"kind": "journal", "date": "2026-10-31"}, "blocks": [{"text": "Kitchen", "heading": 2, "children": [{"text": "Call the plumber", "task": {"status": "todo"}}, {"text": "Budget:: 4000"}]}]}
```

Children appended to an existing block:

```json
{"actor": {"kind": "agent", "name": "my-agent"}, "kind": "add_note", "target": {"kind": "block", "id": "01JBX5Q2Z8M4V7R9T3W6Y1K0AB"}, "blocks": [{"text": "A follow-up thought"}]}
```

Unknown fields in the request, its target, its blocks or its citations are refused with 422 `invalid_json` naming the field, and nothing is written. A plan the rules refuse gets 422 `validation`, a stale revision 409 `conflict`, and a missing record 404 `not_found` naming its kind, such as `change 999 not found`.

To retry safely after a lost response, send an `Idempotency-Key` header of 1 to 255 ASCII characters without control characters. The same key with the same request returns the first receipt with `committed.replayed: true` and writes nothing; the same key with a different request is refused. A header that is not plain ASCII gets 400 `invalid_header`.

The receipt gives the change number `seq` for undo, a summary, the page, each new or changed block's revision, and the pages, fields and decks the change created or saved. Other change kinds are `edit_block`, `move_block`, `delete_block`, `set_task`, `set_relation`, `revisit`, `set_card_held`, `cite`, `save_deck` and `delete_deck`. [`crates/tessera-core/src/agent.rs`](../crates/tessera-core/src/agent.rs) defines their fields.
