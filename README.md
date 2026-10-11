# Tessera

Tessera is a local-first outline workstation for notes, questions, evidence, tasks and study. You write in an outline of small addressable blocks. Each block is one tile; pages, journals, agendas, investigations and review sessions are different ways of arranging the same tiles.

Status: the daily outline, structure, action, learning, library and reading workflows are working. Pages, journals, references, search, fields, saved tables and two panes share operation-based autosave, undo and conflict handling. Tasks support planning, recurrence, projects, clocked work and historical agendas. Cards derive from authored notes and vocabulary, with query-backed decks, review sessions and retained scheduling history. EPUB books and web articles are ingested as immutable snapshots, read beside the outline, highlighted into cited blocks and exported as BibTeX or CSL JSON. Questions, perspectives and side-by-side comparison have started; capture and the rest of inquiry follow the [roadmap](docs/roadmap.md).

## Screenshots

The notebook below studies anacyclosis, Polybius's cycle of constitutions. Its quotations come from W. R. Paton's public-domain 1923 translation.

### Perspectives on one idea

Each thinker's position sits under the idea it answers, with its source's siglum in the margin and a constellation of every holder beside the page.

![The Anacyclosis page at Perspectives depth, with six positions marked PLA, ARI, POL, CIC, MAC and KHA beside a constellation of their holders](docs/images/perspectives.png)

### Compare positions

Compare presents selected readings side by side, with source sigla, shape marks beside the holders and each account's prose. Authored questions sit below the sheet; fields remain in the source outline.

![A light reading sheet comparing Plato, Polybius and Machiavelli on anacyclosis, with their source titles, prose and an authored question below](docs/images/compare.png)

### Read and cite sources

A source page sits beside its reader. Highlighting a passage writes an ordinary block on the source page that cites it.

![The Polybius Book 6 source page with its metadata and one cited highlight, beside the reader with that passage highlighted](docs/images/reader.png)

### Tasks and agenda

Project tasks stay in their outline. In Agenda's Tasks view, one query line filters by project, state and dates, and each term becomes a removable chip. Add condition brings task, source and field filters into one searchable picker.

