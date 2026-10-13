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
- Read, Outline and Compare projections on titled pages. Concept and question pages open in Read: the opening on one text edge, then one slip per perspective with its Gist, Work and Account, facts folded, and disagreements filed under the criterion they name. Prose stays editable in place.
- Add perspective: pick who holds it, and the perspective opens with its Gist ready to write.
- A section line at the top of long pages names the section and perspective you are in, and jumps to any other.
- Compare focuses a disagreement on the perspectives it names, and criterion cells use the outline's editor, with references, quotes and one undo history.
- Zooming into a perspective opens its dossier: holder, Gist, Work and what links to that perspective, without the page's backlinks.
- Holder pages open into the perspectives they hold, grouped by subject.
- Questions as research programs: branches show their state, perspectives, current reading and revisit date; Write assessment, Accept current reading and Withdraw current reading keep every dated assessment; verbs say which state they lead to.
- The Questions index groups questions by program, includes inline questions, and has Active, Recurrent, Due, Answered and Parked tabs.
- Revisits: notes and questions with a revisit date come back in Review's Questions and notes queue and in Today, with Revisited, Later, Resolve and Keep recurrent.
- `GET /api/revisits`, `GET /api/questions` state and inline filters, and the MCP tools `tessera_revisits` and `tessera_revisit`.
- Views over research entities: a view's source can be notes, questions, positions, sources, tasks or highlights, with their own attributes (holder, subject, relation, state, last assessed, revisit, cites and more) as filters, sorts, groups and columns. Dates can be relative, such as 30 days ago, with an Or empty option.
- Saved views keep their recipe: column order and widths, sorts in priority order, grouping with collapsed groups, phone card fields and a one-line purpose.
- Position, question and highlight values render in views and edit in place with one undo.
- Field roles: standfirst, attribute, prose and citation decide how a field is shown. Gist and Gloss became standfirsts.
- Filling fields by keyboard: Tab and Shift-Tab move between a block's fields, Shift-Enter adds a line, and Enter on an empty value leaves. Add field offers the perspective's recipe fields first.
- Span fields read historical ranges such as `c. 200–118 BCE` or `fl. 1340s` as years for sorting and filtering, and keep the text as written.
- Reviewed field changes: changing a field's kind shows how each written value maps before applying it; renaming onto an existing field merges them; deleting a field shows its impact and offers Archive, Detach or Delete values. Each applies as one undoable change.
- Library catalog cards can hide fields.
- Register and Matrix layouts for position views: a register reads each position like a Read slip with its Gist and fields editable in place, and a matrix sets holders against the subject's criteria, one matrix per subject.
- Saved views can live on a page as a block, written `[[view:ID|Name]]`. The embed follows the view's recipe, updates as the notebook changes, keeps cells editable and shows card fields on a phone.
- Research desk: questions, the selected question's positions, and the sources the selected position cites, in three linked columns. Each column's query can be edited, and a desk can be saved as a view.
- The sidebar Index reads as a finding aid: kinds sit with their glyphs under Notes, Sources, Work, Tags and Loose heads, and empty built-in kinds fold into one Empty line. `GET /api/index` gives each kind its `shelf`.
- On a phone, the open sidebar starts with the Tessera wordmark, Close sidebar and the notebook name with its note count.
- Review's landing is a ruled register: the due count as a serif figure, a hairline start button and one mono stats line.
- A page's own fields read as a specimen block under its imprint, with mono names, dotted rules and `Add…` on empty slots.
- Make project on a journal block makes it a project page: the block's text names the page (or an existing page of that name becomes the project), its children move there, and the block becomes the link, with one Undo.
- The planning slip's Project picker can start a new project by name, and its Work row shows whether the clock runs and opens Work sessions.

### Changed

