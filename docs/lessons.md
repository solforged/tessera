# Lessons from the prototype

Tessera follows a prototype built between July and October 2026: a Rust and SQLite core with a command line, a terminal interface and finally a React browser editor. It reached a usable daily outline with types, tasks, investigations and card review, backed by about 500 tests. This page records what it proved. The prototype's code is not carried over; its behavior contracts are.

## Keep

**One operation layer.** Every client called the same transactional operations. The browser, command line and agents could not drift apart, because none of them wrote to tables directly.

**Stable identity with checked saves.** An outline save carried the snapshot it was based on. A stale snapshot wrote nothing. Deletion produced a restore ticket bound to an exact ID, revision and deletion event, so undo after autosave brought back the same block rather than a copy.

**Conservative recovery.** One shared document served both panes. Drafts, undo history and the exact in-flight request survived reloads. When a save's result was uncertain, the client checked the server before retrying and never replayed a creation blindly. Exercised against slow, lost and failed responses, this never duplicated or lost a block.

**Card identity is not card wording.** A card was its source block plus a stable key. Editing the text kept the schedule. Removing the markup deactivated the card instead of deleting its history. Resets were recorded as events.

**Composition over classification.** Field definitions, field entries and values were all blocks. Tasks and investigations added behavior to a block without replacing it. Accepting a new answer superseded the old one and kept it.

**Hidden data is never silently deleted.** An outline save could not remove archived or hidden descendants it could not represent.

**Design in the running app.** Doing a real task beside the conversation found problems that specifications missed: invisible syntax rules, popups covering their opener, a side pane that looked like a modal.

## Change

**Behavioral state in a generic property bag.** Tasks began as properties, then moved to a table, then fields moved into blocks. Each move needed a destructive migration. Tessera starts with explicit capability tables.

**Vocabulary inherited from history.** Old names leaked into SQL, types, routes and storage keys. Tessera fixes one vocabulary before the first schema.

**Whole-page work on every keystroke.** The editor re-rendered, revalidated and reserialized the entire page per edit. Typing on a 2,000-block page cost about 28 ms per key. See [performance](performance.md).

**Per-block backend work.** Loading or saving a page cost about 1.3 ms per block, so a 2,000-block autosave took 9.5 s.

**Whole-draft browser storage.** Recovery wrote the full draft and history to `localStorage` on every change. Large pages hit the quota and recovery stopped working when it mattered most.

**One giant editor component.** Keyboard handling, selection, dragging, fields, capabilities and rendering lived in one 1,700-line file. Tessera separates the document model, commands, text editing and rendering.

**Hand-rolled Vim.** Structural Vim worked, but text motions inside a block were never built. Tessera uses an existing Vim implementation for text.

**Terminal first.** The project began as a review-first terminal tool. The browser became primary later. Tessera designs for the graphical editor and keeps other clients on the shared operations.

**Invisible syntax.** `a::b` silently failed to make a card because the parser needed spaces. Authoring rules must either be forgiving or show their result as you type.

## Invariants to test first

Before new features, these become executable examples:

- IDs survive edits, moves, splits and undo.
- A stale save writes nothing; a conflict keeps both versions.
- Undo after autosave restores the same ID.
- Completion, archive, deletion and review scheduling stay separate.
- References show the original, never a copy.
- Card progress survives text edits; resets are recorded.
- An accepted assessment supersedes without erasing.
- Agent edits pass the same checks as human edits.