![An essay project's tasks beside the Tasks view filtered by the chips show:open, the project and a date range](docs/images/tasks.png)

### Review beside the notes

Review a deck beside the notes its cards come from, on a quiet reading sheet with a compact grading strip, interval previews and the card's retained history.

![A revealed card with four grade intervals and its review history beside the study notes that define it](docs/images/review.png)

## What it is for

- **Writing in outlines.** Nest, move, fold and zoom blocks with the keyboard or the mouse. Vim users get real Vim motions inside a block and structural commands across blocks.
- **Reusing thoughts without copying them.** A reference shows the original block's current text. Editing the original updates every place it appears.
- **Questions that change their answers.** An investigation keeps its dated assessments. Accepting a new answer supersedes the old one without erasing it.
- **Several accounts of one thing.** Sources, passages and attributed positions stay distinct, so disagreement is visible instead of averaged away.
- **Work and study attached to knowledge.** Tasks, schedules and flashcards live on the blocks they concern, with their history intact.
- **Agents as ordinary clients.** Command-line tools and language-model agents use the same checked operations as the editor. They never write to the database directly.

## Principles

1. Never lose work. Unsaved, saved, conflicted and superseded are different states, and the interface says which one applies.
2. Identity outlives wording. Moving, editing or referencing a block keeps its ID, its cards and its history.
3. Structure is added, not chosen up front. A block can gain a task, a question, a card or a type without becoming a different object.
4. Don't drop a frame. Typing, scrolling and navigation have explicit budgets, measured on large notebooks.
5. Quiet and keyboard-first, in a dark or light theme, with every action also reachable by a visible control.

## Documents

- [Vision](docs/vision.md): who it is for and what it must do.
- [Lessons](docs/lessons.md): what the prototype proved and what it got wrong.
- [Domain model](docs/domain-model.md): blocks, capabilities and their rules.
- [Architecture](docs/architecture.md): runtime, editor, storage and sync decisions.
- [Sync](docs/sync.md): replicating a notebook between your own devices, and what keeps collaboration possible.
- [Design](docs/design.md): the browser client's tokens, shell, rows, tables and popups.
- [Performance](docs/performance.md): budgets, the measured baseline and the spikes that decide the stack.
- [Roadmap](docs/roadmap.md): build order and exit criteria.

## Install

### macOS app

Download `Tessera_<version>_aarch64.dmg` from the [latest release](https://github.com/solforged/tessera/releases/latest) and drag Tessera into Applications. The app is ad-hoc signed, not notarized, so macOS blocks the first launch: open it once, then choose Open Anyway under System Settings → Privacy & Security (or run `xattr -dr com.apple.quarantine /Applications/Tessera.app`). Later updates install without that step.

The app is a window onto the notebook service, which keeps running as a launch agent when the window is closed, so the command line, agents and ingestion jobs keep working. At launch it makes sure the agent runs the `tessera` inside the app: if the agent runs another build, it stops the service, backs up the notebook, starts the app's build and waits for it to answer. If that build does not answer, the previous build restores the backup and runs again, and the app says so. An existing agent keeps its notebook and port.

The app checks the latest GitHub release a minute after launch, every six hours, and from Tessera → Check for Updates…. It downloads and verifies a signed update, then asks to restart; restarting moves the service onto the new build with a backup first. Closing the window hides it; Quit stops the window, not the service. View → Reload reloads the page, and the window reloads by itself when another build starts serving. Help → Show Service Log opens `~/Library/Logs/tessera/serve.log`; the app writes its own steps to `desktop.log` beside it. To use the bundled command line, link it onto your path: `ln -s /Applications/Tessera.app/Contents/MacOS/tessera ~/.local/bin/tessera`.

### Android app

`crates/tessera-android` is a Tauri 2 app for Android phones and foldables. The notebook runs inside the app, in its private storage, and the pages reach it over Tauri's IPC, so nothing listens on a port. The phone keeps its own notebook; it does not sync with a desktop notebook. Library → Add opens Android's file picker for EPUBs. Long-pressing the app icon offers New note, which opens today's journal editing an empty block at the end, with the keyboard up. Web articles, backups and service details are left out, as in the browser demo.

Build a debug APK for arm64 and install it on a phone with USB debugging enabled:

```sh
scripts/build-android
adb install -r crates/tessera-android/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

The script needs a JDK (17 or newer) and the Android SDK with an NDK. It uses `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` when set, or else asks mise for `java` and `android-sdk` and takes the newest NDK in the SDK. Extra arguments go to `tauri android build`. The Gradle project in `crates/tessera-android/gen/android` is committed; `tauri android init` regenerates it.

### Command line

Build a self-contained binary with Rust (stable) and Bun:

```sh
bun install --cwd web --frozen-lockfile
bun run --cwd web build
cargo install --path crates/tessera-cli --features embed-web
tessera install
```

On macOS, `tessera install` starts a launch agent and opens the service at <http://127.0.0.1:4318>. Open that URL in a browser. The agent starts at login and restarts the service if it exits. It writes stdout and stderr to `~/Library/Logs/tessera/serve.log`. `tessera uninstall` stops the agent and removes its plist, not the notebook. Install and uninstall are macOS-only; on Linux run `tessera serve` directly.

Install stops the running service, backs up the notebook beside it (listed under Settings → Backups), starts the new service and waits up to a minute for this build to answer. With `--rollback /path/to/previous/tessera`, a build that does not answer is replaced by that executable, which first restores the backup.

To choose a notebook or port, use `tessera --notebook /absolute/path/to/notebook install --port 4397`. `TESSERA_NOTEBOOK` also persists that notebook choice in the agent. Without either, the service uses the platform data directory. Install refuses a binary under `target/debug` unless `--allow-debug` is given.

The `embed-web` feature compiles `web/dist` into the binary. `tessera serve` needs no `--assets` flag; `--assets web/dist` still overrides the embedded editor during development. Builds without that feature serve only the API unless given `--assets`. The service remains loopback-only.

Logs go to stderr through `tracing`. `RUST_LOG` selects the filter, defaulting to `info`; the launch agent sets `RUST_LOG=info`. CLI JSON and exports remain on stdout.

### Building the app

`scripts/build-desktop` builds the editor, the command line and `target/release/bundle/macos/Tessera.app` for this Mac; extra arguments go to `tauri build`, such as `--bundles app`. To develop the window against a development service, run the built app's binary with `TESSERA_DESKTOP_URL=http://127.0.0.1:4320/`; it then leaves the launch agent alone and never updates itself.

The macOS app accepts EPUBs opened from Finder, imports them into its notebook and shows the Library. To make it the default, select an `.epub` in Finder, choose **Get Info → Open with → Tessera → Change All…**. On Android, choose **Tessera** in the EPUB's **Open with** chooser, then **Always**; **Share → Tessera** also imports an EPUB. Android reads the sender's content URI while its permission grant is active, copies it into a private inbox, and clears that copy after submitting the import. Both shells show upload errors and ingestion progress through the Library.

Releases come from `v*` tags matching the workspace version. `.github/workflows/release.yml` first publishes the app, its DMG, the macOS command line, the signed updater archive and `latest.json`, which installed apps poll, then adds the Linux command line. Signing the updater archive needs the `TAURI_SIGNING_PRIVATE_KEY` secret, whose public half is in `crates/tessera-desktop/tauri.conf.json`. Losing the private key strands installed apps on their version.

### Shipping a build

`scripts/ship [commit]` makes a commit (default `HEAD`) the installed app on this Mac. It builds Tessera.app in a separate worktree under `~/Library/Caches/tessera/ship`, so uncommitted edits never ship. It quits the app if it is running, replaces `/Applications/Tessera.app`, and runs the app's `tessera install` with the agent's previous executable as the rollback, so the notebook is backed up and the new build must answer. On success it links `~/.local/bin/tessera` to the app's command line; on failure it also puts back the previous app. It reopens the app if it was running. Settings shows the build's commit. A release newer than the shipped version replaces it through the app's updates.

### Backup and restore

```sh
tessera backup /path/to/new-backup
tessera info --notebook /path/to/new-backup
tessera --notebook /path/to/restored-notebook restore /path/to/new-backup
```

Backup can run while the service is running. Its destination must be empty. It contains an online SQLite snapshot (`notebook.db`), immutable `objects/` files and `manifest.json` with the notebook ID, schema version, backup timestamp, object count and database page count. Restore preserves notebook identity and checks migrations. Stop the destination service first. Restore refuses a non-empty destination unless `--force` is passed; that flag never bypasses a live service lock.

### Agents

`tessera mcp` is a Model Context Protocol server on stdin and stdout. It talks to the running service, so start the service first (`tessera install` or `tessera serve`). Register it with an MCP client, for example Claude Code:

```sh
claude mcp add tessera -- tessera mcp
```

Other clients take the same command in their JSON configuration: `{"command": "tessera", "args": ["mcp"]}`, adding `--notebook /path` before `mcp` for a non-default notebook.

Three tools read: `tessera_search` finds blocks by text, `tessera_list_pages` lists page titles and `tessera_read_page` returns a page or journal day as an indented Markdown outline, marking tasks and giving each block's ID and revision. Five tools write:

| Tool | Change |
|---|---|
| `tessera_add_note` | Appends a Markdown outline to the end of a page, a journal day or a block, creating a missing page or day; without a target it writes to today's journal. List items nest by indentation, headings contain what follows them, and `- [ ]` or `- [x]` items become tasks. |
| `tessera_edit_block` | Replaces a block's text or heading level; editing a page's root renames the page. |
| `tessera_move_block` | Moves a block and its children after a sibling, or first or last under a parent. |
| `tessera_delete_block` | Deletes a block and its children, or a page. |
| `tessera_set_task` | Makes a block a task or changes its status, scheduled date, deadline or priority; done records a completion. |

In written text, `[[Title]]` links the page with that title and creates it when missing, as typing it in the editor does. A write given a block's revision is refused if the block changed since it was read.

Each write is one change attributed to the agent by its MCP client name, and open windows show it at once. `tessera_recent_changes` lists agent changes and `tessera_undo` reverses one; Settings › Agent changes lists them too, with an Undo button. Undo refuses rather than overwrite a later edit by anyone else, so undo several changes newest first. A page the change created stays while other blocks link to it or live on it.

Agents without MCP use the same endpoints: `POST /api/agent-changes` with a body like `{"actor": {"kind": "agent", "name": "my-agent"}, "kind": "add_note", "target": {"kind": "page", "title": "Inbox"}, "blocks": [{"text": "A thought", "children": []}]}`, `GET /api/agent-changes` to list and `POST /api/agent-changes/{seq}/undo` with `{"actor": …}` to undo. The other kinds are `edit_block`, `move_block`, `delete_block` and `set_task`; `crates/tessera-core/src/agent.rs` defines their fields.

## Development

Requires Rust (stable) and Bun.

```sh
bun install --cwd web
bun run --cwd web build
cargo run -p tessera-cli -- --notebook .tessera/dev serve --port 4320 --assets web/dist
```

Open <http://127.0.0.1:4320>. Port 4318 belongs to the installed app. Without `--notebook` (or `TESSERA_NOTEBOOK`), the notebook lives in the platform data directory under `tessera/notebook`. A missing notebook is created; an existing one is never overwritten.

For live reloading, run the service with `--dev-origin http://127.0.0.1:5173` and `bun run --cwd web dev` in a second terminal, then open <http://127.0.0.1:5173>.

The service binds to loopback only and rejects other hosts and browser origins. `tessera info` prints the notebook's identity as JSON.

Checks: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, and `bun run --cwd web build`. Backend budgets: `cargo run --release -p tessera-bench -- --root /tmp/tessera-bench --fail-on budgets`.

### Browser demo

<https://tessera.solforged.io> runs the real notebook engine in the browser: `tessera-core` and the service's notebook and library routes compile to wasm (`crates/tessera-web`) and run in a worker over SQLite in the browser's private storage. The tour seeds a public-domain EPUB from Project Gutenberg (Marcus Aurelius' *Meditations*, `web/src/demo/meditations.epub`) for the library and reader, and visitors can upload their own EPUBs. Web articles, backups and service details are left out. Build it with `rustup target add wasm32-unknown-unknown`, `rustup component add llvm-tools` and `cargo install wasm-bindgen-cli --version 0.2.129 --locked`, then:

```sh
scripts/build-demo-wasm.sh
bun run --cwd web build:demo
```

The output in `web/dist-demo` is static; serve it with every non-asset path rewritten to `demo.html` (see `web/vercel.json`). `.github/workflows/demo.yml` builds and deploys it to Vercel on each push to `main` once the `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` secrets exist.

## Acknowledgments

Tessera borrows ideas from tools and thinkers its author admires:

- **Outliners with addressable blocks**, such as Logseq, Roam Research, RemNote, and Tana: outline-first writing, journal days, block references and backlinks.
- **org-mode and org-roam:** scheduled and deadline dates, repeaters, an agenda and clocked work connected to notes.
- **Vannevar Bush's memex:** associative trails that keep the context of discovery close.
- **[FSRS](https://github.com/open-spaced-repetition/py-fsrs)** for memory scheduling, and **Anki's** four-grade review.

## License

[MIT](LICENSE).