- The notebook's own sentences are set in Plex everywhere in the outline, including rows that cite a source, glosses, perspectives and questions, and their previews in Find and on hover. Piazzolla stays for titles, headings, quotes and the reader.
- Sources by the same author keep a three-letter siglum and add a year, a title initial or a number to tell them apart, as `MAT`, `MAT19` and `MAT2`, instead of lengthening the surname.
- Read, Compare, the research desk and tables all call a holder's stance a perspective, with the same counts, tabs and actions.
- On a source with a snapshot, Read in the page header opens the book at your saved position (Shift opens it beside). The reader keeps the source's Read, Outline and Compare tabs, so Outline returns to the page.
- Failed imports sit only in the Library Inbox, folded behind one `N imports failed` line with Retry, Dismiss and Dismiss all, and name the page they tried (`pubmed.ncbi.nlm.nih.gov/16507066`).
- Finding aids count a note's prose blocks, not its field entries, and leave out zero counts; people without prose show their backlinks instead. Sources reads as a denser bibliography with plain author names.
- Review says how many cards come due later today and when the next one is due, instead of a bare "0 cards to review".
- In a split pane or on a phone, page titles stay readable, depth collapses to its current stop, sigla sit on a short line above their paragraph, and the research desk and field owners use fewer columns.
- Perspective slips lead with siglum and holder in mono, then the Gist as a serif headline and Work as one faint line. Where they disagree sets each perspective's answer under the question it settles, instead of hiding it under Facts. Slips stack whenever the pane is narrow, including a split unfolded Fold.
- Holders and pages named in attribute values read as ink with a hairline underline, gilt on hover; prose links keep the gilt and their hover underline is gilt too. Revisit moved into the note's mono Created line.
- Priority reads as three rising bars filled to its level, red for high and amber for medium, instead of `!high`.
- Plan on an unplanned task is a hairline chip with a calendar glyph, so it reads as a control.
- Work sessions lead with a large `h:mm:ss` clock and one Start, Start again or Stop; past sessions list newest first with one-line notes that save as you leave them. Running clocks on rows tick each second.
- Project controls save each choice as it is made; the Save button is gone, and the outcome is focused when a project is made.
- Journal days read `Tuesday, October 13` under a short `2026 · Oct · W42` trail, and Journal and From your highlights head as H2s.
- Opening a page turns one leaf: the previous page stays until the next one is ready, then the new one settles from the right going forward and from the left going back. A cover on the shelf or a Reading now card travels into the source page and back.
- A mode strip's gilt rule glides to the chosen tab instead of fading, and selected-row bars draw down from the top.
- Agenda Week in a pane narrower than 600 px, such as a phone or a narrow split, lists the seven days as one scroll of Day's rows: past days fold to one line, empty days take one line, and a mono line sums the week. The unfolded Fold fits all seven calendar columns.
- Tables and saved views on phones show six or seven compact rows instead of one or two cards. The header scrolls away, a bar at the bottom holds Find and Query, and Query opens a sheet with the full query, Save and Revert; group headings stay in view.
- The note header no longer shows a shortened ID. The page menu opens with the full ID, the creation date and Copy ID, and Copy reference copies a `[[id]]` link.

### Fixed

- Clicking a perspective's holder opens the holder's page instead of the Change holder picker, and a Work that points at a highlight shows its source's siglum.
- Typing `|` in link completion picks the highlighted page and starts the alias, so `[[gen|memory boost]]` links Generation effect and reads "memory boost".
- Link previews open at full size beside their link without jumping, stay inside their pane, and no longer block shortcuts such as Today. Page menus use the screen's height on phones, so Delete is no longer cut off.
- Questions has a Find filter like other kinds, its tabs stay on one line on phones, and index checkboxes, read-register actions and the sidebar's Empty names have touch-sized targets.
- Switching a grouped saved view between Index and Table keeps its grouping, and indexes no longer flash "0 sources" or "Missing field" while loading.
- Reading cards keep two lines of title and creator, coverless articles drop their empty cover, and Contents in the reader focuses the margin list instead of opening a second one.
- Compare's criteria questions stay in view on phones and its holder chooser takes one line; Today's Agenda tile says "Nothing planned" once; spreads explain `=` and `↔`; merge refusals name the reason.
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
- Stopping work no longer throws the Work sessions popup into the window's corner.
- Typing after `/project` no longer lands in the block while its popup waits for the project to save.
- Library no longer flashes empty or stale rows: Back shows its rows and scroll at once, a tab's rows fade in when they arrive, Shelf no longer starts as List, and Reading cards keep their height while their maps load.
- Choosing another source keeps the catalog card on screen until the next one is ready, without a "Loading source details…" flash or its groups jumping.
- Adding a source to a collection shows one Undo notice, which leaves after 10 seconds. Covers fade in once instead of popping, and shelf spines hyphenate instead of splitting words.

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
