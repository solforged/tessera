# Changelog

Releases are tagged `vX.Y.Z` and match the workspace version. [Releasing](docs/releasing.md) is how a version is cut, published and rolled back.

<!-- releases -->

## Unreleased

### Added

- Inbox groups by publication year, with a fixed author column and the siglum set aside. Years replace decades on that tab's rail, and failed imports open under a heading instead of a collapsed disclosure.

### Fixed

- Recovered locally queued edits from closed browser windows without replaying another open window's drafts.
- Kept cached outlines visible offline and refreshed Revisit and Index after reconnecting, without false errors on new notes.
- Reported Saving rather than Saved while text was still queued or awaiting the service's acknowledgment.
- Highlighted folded Find matches on their original accented glyphs in page and block results.
- Preserved complete Unicode tag names, including combining marks, in rendered pills and server memberships.
- Rendered inline emphasis, code and external-link captions at rest, and added bold and italic editing shortcuts.
- Kept nested bracket expressions literal instead of creating truncated page titles.
- Kept repeated taps on closing popups and sheets from editing controls underneath.
- Replaced selected row ranges on paste and preserved native headings, nested lists, tasks, table rows, image URLs and labeled links from external HTML and Markdown.
- Preserved immediate typing and Backspace corrections through slow highlight note and card delivery.
- Kept source-note catalog apparatus hidden until its metadata finished loading.
- Skipped punctuation-only fragments in revealed review cards' following context.
- Suspended selection tools behind reader popups and sheets without clearing selected text.
- Kept citation jumps below the reader's top fade without shifting restored positions.
- Kept reader shortcuts from intercepting focused controls.
- Listed page-turn, color and selection-clearing keys in Reader actions.
- Clarified that Left/Right arrows turn pages while Up/Down scroll in Scroll layout.
- Kept keyboard focus inside the highlight note sheet and restored it on closing.
- Made Back close the highlight note sheet before leaving reader full screen.
- Kept leading paragraph numerals with the opening prose sentence when selecting by sentence.
- Restored hidden Android reader bars after folding with the note keyboard open.
- Kept truncated prose from older inferred contents out of reader chapter openings and Begin at links.
- Removed repeated split titles, editions and creator bylines beneath the reader title page.
- Counted unnumbered and non-English chapters on the reader title page using the shared chapter entries.
- Preserved literal brackets in passage search and marked only actual full-text matches.
- Added passage and section labels to Find results so repeated headings have distinct destinations.
- Fitted chapter openings to short landscape pages without separating their labels, titles and rules.
- Preserved paragraph boundaries in web articles authored with repeated line breaks so reading progress could advance.
- Recognized numeric superscript footnote references, reciprocal note backlinks and numbered endnote classes during EPUB import.
- Excluded isolated epigraph quotations from inferred EPUB chapter lists.
- Kept authored highlight paraphrases and tags in Markdown exports without repeating unchanged evidence.
- Resolved ancestor highlight citations in Review without exposing the quotation before reveal.
- Revealed the destination pane for explicit highlight note editing and card delivery.
- Excluded card children from highlight note counts and note-editing targets.
- Confirmed highlight removal with counts of written child blocks and incoming references.
- Kept highlight card creation in the desk's document Undo history.
- Named active filters in empty highlight queues.
- Stopped filing tags from duplicating highlight quotations and tag labels.
- Included authored annotation text and tags in Highlights search.
- Reserved the resurfacing Keep checkmark's room to prevent action-row jumps.
- Saved the latest reading position when leaving or hiding the reader before its scrolling pause.
- Kept the visible character when switching from Pages to Scroll.
- Revealed a highlight's marked words when jumping from Highlights, including in long paragraphs.
- Selected the sentence on the current page instead of rewinding a continued paragraph.
- Cleared stale full-screen history markers after reload so Back exited on its next use.
- Deferred reader row measurements to prevent resize-observer loops during restoration and keyboard resizing.
- Opened cover-reader Contents and Highlights as bottom sheets without raising the keyboard.
- Enlarged touch reader navigation and progress chapter rows to 44 px.
- Kept highlight locations readable on their own line in narrow reader pickers.
- Kept reading text visible above settings on short landscape screens.
- Added shared Close and drag-down dismissal controls to bottom sheets.
- Restored pane tabs and Android bars when an inactive reader kept its chrome hidden.
- Removed cover-reader width animation during page restoration and reveal.
- Preserved the Library highlights dock's More actions touch target.
- Presented existing-highlight actions with full-size touch controls on the cover.
- Table row titles use Piazzolla, matching page titles and the phone ledger. Gloss and other authored cells stay in Plex.
- Selecting text and typing `[[` or `((` surrounds it, so the selection becomes a link or block reference instead of being replaced.
- Reader highlight colors stay nameable on the midnight canvas: the band under the line keeps its hue instead of fading into a faint stain.
- Kept footnote references and other links live inside reader highlights.
- Made Space open a focused highlight's actions without scrolling.
- Reduced each reader highlight to one keyboard target across formatting boundaries.
- Expanded footnote reference touch targets without changing their printed size.
- Kept suppressed chapter headings hidden and explained when a selection crosses hidden source text.
- Added Open footnote and a return action so footnote passages can be annotated.
- Placed cross-column selection tools beside an endpoint's line instead of over the selected text.
- Dismissed reader selection tools when their pane became inactive or hidden.
- Honored explicit highlight colors when overlapping marks merged.
- Let locally queued notes close while offline without waiting for service acknowledgment.
- Kept touch selection tools available and repositioned them while scrolling.
- Showed the merged highlight's quotation and context in its note sheet.
- Kept the touch selection dock within the rendered reading measure.
- Preserved note marks' full touch targets at clipped page edges.
- Offered touch-accessible Undo after removing a reader highlight.
- Skipped punctuation-only fragments in a note sheet's following context.

