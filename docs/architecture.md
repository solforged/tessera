# Architecture

Tessera is a local Rust service that owns one SQLite notebook, plus a browser editor and other clients that talk to it. The prototype's measurements show that its slow paths came from doing page-sized work per edit, not from its framework, SQLite or HTTP. So the stack stays familiar and the work per edit gets small.

```text
Browser editor      CLI        Agents       Terminal (later)
       \             |            |              /
        WebSocket + HTTP operation API (loopback)
                         |
             tessera-service (one writer)
                         |
          tessera-core: domain rules, transactions
                         |
              SQLite notebook (WAL, FTS5)
```

## Decisions

| Area | Choice | Why |
|---|---|---|
| Core | Rust library `tessera-core` | Transactions, identity rules and derivation in one tested place |
| Storage | SQLite, WAL, FTS5, `synchronous=FULL`; source files in a SHA-256 object store beside it | One notebook directory the CLI and backups can use; durable on power loss; books don't bloat the database |
| Service | Rust `tessera-service` on loopback | Single owner of the file; every client gets the same rules |
| Transport | JSON operations over HTTP; change stream over WebSocket | Agents can use plain HTTP; windows get pushed updates without polling |
| UI | Solid, TypeScript, Vite | Fine-grained updates: typing touches one row, and structural edits cost less than React's list reconciliation in spike 2 |
| Text editing | CodeMirror 6, one active editor per pane, with its Vim extension | Real Vim motions and IME handling without writing a text engine |
| Outline rendering | Plain DOM rows, virtualized with TanStack Virtual for Solid | Bounded memory, mount time and layout cost on large pages |
| Drafts | IndexedDB outbox of pending operations | Asynchronous, incremental, no quota cliff at a few megabytes |
| Packaging | Browser first; Tauri only if native integration is needed | Tauri uses WebKit on macOS and does not by itself make IPC faster |

Each choice has a spike that can overturn it. See [performance](performance.md).

## Core

`tessera-core` exposes typed operations: create, edit text, split, merge, move, indent, delete, restore, add or remove a capability, and so on. Each runs in one transaction. It checks the base revision, applies the change, updates derived data (links, search, types from text, cards), writes a change row and returns the new revisions.

Reads are set-based. Loading a page is a handful of queries for blocks, links, capabilities and field values, never one query per block. Sibling order uses sparse ordinals with an index, so moves don't rescan siblings.

Field values are indexed as the text that produces them is written: an owner, a field, an entry and a value block. The index stores no copies of text; a query reads the value blocks through the field's current kind, so changing a kind never touches the index. Queries gather candidates by type membership or full-text search in SQL, then filter and sort the readings in memory, which keeps every comparison rule in one place.

## Service

`tessera-service` holds the only write connection and a small pool of read connections. Agent context queries run on readers with a time budget, so they never block an edit.

Each committed change gets a sequence number. The service pushes `{seq, changed ids, revisions}` to subscribed windows. A reconnecting window asks for everything after its last sequence. The CLI starts the service on demand when it isn't running, so command-line use doesn't need an open window.

Ingestion runs in the service: network fetches and parsing happen off the write connection, then the resulting snapshot and passages commit as one attributed batch. Extractors live in `tessera-ingest`, which has no database access, so each format is tested on files alone.

The service binds to loopback and rejects untrusted hosts and origins. Remote access is out of scope.

## Browser editor

The editor is split into layers that the prototype mixed together:

1. **Document store.** Blocks keyed by ID, each with its own immutable snapshot. Components subscribe to one block, so typing re-renders one row.
2. **Commands.** Outline operations (split, indent, move, fold, zoom) as pure functions over the store, producing operations for the service and inverses for undo.
3. **Text editor.** One CodeMirror instance in the focused block of each pane. Other blocks render as static DOM with reference and card decorations.
4. **Rendering.** A virtualized list of visible rows with measured heights and scroll anchoring. The focused or composing row stays mounted.
5. **Sync.** Coalesce text edits for 150 to 300 ms (1 s maximum), send them as revision-checked operations, and store pending ones in the IndexedDB outbox until the service acknowledges them. "Saved" appears only after a commit.

Undo is a stack of operations and their inverses, shared by both panes on the same page. Cross-block selection uses block ID plus offset at each end, so it works when rows are off screen.

Two panes, back and forward history, and per-pane fold, zoom and caret state are part of the shell from the start.

## Conflicts

A stale operation fails without writing. Clean remote changes merge into the local view block by block. When a remote change touches a block with unsent local text, the local text is kept and the block shows a conflict with both versions. Nothing is merged automatically.

## Why not the alternatives

- **WASM with SQLite in the browser:** the notebook would live in origin-private storage, out of reach of the CLI, agents and ordinary backups.
- **React:** the larger ecosystem, but its list reconciliation added about 7 ms per structural edit at 10,000 mounted rows in spike 2, against about 1 ms for Solid, for the same correctness.
- **ProseMirror or Lexical as one big editor:** better cross-block text selection, but no usable outline-aware Vim. In spike 2, ProseMirror matched CodeMirror on IME, undo and cross-block selection and failed only on Vim.
- **Canvas rendering:** would mean rebuilding selection, IME and accessibility.
- **Go or another rewrite language:** no measured benefit; the prototype's slowness was algorithmic.

## Repository layout

```text
crates/tessera-core      domain model, migrations, operations
crates/tessera-service   HTTP and WebSocket service
crates/tessera-cli       command line
crates/tessera-bench     corpus generator and backend budget checks
crates/tessera-ingest    extractors for books, articles and later other formats (planned)
web/                     Solid editor
spikes/editor/           editor prototypes and their measurement runner
docs/                    design documents
```
