# Contributing

## Reading order

1. [README](../README.md): purpose, principles, current status and screenshots.
2. [How it works](how-it-works.md): the implementation and where to look when something breaks.
3. [Domain model](domain-model.md): concepts and their rules.
4. [Architecture](architecture.md): stack decisions and the [repository layout](architecture.md#repository-layout).
5. For UI work, read [Design](design.md) and the matching [surface document](design.md#surfaces). For replication work, read [Sync](sync.md).
6. Read [Vision](vision.md) and [Lessons](lessons.md) for background.

## Diagrams

| Diagram | Where |
|---|---|
| Processes and how they connect | [Architecture](architecture.md#architecture) |
| Crate dependencies | [Repository layout](architecture.md#repository-layout) |
| Main tables | [Domain model](domain-model.md#domain-model) |
| Task status changes | [Tasks](domain-model.md#tasks) |
| One edit, keystroke to receipt | [From an edit to a receipt](how-it-works.md#from-an-edit-to-a-receipt) |
| Save states | [Pending, offline and conflicts](how-it-works.md#pending-offline-and-conflicts) |
| What text derives and what it leaves alone | [Text is the source of truth](how-it-works.md#text-is-the-source-of-truth-for-some-things) |
| Ingestion, reading and citations | [Library and reading](how-it-works.md#library-and-reading) |
| How the hub applies a pushed change | [Sync](sync.md#how-the-hub-applies-a-change) |
| Desktop shell layout | [Design](design.md#shell) |

## Development

Requires [mise](https://mise.jdx.dev). `mise install` installs the toolchain pinned in `mise.toml` and `mise.lock`; `mise tasks` lists the tasks. Definitions live in [`mise.toml`](../mise.toml) and [`mise-tasks/`](../mise-tasks); the CI workflows use them too.

Run from the repository root:

```sh
mise install
mise run serve
```

`serve` builds the editor and serves the notebook in `.tessera/dev` at <http://127.0.0.1:4320>. Port 4318 belongs to the installed app. See [Choosing a notebook](usage.md#choosing-a-notebook) for default paths and notebook selection, and [Assets and logs](usage.md#assets-and-logs) for the loopback policy and identity output.

For live reloading, use two terminals:

```sh
mise run serve --dev-origin http://127.0.0.1:5173
```

```sh
mise run web:dev
```

Then open <http://127.0.0.1:5173>.

### Seeded clickaround notebook

[`mise-tasks/seed/clickaround`](../mise-tasks/seed/clickaround) defines:

```sh
mise run seed:clickaround [dir] [--replace]
```

It writes a click-through testing notebook to `~/.local/share/tessera/notebooks/clickaround`, or the folder given, and adds it to Settings → Notebooks. It holds the week ending today:

- Journal days, two projects with tasks, clocked work and completions, and repeating routines.
- People and concepts with typed fields.
- Cards with a week of review history.
- The bundled *Meditations* with highlights.
- Catalog records, collections and saved views.

Everything is written through a temporary service's API. Pass `--replace` to start again on the current week; it refuses while a service has that notebook open.

### Checks

| Command | Check |
|---|---|
| `mise run check` | Formatting, Clippy, Rust and editor tests, and the editor build. |
| `mise run docs:lint` | Vale on `README.md` and `docs/`. Documentation changes must pass this check; it is separate from `check`. |
| `mise run fmt` | Formats Rust code. |
| `mise run bench --root /tmp/tessera-bench --fail-on budgets` | Backend budgets; see [Performance](performance.md). |

[CI](../.github/workflows/ci.yml) runs Rust `lint` and `test` on Linux and macOS, plus `web:build`, `demo:lint`, `demo:test`, `android:lint`, `cli:lint` and `cli:test`. Its backend job runs 50,000-row correctness and scaling checks with `--sizes 50000 --fail-on scaling`. Absolute budgets are for named devices; shared runners report them but gate only on correctness and no-per-row-work checks.

`mise run fonts:keys` redraws the key glyphs in [`web/src/ui/fonts/keys.woff2`](../web/src/ui/fonts/keys.woff2).

### Browser demo

<https://tessera.solforged.io> runs the real notebook engine in the browser. `tessera-core` and the service's notebook and library routes compile to wasm in [`crates/tessera-web`](../crates/tessera-web), then run in a worker over SQLite in the browser's private storage.

A new browser notebook starts with a choice: empty, the tour, or a restored backup. The tour seeds Marcus Aurelius' public-domain *Meditations* from Project Gutenberg ([`web/src/demo/meditations.epub`](../web/src/demo/meditations.epub)) for the library and reader, and shows a notice bar with Start over…. Visitors can upload their own EPUBs, and Settings › Backups downloads and restores the notebook as one file. Web articles, sync and service details are omitted.

```sh
mise run demo:build
```

The task compiles the engine with the wasm32 target, binds it with wasm-bindgen into `web/src/demo/pkg`, shrinks it with `wasm-opt`, then builds the pages.

The output in `web/dist-demo` is static. Serve it with every non-asset path rewritten to `demo.html`; see [`web/vercel.json`](../web/vercel.json). [`.github/workflows/demo.yml`](../.github/workflows/demo.yml) deploys it to Vercel after CI succeeds on `main`, once `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` exist. [Releasing](releasing.md#browser-demo) covers a manual deploy and a rollback.

The build is installable: the manifest and icons are in [`web/public-demo`](../web/public-demo), and a plugin in [`web/vite.config.ts`](../web/vite.config.ts) writes `sw.js`, a service worker that caches every built file. Pages load from the network when it answers and from that cache when it does not. [`web/src/demo/installed.ts`](../web/src/demo/installed.ts) handles the installed window: title bar, opened EPUBs, capture links and app shortcuts. [Usage](usage.md#browser-app) describes them.

```sh
mise run demo:test
```

This runs the engine's wasm tests in headless Chrome for Testing, since they need the browser's private storage in a real worker. It uses Playwright's Chrome for Testing build unless `CHROME_PATH` names another Chrome; mise supplies a matching chromedriver. The storage layer is a patched copy of `sqlite-wasm-vfs` in [`vendor/sqlite-wasm-vfs`](../vendor/sqlite-wasm-vfs); the root `Cargo.toml` says when it can go.

## Building the app

```sh
mise run desktop:build
```

This builds the editor, command line and `target/release/bundle/macos/Tessera.app` for this Mac. Extra arguments go to `tauri build`, for example `--bundles app`.

To develop the window against a development service, run the built app's binary with `TESSERA_DESKTOP_URL=http://127.0.0.1:4320/`. It leaves the launch agent alone and never updates itself. See [macOS usage](usage.md#macos-app) for EPUB handling and capture, and [Android usage](usage.md#android-app) for APK builds and imports.

### Releases

Public downloads come from `v*` tags. [Releasing](releasing.md) is the version bump, the changelog, the asset checks and the rollback. Do not create the GitHub release by hand.

## Shipping a build

`mise run ship [commit]` makes a commit (default `HEAD`) the installed app on this Mac. It builds Tessera.app in a separate worktree under `~/Library/Caches/tessera/ship`, so uncommitted edits never ship.

The task:

1. Quits the app if running and replaces `/Applications/Tessera.app`.
2. Runs the app's `tessera install` with the agent's previous executable as rollback. The notebook is backed up and the new build must answer.
3. On success, links `~/.local/bin/tessera` to the app's command line. On failure, also restores the previous app.
4. Reopens the app if it was running.

Settings shows the build's commit. A release newer than the shipped version replaces it through the app's updates.

## Doc conventions

- Put surface rules in the matching `docs/surfaces/*.md` file; see the [surface list](design.md#surfaces).
- Put tokens and shared patterns in [`docs/design.md`](design.md).
- Keep paragraphs under 150 words; Vale enforces the limit on paragraphs, list items and table cells.
- Use American spelling (color, behavior, catalog, canceled, organize). Vale flags British forms in prose and names the fix; code spans keep identifiers such as the `cancelled` task status as written.
- Prefer lists and tables for parallel rules.
- Update the document in the same commit as the behavior.
