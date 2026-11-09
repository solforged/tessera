# Contributing

## Reading order

1. [README](../README.md): purpose, principles, current status and screenshots.
2. [How it works](how-it-works.md): the implementation and where to look when
   something breaks.
3. [Domain model](domain-model.md): concepts and their rules.
4. [Architecture](architecture.md): stack decisions and the
   [repository layout](architecture.md#repository-layout).
5. For UI work, read [Design](design.md) and the matching
   [surface document](design.md#surfaces). For replication work, read
   [Sync](sync.md).
6. Read [Vision](vision.md) and [Lessons](lessons.md) for background.

## Diagrams

| Diagram                                    | Where                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Processes and how they connect             | [Architecture](architecture.md#architecture)                                               |
| Crate dependencies                         | [Repository layout](architecture.md#repository-layout)                                     |
| Main tables                                | [Domain model](domain-model.md#domain-model)                                               |
| Task status changes                        | [Tasks](domain-model.md#tasks)                                                             |
| One edit, keystroke to receipt             | [From an edit to a receipt](how-it-works.md#from-an-edit-to-a-receipt)                     |
| Save states                                | [Pending, offline and conflicts](how-it-works.md#pending-offline-and-conflicts)            |
| What text derives and what it leaves alone | [Text is the source of truth](how-it-works.md#text-is-the-source-of-truth-for-some-things) |
| Ingestion, reading and citations           | [Library and reading](how-it-works.md#library-and-reading)                                 |
| How the hub applies a pushed change        | [Sync](sync.md#how-the-hub-applies-a-change)                                               |
| Desktop shell layout                       | [Design](design.md#shell)                                                                  |

## Development

Requires [`mise`](https://mise.jdx.dev). `mise install` installs the toolchain
pinned in `mise.toml` and `mise.lock`. Run `mise tasks` to list the tasks.
Definitions live in [`mise.toml`](../mise.toml) and
[`mise-tasks/`](../mise-tasks), and the CI workflows use them too.

Run from the repository root:

```sh
mise install
mise run serve
```

`serve` builds the editor and serves the workshop in `.tessera/dev` at
<http://127.0.0.1:4320>. Port 4318 belongs to the installed app. See
[Choosing a workshop](usage.md#choosing-a-workshop) for default paths and
workshop selection, and [Assets and logs](usage.md#assets-and-logs) for the
loopback policy and identity output.

For live reloading, use two terminals:

```sh
mise run serve --dev-origin http://127.0.0.1:5173
```

```sh
mise run web:dev
```

Then open <http://127.0.0.1:5173>.

### Audit workspaces

For agent audits and concurrent tasks, use
[Managing Tessera task workspaces](../.agents/skills/managing-tessera-task-workspaces/SKILL.md)
before the task-specific skill. Reuse an uncontended owned checkout; otherwise
use a private worktree at a pinned commit. Each run has separate HOME/XDG state,
notebook copies, browser profiles, and service identities. Retained evidence
lives outside disposable runtime state.

The preparation helper allocates these paths but does not build the app, infer
ownership, or authorize publishing. Native macOS and physical-device acceptance
remains on the host. Stop owned consumers and preserve needed files before
non-forced worktree removal; keep unfinished work for an explicit handoff.

### Seeded clickaround workshop

[`mise-tasks/seed/clickaround`](../mise-tasks/seed/clickaround) defines:

```sh
mise run seed:clickaround [dir] [--replace]
```

It writes a click-through testing workshop to
`~/.local/share/tessera/workshops/clickaround`, or the folder given, and adds it
to Settings → Workshops. It holds the week ending today:

- Journal days, two projects with tasks, clocked work and completions, and
  repeating routines.
- People and concepts with typed fields.
- Cards with a week of review history.
- The bundled _Meditations_ with highlights.
- Catalog records, collections and saved views.

Everything is written through a temporary service's API. Pass `--replace` to
start again on the current week; it refuses while a service has that workshop
open.

### Checks

| Command                                                      | Check                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `mise run check`                                             | Formatting, Clippy, Rust and editor tests, the editor build, and the two prose checks below. |
| `mise run docs:lint`                                         | Vale on `README.md`, `CHANGELOG.md`, `docs/`, `.agents/skills/` and the editor's UI copy.   |
| `mise run docs:test`                                         | The Vale rules' own test cases, with every rule required to fire in at least one.          |
| `mise run commit:lint`                                       | Commit messages from `origin/main` to `HEAD` against the commit convention.                 |
| `mise run fmt`                                               | Formats Rust code.                                                                          |
| `mise run bench --root /tmp/tessera-bench --fail-on budgets` | Backend budgets; see [Performance](performance.md).                                         |

[CI](../.github/workflows/ci.yml) runs Rust `lint` and `test` on Linux and
macOS, plus `web:build`, `web:test`, `demo:lint`, `demo:test`, `android:lint`,
`cli:lint`, `cli:test`, the prose checks and `commit:lint` over the pull
request's commits. `web:test` builds the debug command line first, because the
document tests save through a real service. Set `TESSERA_TEST_BINARY` to test
against another build.
Its backend job runs 50,000-row correctness and scaling checks
with `--sizes 50000 --fail-on scaling`. Absolute budgets are for named devices;
shared runners report them but gate only on correctness and no-per-row-work
checks.

`mise run fonts:keys` redraws the key glyphs in
[`web/src/ui/fonts/keys.woff2`](../web/src/ui/fonts/keys.woff2).

### Browser demo

<https://tessera.solforged.io> runs the real workshop engine in the browser.
`tessera-core` and the service's workshop and library routes compile to wasm in
[`crates/tessera-web`](../crates/tessera-web), then run in a worker over SQLite
in the browser's private storage.

A new browser workshop starts with a choice: empty, the tour, or a restored
backup. The tour seeds Marcus Aurelius' public-domain _Meditations_ from Project
Gutenberg ([`web/src/demo/meditations.epub`](../web/src/demo/meditations.epub))
for the library and reader, and shows a notice bar with Start over…. Visitors
can upload their own EPUBs, and Settings › Backups downloads and restores the
workshop as one file. Web articles, sync and service details are omitted.

```sh
mise run demo:build
```

The task compiles the engine with the wasm32 target, binds it with `wasm-bindgen`
into `web/src/demo/pkg`, shrinks it with `wasm-opt`, then builds the pages.

The output in `web/dist-demo` is static. Serve it with every non-asset path
rewritten to `demo.html`; see [`web/vercel.json`](../web/vercel.json).
[`.github/workflows/demo.yml`](../.github/workflows/demo.yml) deploys it to
Vercel after CI succeeds on `main`, once `VERCEL_TOKEN`, `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` exist. [Releasing](releasing.md#browser-demo) covers a
manual deploy and a rollback.

The build is installable: the manifest and icons are in
[`web/public-demo`](../web/public-demo), and a plugin in
[`web/vite.config.ts`](../web/vite.config.ts) writes `sw.js`, a service worker
that caches every built file. Pages load from the network when it answers and
from that cache when it does not.
[`web/src/demo/installed.ts`](../web/src/demo/installed.ts) handles the
installed window: title bar, opened EPUBs, capture links and app shortcuts.
[Usage](usage.md#browser-app) describes them.

```sh
mise run demo:test
```

This runs the engine's wasm tests in headless Chrome for Testing, since they
need the browser's private storage in a real worker. It uses Playwright's Chrome
for Testing build unless `CHROME_PATH` names another Chrome. `mise` supplies a
matching `chromedriver`. The storage layer is a patched copy of `sqlite-wasm-vfs`
in [`vendor/sqlite-wasm-vfs`](../vendor/sqlite-wasm-vfs). The root `Cargo.toml`
says when it can go.

## Building the app

```sh
mise run desktop:build
```

This builds the editor, command line and
`target/release/bundle/macos/Tessera.app` for this Mac. Extra arguments go to
`tauri build`, for example `--bundles app`.

To develop the window against a development service, run the built app's binary
with `TESSERA_DESKTOP_URL=http://127.0.0.1:4320/`. It leaves the launch agent
alone and never updates itself. See [macOS usage](usage.md#macos-app) for EPUB
handling and capture, and [Android usage](usage.md#android-app) for APK builds
and imports.

### Releases

Public downloads come from `v*` tags. [Releasing](releasing.md) is the version
bump, the changelog, the asset checks and the rollback. Do not create the GitHub
release by hand.

## Shipping a build

`mise run ship [commit]` makes a commit (default `HEAD`) the installed app on
this Mac. It builds Tessera.app in a separate worktree under
`${XDG_CACHE_HOME:-$HOME/.cache}/tessera/ship`, so uncommitted edits never ship.

The task:

1. Quits the app if running and replaces `/Applications/Tessera.app`.
2. Runs the app's `tessera install` with the agent's previous executable as
   rollback. The workshop is backed up and the new build must answer.
3. On success, links `~/.local/bin/tessera` to the app's command line. On
   failure, also restores the previous app.
4. Reopens the app if it was running.

Settings shows the build's commit. A release newer than the shipped version
replaces it through the app's updates.

## Doc conventions

Prose follows the shared house style in
[`.vale/styles/Voice/Brief.md`](../.vale/styles/Voice/Brief.md). The Voice
style is maintained in the system repository and copied here by
`mise run docs:style`; Tessera's own rules and word lists are in
`.vale/styles/Tessera` and `.vale/styles/config`. Spelling, the Tessera
conventions below and the commit convention are errors; the other Voice rules
are warnings that ask for a second look. The
[prose review skill](../.agents/skills/reviewing-tessera-prose/SKILL.md) covers
what the rules cannot check.

- Put surface rules in the matching `docs/surfaces/*.md` file; see the
  [surface list](design.md#surfaces).
- Put tokens and shared patterns in [`docs/design.md`](design.md).
- Keep paragraphs under 150 words; Vale enforces the limit on paragraphs, list
  items and table cells.
- Use American spelling (color, behavior, catalog, canceled, organize). Vale
  checks prose and UI copy against the SCOWL en_US dictionary; code spans keep
  identifiers such as the `cancelled` task status as written. Add a domain word
  the dictionary lacks to `.vale/styles/config/ignore/tessera.txt`, and a name
  whose case matters to `.vale/styles/config/vocabularies/Tessera/accept.txt`.
- Keep a quoted source's spelling: exempt it in place with
  `<!-- vale Tessera.Spelling["colour"] = NO -->` and the matching `= YES`.
- Run `mise run hooks:install` once per clone to check commit messages as you
  write them.
- Prefer lists and tables for parallel rules.
- Update the document in the same commit as the behavior.
