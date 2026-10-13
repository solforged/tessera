# Using Tessera

## macOS app

Download `Tessera_<version>_aarch64.dmg` from the [latest release](https://github.com/solforged/tessera/releases/latest), check `SHA256SUMS` on that release, and drag Tessera into Applications. The app is ad-hoc signed, not notarized, so macOS blocks its first launch. Open it once, then choose Open Anyway under System Settings → Privacy & Security, or run:

```sh
xattr -dr com.apple.quarantine /Applications/Tessera.app
```

Later updates need no quarantine step.

### Service and updates

The window uses a notebook service that runs as a launch agent. Closing the window leaves the service, command line, agents and ingestion jobs running. An existing agent keeps its notebook and port.

At launch, the app checks that the agent runs its bundled `tessera`. If it runs another build, the app:

1. Stops the service and backs up the notebook.
2. Starts the bundled build and waits for an answer.
3. If it does not answer, the previous build restores the backup and runs again; the app reports the failure.

The app checks the latest GitHub release a minute after launch, every six hours, and through Tessera → Check for Updates…. It downloads and verifies a signed update, then asks to restart. Restarting backs up the notebook before moving the service onto the new build.

| Action | Effect |
|---|---|
| Close the window | Hides it. |
| Quit | Stops the window, not the service. |
| View → Reload | Reloads the page; it also reloads automatically when another build starts serving. |
| Help → Show Service Log | Opens `~/Library/Logs/tessera/serve.log`. The app records its own steps in `desktop.log` beside it. |

To put the bundled command line on your path:

```sh
ln -s /Applications/Tessera.app/Contents/MacOS/tessera ~/.local/bin/tessera
```

### Import and capture

Opening an EPUB from Finder imports it into the notebook and shows the Library. To make Tessera the default, select an `.epub` in Finder and choose **Get Info → Open with → Tessera → Change All…**. The Library shows upload errors and ingestion progress.

- While Tessera runs, **⌘⇧E** from any app opens a small Add to today panel. Type a line and press Enter to append it to today's journal; focus returns to the previous app.
- Inside Tessera, **⌘E** (File → New Capture) opens the same line over the current page.
- If another app holds ⌘⇧E, Tessera starts without it and records this in `~/Library/Logs/tessera/desktop.log`.

## Android app

[`crates/tessera-android`](../crates/tessera-android) is a Tauri 2 app for Android phones and foldables. Its notebook lives in private app storage; pages reach it over Tauri's IPC, with no listening port. A paired phone copies the Mac's notebook and syncs with it. An unpaired phone keeps a notebook of its own. Web articles, backups and service details are omitted.

### Import and capture

- Library → Add opens Android's file picker for EPUBs.
- In an EPUB's **Open with** chooser, choose **Tessera**, then **Always** to make it the default. **Share → Tessera** also imports EPUBs.
- Android reads the sender's content URI while permission is active, copies it into a private inbox and clears the copy after submitting the import. The Library shows upload errors and ingestion progress.
- Long-pressing the app icon offers New note and New task. Both open Add to today over the current page with the keyboard up.
- Sharing text or a link to Tessera opens Add to today with that text.

### Build and install

Build a debug APK for arm64 and install it on a phone with USB debugging enabled. Run these commands from the repository root:

```sh
mise run android:build
adb install -r crates/tessera-android/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

mise supplies the JDK and Android SDK. The SDK needs an NDK (`sdkmanager --install 'ndk;<version>'`), or `NDK_HOME` must name one.

Extra arguments go to `tauri android build`. For a release APK:

```sh
mise run android:build --target aarch64 --apk
```

It is signed when `TESSERA_ANDROID_KEYSTORE` names a keystore with a `tessera` key and `TESSERA_ANDROID_KEYSTORE_PASSWORD` unlocks it. The Gradle project in `crates/tessera-android/gen/android` is committed; `tauri android init` regenerates it.

### Tailnet download

`mise run android:publish [commit]` (default `HEAD`) builds the commit in its own worktree, strips the native library's debug info (about 90 MB) and signs it again with the release key. It and the GitHub release APKs can update each other without losing the notebook.

The task replaces the previous APK at `https://<this Mac>.<tailnet>:8443/`. On its first run it starts the `dev.tessera.downloads` launch agent, serving from `127.0.0.1:18791`, and adds the Tailscale Serve entry. The page is reachable only from the tailnet.

The signing key comes from the first available source:

1. `TESSERA_ANDROID_KEYSTORE` and `TESSERA_ANDROID_KEYSTORE_PASSWORD`.
2. `~/.android/tessera-release.jks`, with its password in the login Keychain under service `tessera-android-release-keystore`.
3. The 1Password item "Tessera Android release key".

## Browser app

<https://tessera.solforged.io> keeps a notebook in the browser's private storage on one device. Chromium browsers can install it as an app (tested in Brave and Helium): use the install button in the address bar or the browser menu. The app opens in its own window, starts without a network connection, and loads the newest version whenever it is online.

- **Storage:** the app asks the browser to keep its storage. Settings › Backups shows whether it does and how much is used, and downloads the notebook as one file. That file is the only copy outside the browser.
- **One window at a time:** a second window or tab says `Tessera is open in another window.` Use it here moves the notebook there: the first window saves what you typed, closes the notebook and offers Use it here to take it back. A window that does not answer within five seconds has to be closed first.
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

On macOS, `tessera install` starts a launch agent and opens the service at <http://127.0.0.1:4318>; open that URL in a browser. The agent starts at login, restarts the service if it exits and writes stdout and stderr to `~/Library/Logs/tessera/serve.log`.

`tessera uninstall` stops the agent and removes its plist, not the notebook. Install and uninstall are macOS-only; on Linux, run `tessera serve` directly.

### Installing a new build

Install stops the running service, backs up the notebook beside it, starts the new service and waits up to a minute for this build to answer. Settings → Backups lists the backup. With `--rollback /path/to/previous/tessera`, an unresponsive build is replaced by that executable, which restores the backup first.

Install refuses a binary under `target/debug` unless you pass `--allow-debug`.

### Choosing a notebook

To choose a notebook and port:

```sh
tessera --notebook /absolute/path/to/notebook install --port 4397
```

`TESSERA_NOTEBOOK` also persists the notebook choice in the agent. Without either option, the service uses the notebook last chosen in Settings → Notebooks, or the platform data directory's `tessera/notebook`. A missing notebook is created; an existing one is never overwritten.

Settings → Notebooks switches the running service to another folder or starts an empty notebook:

- The service drains, releases the old notebook and restarts on the new one at the same ports. Every open window reloads.
- A window still holding the old identity gets `409 notebook_changed` rather than writing into the new notebook.
- The list lives in `notebooks.json` in the platform data directory's `tessera` folder.
- A service started with `--notebook` can switch too, but that choice lasts only until it restarts.

### Assets and logs

The `embed-web` feature compiles `web/dist` into the binary, so `tessera serve` needs no `--assets` flag. During development, `--assets web/dist` overrides the embedded editor. Without the feature, builds serve only the API unless given `--assets`. The service binds to loopback only and rejects other hosts and browser origins.

Logs go to stderr through `tracing`. `RUST_LOG` selects the filter, defaulting to `info`; the launch agent sets `RUST_LOG=info`. CLI JSON and exports remain on stdout. `tessera info` prints the notebook's identity as JSON.

## Backup and restore

```sh
tessera backup /path/to/new-backup
tessera info --notebook /path/to/new-backup
tessera --notebook /path/to/restored-notebook restore /path/to/new-backup
```

Backup can run while the service runs, but its destination must be empty. It contains:

- An online SQLite snapshot, `notebook.db`.
- Immutable files in `objects/`.
- `manifest.json`: notebook ID, schema version, backup timestamp, object count and database page count.

Restore preserves notebook identity and checks migrations. Stop the destination service first. A non-empty destination requires `--force`; that flag never bypasses a live service lock.

## Syncing a replica

A running service is the hub. Use these commands with a replica:

```sh
tessera --notebook /path/to/replica sync clone http://127.0.0.1:4318
tessera --notebook /path/to/replica sync
tessera --notebook /path/to/replica sync status
tessera --notebook /path/to/replica sync conflicts
tessera --notebook /path/to/replica sync pin <source-id>
tessera --notebook /path/to/replica sync reclone
```

| Command | Behavior |
|---|---|
| `sync clone` | Copies the hub's notebook, without original book files, into an empty directory and registers a new device. On another machine, pass `--code` from the hub's Settings › Devices. |
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

For a non-default notebook, add `--notebook /path` before `mcp`.

### Read tools

Nine tools read:

| Tool | Returns |
|---|---|
| `tessera_search` | Blocks matching text, with their pages. |
| `tessera_list_pages` | Page titles, optionally with journal days. |
| `tessera_read_page` | A page, journal day or one block's subtree as an indented Markdown outline. Each block's comment gives its ID and revision, tags, task planning, project, question, position, relation, citations and cards; field entries show as `Name::`. |
| `tessera_tasks` | The agenda for a day or a run of days, or tasks filtered by status, dates, priority, project or a saved task view. |
| `tessera_cards` | A block's or page's cards, the due, new or full queue (optionally a deck's or a type's), review statistics, or decks. |
| `tessera_query` | Types, fields and saved views, or a type's or view's blocks with their field values, filtered and sorted by field name. |
| `tessera_library` | Sources, a source's contents, its passages in order from an ordinal with passage IDs, passage search, or highlights. |
| `tessera_sync` | Whether the notebook is a replica, when it last synced, how many of its changes have not reached the hub, and the last sync error; `now` syncs first. |
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
| `tessera_save_deck` | Creates, changes or deletes a deck: the cards whose blocks match a type, text or field filters. |
| `tessera_cite` | Links existing blocks to library passages: a whole passage, a range, or the first occurrence of a quote. |

### Text syntax and revisions

Written text follows the editor's syntax:

- `[[Title]]` links the page with that title, creating it when missing.
- `[[id|label]]` keeps an authored label. `[[id|label|locator]]` adds a locator, for example `[[Muqaddimah|have a natural life span like individuals|3.12]]`; title resolution keeps both parts. `[[id||3.12]]` uses the target's current title. The first pipe ends the target and the last pipe starts the locator when there are two or more pipes; intervening pipes belong to the label. Markdown and text exports retain the locator.
- Card operators (`>>`, `<<`, `<>`, `>>>`, `>>1.`) and clozes (`{{c1::answer}}`) make cards. `A << B` shows B and asks for A.
- Beneath a `Mitochondria` block, a child `Function ;; makes ATP` makes a descriptor card asking `Mitochondria › Function`.
- `Name:: value` is always its own block: a field entry on the page at the top level, or on the item it is indented under. It creates the field when missing.
- A write given a block's, card's or deck's revision is refused if it changed since it was read.

### Changes and undo

Each write is one change attributed to the agent by its MCP client name. Open windows show it at once.

- `tessera_recent_changes` lists agent changes; `tessera_undo` reverses one.
- Settings › Agent changes also lists them, with an Undo button.
- Undo refuses to overwrite anyone's later edit, so undo several changes newest first.
- A page or field created by the change stays while other blocks use it.

### Clients without MCP

Agents without MCP use the same endpoints:

| Endpoint | Action |
|---|---|
| `POST /api/agent-changes` | Write a change, using a body like the example below. |
| `GET /api/agent-changes` | List changes. |
| `POST /api/agent-changes/{seq}/undo` | Undo a change, with `{"actor": …}`. |

```json
{"actor": {"kind": "agent", "name": "my-agent"}, "kind": "add_note", "target": {"kind": "page", "title": "Inbox"}, "blocks": [{"text": "A thought", "children": []}]}
```

Other change kinds are `edit_block`, `move_block`, `delete_block`, `set_task`, `set_relation`, `set_card_held`, `cite`, `save_deck` and `delete_deck`. [`crates/tessera-core/src/agent.rs`](../crates/tessera-core/src/agent.rs) defines their fields.
