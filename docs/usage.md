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

The iOS app runs the same pages and workshop as the Android app. Library → Add opens the iOS file picker. Opening EPUBs from other apps, sharing to Tessera and the home screen shortcuts are Android only.

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

Extra arguments go to `tauri ios build`. The Xcode project in `crates/tessera-mobile/gen/apple` is committed. `tauri ios init` regenerates it but drops two hand edits: the camera usage string in `Info.plist`, which the pairing scanner needs, and the app icons, which are cut from `crates/tessera-desktop/icons/icon.svg` without the rounded tile because iOS masks the corners itself.

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

The desktop service backs up once a day while it runs, before installing an update, and when you choose Back up now in Settings › Backups. The first daily check is two minutes after startup; later checks run hourly. A backup is due when none exists or the newest is at least 24 hours old.

These backups share one store at `~/.local/share/tessera/backups/<workshop id>/<UTC timestamp>`, or its XDG data override, wherever the live workshop lives. A snapshot is skipped when its database hash and object count match the newest backup. Immutable files are hard-linked rather than copied; if a hard link fails, that file is copied. Deleting a backup does not delete the live files or another backup's links.

Retention runs after every backup attempt that creates a snapshot or finds it unchanged. It keeps the three newest backups, plus the newest in each of seven UTC calendar days including today, plus the newest in each seven-day window for days 8 through 35. A backup can satisfy more than one tier. Explicit command-line destinations below are separate from this store and its retention.

Settings › Backups shows the latest time, backup count and store size beside Database and files, with Back up now. Store size counts each linked file once. Every backup, including the newest, offers Restore with confirmation; earlier backups fold into a disclosure and also offer Delete. Restore first backs up the current workshop unless nothing has changed, keeps the chosen restore point out of retention, writes a `restore.pending` marker beside the database and drains and restarts the service on the same workshop and ports; the restore itself runs at startup under the service's own lock, so an interrupted restore finishes on the next start and a missing or invalid source is discarded with a warning. The window shows Restoring… until the service answers again; `/api/notebook` answers `503 switching` while it drains. Paired phones keep changes made since the backup until they sync again. Other workshops lists stores for other workshop IDs, including workshops no longer registered; Delete removes that ID's backups, not its live workshop. Both deletion actions ask for confirmation. There is no Keep the latest 10 control.

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
| `sync clone` | Copies the hub's workshop, without original book files, into an empty directory and registers a new device. On another machine, pass `--code` from the hub's Settings › Devices. |
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

### Read tools

Nine tools read:

| Tool | Returns |
|---|---|
| `tessera_search` | Blocks matching text, with their pages. |
| `tessera_list_pages` | Page titles, optionally with journal days. |
| `tessera_read_page` | A page, journal day or one block's subtree as an indented Markdown outline. Each block's comment gives its ID and revision, tags, task planning, project, question, position, relation, citations and cards; field entries show as `Name::`, and image blocks as `![caption](/api/images/<sha>)`. |
| `tessera_tasks` | The agenda for a day or a run of days, or tasks filtered by status, dates, priority, project or a saved task view. |
| `tessera_cards` | A block's or page's cards, the due, new or full queue (optionally a deck's or a type's), review statistics, or decks. |
| `tessera_query` | Types, fields and saved views, or notes, questions, positions, sources, tasks and highlights selected by `source`. Filters and sorts accept field names or `@` attributes; rows include editable field value IDs. Date values may be relative, such as `-30d`, and `or_empty` includes absent values. |
| `tessera_library` | Sources, a source's contents, its passages in order from an ordinal with passage IDs, passage search, or highlights. |
| `tessera_sync` | Whether the workshop is a replica, when it last synced, how many of its changes have not reached the hub, and the last sync error; `now` syncs first. |
| `tessera_relations` | Authored argument edges filtered by `kind`, `source`, `target`, `source_holder` or `target_holder`, with an optional `limit`. At least one filter is required; rows name both endpoints and holders, and any problem. |

### Write tools

Nine tools write:

| Tool | Change |
|---|---|
| `tessera_add_note` | Appends a Markdown outline to a page, journal day or block, creating a missing page or day; without a target it appends to today's journal. List items nest by indentation; headings contain what follows. `- [ ]`, `- [x]`, `- [doing]`, `- [waiting]` and `- [cancelled]` items become tasks. The result lists each card made, what it shows and asks for, and any card syntax that made none. |
| `tessera_edit_block` | Replaces a block's text or heading level; editing a page's root renames the page. |
| `tessera_move_block` | Moves a block and its children after a sibling, or first or last under a parent. |
| `tessera_delete_block` | Deletes a block and its children, or a page. |
| `tessera_set_task` | Makes a block a task or changes its status, scheduled date and time, deadline and time, warning days, repeat or priority; done records a completion. |
| `tessera_set_relation` | Marks a block as `supports`, `disputes`, `qualifies` or `answers`, changes its kind, or removes the capability with `relation: null`. Its first link supplies the target; its ancestors supply the source. The block's text stays unchanged. |
| `tessera_hold_card` | Holds a card out of review, or releases it. |
| `tessera_save_deck` | Creates, changes or deletes a saved deck: the cards whose blocks match a type, text or field filters. A tag on a card's own block is already a deck; this tool is for a queue a tag cannot express. |
| `tessera_cite` | Links existing blocks to library passages: a whole passage, a range, or the first occurrence of a quote. |

### Text syntax and revisions

Written text follows the editor's syntax:

- `[[Title]]` links the page with that title, creating it when missing.
- `[[id|label]]` keeps an authored label. `[[id|label|locator]]` adds a locator, for example `[[Muqaddimah|have a natural life span like individuals|3.12]]`; title resolution keeps both parts. `[[id||3.12]]` uses the target's current title. The first pipe ends the target and the last pipe starts the locator when there are two or more pipes; intervening pipes belong to the label. Markdown and text exports retain the locator.
- Card operators (`>>`, `<<`, `<>`, `>>>`, `>>1.`) and clozes (`{{c1::answer}}`) make cards. `A << B` shows B and asks for A. A tag on that same block, such as `#arabic` after the card, files it into a deck of that name. Review lists the deck without a saved deck. A tag on the page does not file the cards beneath it.
- Beneath a `Mitochondria` block, a child `Function ;; makes ATP` makes a descriptor card asking `Mitochondria › Function`.
- `Name:: value` is always its own block: a field entry on the page at the top level, or on the item it is indented under. It creates the field when missing.
- A write given a block's, card's or deck's revision is refused if it changed since it was read.

### Changes and undo

Each write is one change attributed to the agent by its MCP client name. Open windows show it at once.

- `tessera_recent_changes` lists the workshop's history, from people, windows and agents alike; `tessera_undo` reverses one entry.
- Settings › History lists the same entries with the actor, time, summary and page, and an Undo button where the change has a stored inverse. Editor batches whose operations all have inverses (text, headings, moves, creates, deletes, tasks, relations, revisits, card holds, decks and citations) are reversible; batches with a split, merge, review grade, ingestion, settings or definition change are listed without Undo. Changes applied from another device are listed with their origin and cannot be undone here.
- Undo refuses to overwrite anyone's later edit, so undo changes newest first. Undoing an undo brings the change back.
- A page or field created by the change stays while other blocks use it.

### Clients without MCP

Agents without MCP use the same endpoints:

| Endpoint | Action |
|---|---|
| `POST /api/agent-changes` | Write a change, using a body like the example below. |
| `GET /api/history?limit=&before=` | List history entries, newest first; `before` pages by sequence. |
| `POST /api/history/{seq}/undo` | Undo an entry, with `{"actor": …}`. |
| `GET /api/agent/providers` | List configured providers without their keys. |
| `PUT /api/agent/providers` | Save providers and the default provider. |
| `POST /api/agent/providers/{id}/test` | Test a provider with a short request. |
| `POST /api/agent/turns` | Start an agent turn with a prompt, conversation and context. |
| `GET /api/agent/turns/{turn}/events?after=N` | Wait for events after event N, up to 25 seconds. |
| `POST /api/agent/turns/{turn}/cancel` | Stop an agent turn. |

```json
{"actor": {"kind": "agent", "name": "my-agent"}, "kind": "add_note", "target": {"kind": "page", "title": "Inbox"}, "blocks": [{"text": "A thought", "children": []}]}
```

Other change kinds are `edit_block`, `move_block`, `delete_block`, `set_task`, `set_relation`, `set_card_held`, `cite`, `save_deck` and `delete_deck`. [`crates/tessera-core/src/agent.rs`](../crates/tessera-core/src/agent.rs) defines their fields.