## 0.4.0, 2026-10-14

### Added

- Argument relations: mark a block as supporting, disputing, qualifying or answering what its first link points to. Targets show who supports or disputes them, and holder pages show it under each perspective held.
- Concept pages draw Supports, Disputes and Qualifies between the holders on the constellation, including a relation authored on a perspective filed elsewhere. Disputes take the warm tone; supports and qualifications stay steel, solid and dashed.
- A perspective's holder has to be a person or a group. Who holds this? and Change holder list only those, and can file another page as one or create a new holder.
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
- Relation fields can point at a block or a source, not only a page. Work and Coined in point at sources, and a relation's target lists who points at it.
- Naming a field as you type (`name::`) sets its kind from the first value. The second time a field is used on a tag, the outline offers to add it to that tag's template.
- A type can require a field without refusing the note: the slot stays visible, empty cells read "needed", and indexes count members that still lack it.
- A field can count as creator, contributor or originator, so bylines, sigla, search and a person's Works follow that role. Built-in fields keep the role the schema gives them.
- Read, Outline and Compare projections on titled pages. Concept and question pages open in Read: the opening on one text edge, then one slip per perspective with its Gist, Work and Account, facts folded, and disagreements filed under the criterion they name. Prose stays editable in place.
- Add perspective: pick who holds it, and the perspective opens with its Gist ready to write.
- A section line at the top of long pages names the section and perspective you are in, and jumps to any other.
- Compare focuses a disagreement on the perspectives it names, and criterion cells use the outline's editor, with references, quotes and one undo history.
- Zooming into a perspective opens its dossier: holder, Gist, Work and what links to that perspective, without the page's backlinks.
- Holder pages open into the perspectives they hold, grouped by subject.
- Questions as research programs: branches show their state, perspectives, current answer and revisit date; Write assessment, Accept current answer and Withdraw current answer keep every dated assessment; verbs say which state they lead to.
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
- The workspace is a row of up to four panes. Opening beside lands right of the pane it came from and never replaces that pane; panes the window cannot fit fold into numbered spines.
- Dividers between panes drag, snap at a third, a half and two thirds, move with arrow keys and reset on double click. Widths persist with the row.
- Holding ⌘ over a link shows where a click will open it: the pane it replaces, or a ghost of the new pane. Links, backlinks, sidebar pages, index entries and Library rows can be dragged onto a pane to replace it, or onto its edge to open a new pane there.
- The agent dock: a column right of the panes where you talk to a model you connect yourself, hosted with your own key (Anthropic, OpenAI, OpenRouter) or local (Ollama, llama-server). It reads the pages in view and any links you drag in, and its changes land in the panes, marked, each with Show and Undo. ⌃⇧A shows and hides it; Settings › Agent holds the models, and keys never leave the machine.
- `/api/agent/providers` and `/api/agent/turns` for the dock's models and conversations.

### Changed

