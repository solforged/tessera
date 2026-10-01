# Architecture

Tessera is a local Rust service that owns one SQLite notebook, plus a browser editor and other clients that talk to it. The prototype's measurements show that its slow paths came from doing page-sized work per edit, not from React, SQLite or HTTP. So the stack stays familiar and the work per edit gets small.

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
| Storage | SQLite, WAL, FTS5, `synchronous=FULL` | One ordinary file the CLI and backups can use; durable on power loss |
| Service | Rust `tessera-service` on loopback | Single owner of the file; every client gets the same rules |
| Transport | JSON operations over HTTP; change stream over WebSocket | Agents can use plain HTTP; windows get pushed updates without polling |
| UI | React 19 with React Compiler, TypeScript, Vite | Mature editor and accessibility ecosystem; fast enough once updates are per block |
| Text editing | CodeMirror 6, one active editor per pane, with its Vim extension | Real Vim motions and IME handling without writing a text engine |
| Outline rendering | Plain DOM rows, virtualized with TanStack Virtual | Bounded memory and mount time on large pages |
| Drafts | IndexedDB outbox of pending operations | Asynchronous, incremental, no quota cliff at a few megabytes |
| Packaging | Browser first; Tauri only if native integration is needed | Tauri uses WebKit on macOS and does not by itself make IPC faster |

Each choice has a spike that can overturn it. See [performance](performance.md).

## Core

`tessera-core` exposes typed operations: create, edit text, split, merge, move, indent, delete, restore, add or remove a capability, and so on. Each runs in one transaction. It checks the base revision, applies the change, updates derived data (links, search, types from text, cards), writes a change row and returns the new revisions.

Reads are set-based. Loading a page is a handful of queries for blocks, links, capabilities and field values, never one query per block. Sibling order uses sparse ordinals with an index, so moves don't rescan siblings.

## Service

`tessera-service` holds the only write connection and a small pool of read connections. Agent context queries run on readers with a time budget, so they never block an edit.

Each committed change gets a sequence number. The service pushes `{seq, changed ids, revisions}` to subscribed windows. A reconnecting window asks for everything after its last sequence. The CLI starts the service on demand when it isn't running, so command-line use doesn't need an open window.

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
- **Solid, Svelte or signals:** finer-grained updates, but per-block subscriptions in React reach the same boundary. Solid is the challenger in the editor spike.
- **ProseMirror or Lexical as one big editor:** better cross-block text selection, but large-document cost and outline-aware Vim are unproven. ProseMirror is the challenger in the editor spike.
- **Canvas rendering:** would mean rebuilding selection, IME and accessibility.
- **Go or another rewrite language:** no measured benefit; the prototype's slowness was algorithmic.

## Repository layout

```text
crates/tessera-core      domain model, migrations, operations
crates/tessera-service   HTTP and WebSocket service
crates/tessera-cli       command line
web/                     React editor
docs/                    design documents
```
