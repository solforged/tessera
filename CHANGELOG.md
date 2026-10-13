# Changelog

Releases are tagged `vX.Y.Z` and match the workspace version. [Releasing](docs/releasing.md) is how a version is cut, published and rolled back.

<!-- releases -->
## Unreleased

### Added

- Argument relations: mark a block as supporting, disputing, qualifying or answering what its first link points to. Targets show who supports or disputes them, and holder pages show it under each perspective held.
- Parent questions: a question can be filed under another question, and question pages list their branches with status.
- Change holder, File under and Use place for perspectives, without editing link text by hand.
- Integrate for journal blocks: move a thought to its page and keep a live reference in the journal.
- Account is kept apart from Work: it shows under its own label and never becomes a Compare criterion.
- `GET /api/relations`, `GET /api/questions?parent=`, and the MCP tools `tessera_relations` and `tessera_set_relation`.
- Note views: find a kind's notes by title or gloss with `links:`, `from:` and `cites:` chips, group them by source, linked note, month or field, and save the result under the kind.
- Saved spreads: select two to five notes and compare their fields, sources, links and opening prose side by side, with a commentary outline below.
- Passage locators in citations, written `[[Source|label|3.12]]`. Citations read as quiet ink with the locator in mono, a siglum in the gutter and a source preview header; source pages list Cited in apart from Backlinks.
- Bulk filing on Unfiled: select notes, file them under one type in a single change, and undo it in one step.
- Changing a Text field to Choice can add its existing values as options in the same undoable change, and Make option repairs a value that is not an option.
- Add field can create a field of any kind.

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
- Filing picker rows no longer collapse to a few pixels; picking a type files the note at once.
- Table columns stay put while searching and filtering, and an empty cell for a non-template field can be filled from the table.
- Choice filters offer is, is not, has a value and is empty; choice columns sort by option order; pickers mark the current value.
- Saved views show Modified with Save changes and Revert, and the Views menu no longer checks a view that has been changed.
- Changing a field's kind from a note stays on the note.
- Aliases show once, on the ALSO line, and Merge into has its own icon.
- Creating a field never reuses a blank row on the Fields page.

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