- Built-in field names are lowercase and cannot be renamed. Opening a notebook recases older names, and adds author to Book's template, as one synced change.
- Removed the retired editor spike workspace; the performance documentation links to its source and full results at the original comparison commit.
- The notebook's own sentences are set in Plex everywhere in the outline, including rows that cite a source, glosses, perspectives and questions, and their previews in Find and on hover. Piazzolla stays for titles, headings, quotes and the reader.
- Sources by the same author keep a three-letter siglum and add a year, a title initial or a number to tell them apart, as `MAT`, `MAT19` and `MAT2`, instead of lengthening the surname.
- Read, Compare, the research desk and tables all call a holder's stance a perspective, with the same counts, tabs and actions.
- On a source with a snapshot, Read in the page header opens the book at your saved position (⌘ opens it beside). The reader keeps the source's Read, Outline and Compare tabs, so Outline returns to the page.
- ⌘-click opens beside everywhere (Ctrl-click off Apple keyboards), and ⌘Enter from the keyboard; Shift-click now only selects. A link in text, including a perspective's holder, opens in its own pane on a plain click. A list with a pane to its right opens rows there on a plain click and keeps focus.
- The active pane carries a gilt rule along its header, and inactive panes mute their title and tabs.
- Backlinks and related blocks show Open beside as a glyph on the row under the pointer instead of a text button on every row.
- Failed imports sit only in the Library Inbox, folded behind one `N imports failed` line with Retry, Dismiss and Dismiss all, and name the page they tried (`pubmed.ncbi.nlm.nih.gov/16507066`).
- Finding aids count a note's prose blocks, not its field entries, and leave out zero counts; people without prose show their backlinks instead. Sources reads as a denser bibliography with plain author names.
- Review says how many cards come due later today and when the next one is due, instead of a bare "0 cards to review".
- In a split pane or on a phone, page titles stay readable, depth collapses to its current stop, sigla sit on a short line above their paragraph, and the research desk and field owners use fewer columns.
- Perspective slips lead with siglum and holder in mono, then the Gist as a serif headline and Work as one faint line. Where they disagree sets each perspective's answer under the question it settles, instead of hiding it under Facts. Slips stack whenever the pane is narrow, including a split unfolded Fold.
- Read titles a page's perspectives Perspectives even without an authored heading and gives a lone perspective the full measure. Compare stays out of the register until there are two perspectives.
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
- With a pane to the Library's right, clicking a source opens it there, so the list stays put.
- Block, page, note, source and field menus are short: routine actions first, one Make… chooser that only lists what a note doesn't have yet, and a named menu (Task…, Question…, Perspective…) for each thing it has. Rarer choices drill in under Move…, Description…, Appearance…, Collections…, Export… or Definition… with a Back in the menu's head. A paragraph's menu went from 12 rows to 9, a question block's Add or change list from 20 rows to 6 under Make…, and a concept page's menu from 17 to 10.
- On a phone those menus open as a bottom sheet with 44 px rows and Close or Back at the top.
- Zoom and Select left the block menu, and Undo, Redo and Compare left the page menu; their keys, gestures, tabs and palette commands stay. With nothing typed, the palette's Page section lists only what applies to the page.
- A question's accepted assessment is its current answer: Accept current answer, Withdraw current answer and No current answer replace the "current reading" wording, and the Questions table column is Current answer.

### Fixed

- API error messages end at their sentence; the failing operation's index stays in `details` instead of trailing as `(operation None)`.
- Returning to the Library from a source page carries the cover back into its card or shelf slot, instead of the leaf cutting short because the cards remounted under it. A Library refresh keeps unchanged cards and covers in place.
- Opening the Library from the sidebar holds the previous page until its rows arrive, and other panes until they first render, instead of turning to an empty pane. Opening a book turns to the reader at once and fades its text in where it lands.
- Reading now cards no longer flash a spine on articles or change their chapter line after the tab returns, and the Library's list shows the article icon for saved web pages.
- Clicking a perspective's holder opens the holder's page instead of the Change holder picker, and a Work that points at a highlight shows its source's siglum.
- Read shows a field such as Strand once beside its value, instead of a second label row above it, and a Work cited from a highlight stays faint on its slip.
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
- Backspace at the start of a project, relation, perspective, question or assessment row ends that capability, and on an empty row deletes it, as on a todo, instead of refusing to merge.
- Library no longer flashes, blinks or jumps: Back shows its rows and scroll at once, and a tab, Browse filter or sort cross-fades from the old rows to the new in one step instead of dimming the whole pane, with headings, Reading now and filter chips changing together. Filters and sorts load without waiting for a typing pause, and Shelf no longer starts as List.
- The catalog card opens without an empty frame: the ledger glides aside as the card slides in, and back when it closes. Edit details… on a source page does the same. Choosing another source swaps the card's content in place, without a "Loading source details…" flash or its groups jumping.
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
