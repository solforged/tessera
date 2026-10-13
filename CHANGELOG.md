# Changelog

Releases are tagged `vX.Y.Z` and match the workspace version. [Releasing](docs/releasing.md) is how a version is cut, published and rolled back.

<!-- releases -->
## Unreleased

### Added

- Argument relations: mark a block as supporting, disputing, qualifying or answering what its first link points to. Targets show who supports or disputes them, and holder pages show it under each perspective held.
- Parent questions: a question can be filed under another question, and question pages list their branches with status.
- Change holder, File under and Use place for perspectives, without editing link text by hand.
- Integrate for journal blocks: move a thought to its page and keep a live reference in the journal.
- Account is kept apart from Work: it shows as "as discussed by" and never becomes a Compare criterion.
- `GET /api/relations`, `GET /api/questions?parent=`, and the MCP tools `tessera_relations` and `tessera_set_relation`.

### Fixed

- Kept cover-screen writing, capture, date pickers and commands above the browser keyboard.
- Contained long library bylines and pane titles, and enlarged related-section and highlight backlink touch targets.
- Preserved prose font metrics when selecting text across outline paragraphs.
- Made unavailable menu actions focusable, with a visible and accessible prerequisite.
- Opened unread sources at the title-page origin.
- Kept contents-margin entries above the reader scroller.
- New typed notes use the submitted title, even when an earlier title matched an existing note.
- New typed notes appear in Merge into and show their ID and creation date without a reload.
- Opening a blank note no longer adds a stored blank block.
- Gloss keeps its standfirst styling when a page is revisited through Find.
- Source metadata visibility survives reloads without following an unrelated field's caret.
- Field rename refuses duplicate names under the same rule as New field.

## 0.3.0, 2026-10-12

### Added

- Pairing and sync between a Mac and an Android phone on a tailnet, with status in the rail and in Settings.
- An Android app for reading, capture and EPUB import. An unpaired phone keeps its own notebook.
- Library browsing: a cover shelf, collections, metadata filters, person pages and a highlights desk in reading order.
- A note index, aliases, finding aids and note headers.
- Paged reading, spreads, a contents margin, chapter maps and touch controls.
- FSRS scheduling, card templates on types, descriptor cards and grade undo.
- Journal days with a period trail, overview tiles and a folded agenda.
- A global capture line on macOS, and notebook switching in the app.
- Agent tools for tasks, cards, queries, the library and sync.

### Fixed

- Outline editing, references, fold motion and conflict display on desk and cover screens.
- Library, review and reader layout on narrow screens.
- Sync status is a bare glyph beside the wordmark, with a state-and-hint slip on pointer hover or keyboard focus. Click or tap opens its summary; the cover row appears only for waiting or action states.

## 0.2.0, 2026-10-08

First published release. It included the macOS app with signed updates, the Linux command line and the browser demo.
