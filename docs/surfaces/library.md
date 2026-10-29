# Library and sources

Library is a pane for sources, reading and highlight processing. Source pages retain catalog details, reading progress and passage evidence.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Library pane

### Header and tabs

Every layout starts with the `Sources and highlights` eyebrow and the Library title. Source tabs offer Select and Add actions. The touch cover layout also has Search beside the title; source tabs elsewhere keep the search field visible below the tabs. Collections and Highlights keep their own heading actions. Reading, Inbox and Highlights are the fixed primary tabs; only Highlights shows its nonzero unprocessed count. More holds All, Collections, Finished, Abandoned and saved views, including Not started when saved, and takes the chosen secondary view's name. The selected tab's 2 px gilt rule spans its label and count on the strip's baseline. The last tab is remembered per workshop.

The cover keeps its local Search: it filters titles and creators within the current reading state or collection, preserving Browse filters and exposing sort, grouping and export controls. Global Find's Books and Highlights scopes open matching atoms and passages instead of narrowing that catalog, and its highlight search loads at most 500 highlights. Select, Search and Add beside the Library title each have at least a `--touch-target` hit area.

Source tabs show a controls row below the tabs: a 28 px search field, a sort menu (Added, Title, Author, Year, Last read, Progress, then Group and Save view…), the List and Shelf toggles, Browse and an Export menu (BibTeX, CSL JSON, Markdown) for the selection or the listed sources. On the touch cover layout, Search reveals this row. Browse is disabled where the tab has nothing to browse and Export while nothing is listed. Collections puts its heading and New collection below the tabs. Without a Browse rail, the heading, controls and sources share the centered page measure. A rendered rail and the source measure are centered together; no empty side column is reserved.

Tabs, Browse values, sorting and search answer at once in the toolbar, while the rows below keep showing the previous result until the new rows arrive. The panel then cross-fades to them in one step, together with its headings, Reading now and the filter chips. Typing waits for a short pause; a tab, filter or sort loads at once, and a tab already visited shows its last rows immediately and refreshes them quietly. Loading… appears only when nothing of that kind is loaded and the load takes over 300 ms. Returning to the Library, by Back, the sidebar or in the other pane, shows its last rows, tab, layout and scroll in the first frame and refreshes them quietly. Reading cards keep their last chapter, map and time left from earlier visits.

| Context | Header behavior |
| --- | --- |
| Primary tabs | Reading, Inbox and Highlights stay visible on one line. Secondary and saved views open from More. |
| Desktop pane | The heading and primary tabs match the phone; source controls stay visible below the tabs, without a Search action beside the title. The strip never scrolls. |
| Half pane | Controls wrap under a full-width search field. |
| Touch cover | More preserves the selected secondary view's name; only Highlights shows a count. Search reveals the source controls. |

### List

Rows read as a ledger at least 28 px high:

- A leading slot holds a book or article glyph in `--faint`. A compact row cannot show a cover legibly, so covers appear in the Shelf, Reading now and the phone ledger's taller rows.
- Every tab uses the same row: the mono siglum, gilt on hover, then title and a muted ragged byline (creators, else site). Creators join with ` · `. Bylines wrap to two lines and keep the full text in a tooltip.
- Trailing fixed-width mono columns show state in views spanning states, year, progress and the unprocessed highlight count, so figures line up across tabs. Inside a year group the year column steps aside, because the heading already says it. Inbox rows offer Start reading on hover or focus, always visible without hover; it changes the source's state to Reading.

Progress pairs a short gilt bar with its percentage. A Reading source at zero reads `Not started`; Inbox and Abandoned sources leave the column blank rather than repeat it on every row. A finished source shows `Finished 2026-10-19` using its ISO state-change date, never a percentage or a second Finished label. State-specific tabs omit the redundant state column.

In a pane narrower than 560 px on a wide screen, the state, byline and year columns step aside and progress keeps only its number, so the title keeps its room. Below 600 px, every source ledger uses the same taller card layout, retaining the siglum beside any needed state and stacking the title, byline and compact metadata. Empty progress and highlight cells reserve no space.

The leading slot shows a selection checkbox on hover, focus, or while any row is selected. On a phone the checkboxes stay hidden so covers show whole: Select in the heading reveals them and turns a tap on a source into a toggle rather than opening it, and Done, Clear selection, Escape or a new tab or search ends it. A long press still opens the source's details outside Select. A selected row takes `--selection` and the accent bar.

While rows are selected, a bar of the same height replaces the search line: the count, Details (while the catalog card is closed), Browse, Mark as (one batch for all of them), Export, Add to collection…, Delete and Clear selection. Beside an open card, a ledger narrower than 840 px (1000 px inside a collection, which adds Remove from collection) shows Browse, Export, Add to collection, Delete and Clear selection as glyphs named in tooltips, and Remove without its object, so the bar stays one line. Escape clears.

Clicking a row opens the source page. It fills the pane to the right when one exists; otherwise it uses the Library's pane. ⌘-click opens it beside (Ctrl-click off Mac). The modifier never opens the source in the Library's pane instead. On a wide touch screen, opening a book uses the pane to the right or opens one beside. The opened book keeps a quiet current-page marker.

A row menu offers Read or Continue reading, Mark as reading, finished or abandoned, Return to inbox, Export and Delete….

Delete asks once for all the chosen sources, removes their pages and highlights, moves any pane showing or reading one to another page, and offers Undo in the toast (`2 sources deleted`). Undo puts them back in the list without leaving the Library. Delete source… on a source page works the same, and its undo reopens the page.

### List and shelf

Two icon toggles beside the sort menu, List (ledger rows) and Shelf (covers), choose how sources show. The choice is a device preference per workshop. Icons keep the controls on one line on a phone, where the sort button leaves out its grouping and Export shows only its glyph.

The shelf is a grid of 2:3 covers at least `--shelf-cover-width` wide, sharing any spare width, at the list's measure. Under each cover sit:

- The reader's 2 px position rule, with its `--line` track only once reading has started.
- The title in Piazzolla on up to two lines.
- The byline in `--muted`, clamped to two lines with its full text in a tooltip.
- One mono apparatus line in `--faint`: siglum (gilt on hover), state in views spanning states, year, progress (none once finished) and the unprocessed highlight count.

A source without a cover gets a placeholder on `--surface` with only its centered gilt siglum. The caption carries its title; the same placeholder is used on the shelf, Reading now and collection previews.

The selection checkbox and the actions button sit on the cover's top corners and appear as in the list, on a phone only in Select. A selected cover takes a 2 px accent ring.

On touch the actions button is an always-visible surface disc. Below 600 px it opens the existing source actions in a sheet above navigation, headed by the title, author and mono imprint and progress. Reading and state actions, exports and deletion are separated by rules. Delete still asks for confirmation.

Arrow keys move one book sideways and to the nearest cover in the next row up or down. Home and End go to the ends.
Title sorting uses the finding aid's case- and diacritic-folded filing key, so accented Latin titles stay with their base letters.


### Group

The sort menu has a second section, Group: None, Author, Year, Decade, Publisher or Language. A new library pane starts ungrouped, sorted by Added. Explicit grouping choices remain pane state and also group All.

| Group | Basis | Group order | Missing value, placed last |
| --- | --- | --- | --- |
| Author | First author, else editor | A–Z by family name | `No author` |
| Year | Publication year | Newest first | `Undated` |
| Decade | Publication decade | Newest first | `Undated` |
| Publisher | Publisher | A–Z | `No publisher` |
| Language | Language | A–Z | `No language` |

Rows keep the chosen sort within each group, and Shift-click ranges follow the grouped order. In the list each group opens with a sticky heading on `--canvas`: its name in Piazzolla and a mono count. The shelf instead flows as one grid, so a one-book year takes a cover's width rather than a row: every cover stands on a hairline, and each group's first cover carries the group's name on it. An author's name opens their page. The sort button then reads `Added · by year`.

### Browse

Browse narrows the sources by People, Decades, Publishers and Languages on every tab. The service counts each value over the current tab and search, ignoring the Browse filters themselves, so every value the tab offers stays visible.

Values combine with OR inside a field and AND across fields. People match as author, editor or translator, by page, so a renamed person keeps their filter. Languages count by primary code, so `en`, `en-US`, `eng` and case-insensitive English language names such as `English` are one English. Imports resolve ISO language names to codes; existing catalog fields are normalized when read, without rewriting their authored text.

| Pane width | Browse presentation |
| --- | --- |
| At least 1096 px, with at least 20 sources in the library | A 240 px rail left of the measure, the two centered together. It shows each field's six commonest values with their counts, chosen values pressed, and `All N` opening the rest in a picker. Only a rendered rail reserves its column; Collections has no empty rail offset. |
| Narrower, or fewer than 20 sources | A Browse glyph beside the layout toggles, pressed while any filter applies. It opens one sectioned picker. |

Chosen values also show as removable chips under the controls with Clear filters. Continue reading steps aside while Browse filters apply. Filters travel with the query, so saved views and Export of the listed sources keep them.

### Person page works

A person's page lists their works above the related sections: `Works N` in the faint label, then a grid of 72 px covers (`--work-cover-width`). Each has the title on up to two lines and one mono line of year, Editor or Translator when that is their role, and the reading state or progress. Undated works follow the dated ones, oldest first.

The creator field values those works hold are left out of Backlinks, and the person's hover card counts `N works` before its perspectives and references.

The Works heading and shelf share the page title's left edge. Works and its count sit in mono on either side of a hairline rule.

### Reading now

Reading now appears only on the unsearched, unfiltered Reading tab, with one card for every Reading source, including books not yet started, in the toolbar's sort order. The cards are the list: they replace the rows in the ungrouped List layout, while Shelf shows the covers and a grouping shows grouped rows instead. The touch cover layout keeps Reading cards in either layout and with grouping, without duplicate rows below Up next. A search, filter or saved view brings the rows back on every layout. All lists each source once, without a Reading now card above it. Each card reads top-down:

- Its real cover or spine tile, 56 px wide, beside the title on up to two lines, the author and the current chapter (`4 · Deus Vult!`; `Not started` before any reading, `Reading position` in front matter). Cards use a wider two-column measure so short articles retain their identities; authors and chapter labels also wrap to two lines instead of clipping to one.
- Under the cover, spanning the card, the segmented chapter map with highlight dots, then `N min left in chapter` and the book's percentage on one line. Outside a named chapter the time reads `N min left in book`. The maps sit at the cards' feet, level across a row. Until the source's contents load, a plain track holds the map's place, so the card never grows.

Coverless articles omit the spine tile on Reading cards, leaving that width to their title and creators rather than an empty cover.

On the Reading tab a card's top corner selects it, like a shelf cover. On a phone the checkbox appears only in Select, as on every other tab.

Cards load the source's contents and text length and cancel their requests when removed. If chapter boundaries are unavailable, the map stays one book-length span and the time is labeled for the book, never a guessed chapter.

Clicking a card opens its source page. On the cover screen it opens the reader at the saved position instead, as Today's reading line does, and Open page in the card's actions reaches the source page. It fills the pane to the right when one exists; otherwise it uses the Library's pane. ⌘-click opens it beside (Ctrl-click off Mac), as with rows. A wide touch screen opens it beside by default. Cards wrap into a vertical stack in narrow panes without dropping books.

On the cover, Reading is the first and initial state tab, the cards replace duplicate Reading rows, and the Inbox follows as `Up next · Inbox`. Search and Add sit beside the Library title. Search reveals the search field and the other library controls. No reading-session totals, pace or finish estimates are shown.

### Empty library

A Library with no sources offers Add your first source and a direct Add a source button opening the ordinary ingestion controls, on every tab. Once sources exist, an empty tab states what it lacks (`No abandoned sources yet.`); only Inbox and All, where a new source would appear, also offer Add a source. An empty collection explains how to fill it (select books, then Add to collection) and offers All sources. Empty searches and filters offer Clear search or Clear filters as plain actions aligned with the message's edge.

## Adding sources

### Add to library

Add opens Add to library anchored under its button on desktop and as a bottom sheet on the touch cover layout: one field for a URL, ISBN, DOI or arXiv ID, then Choose file… at the leading edge and Enter details by hand at the trailing edge, each with its glyph. Enter submits; Looking up… shows while it works. A typed query or a started hand-entry form survives a click outside, and Escape or closing the sheet keeps it for the next opening until the source is added; Cancel in the hand-entry form returns to the field. On coarse pointers, Paste appears beside the field when clipboard reading is available. Scan ISBN appears when BarcodeDetector is available, opens the camera photo picker, and looks up an ISBN EAN-13 barcode from the photo; a photo without one reports `No ISBN barcode found in that photo.`.

An identifier lookup previews a catalog card before anything is written:

- The cover and the title in Piazzolla with its subtitle.
- The creators with `(ed.)` and `(trans.)` marks.
- Year, publisher and identifiers as mono apparatus.
- `From Open Library`, `From Crossref` or `From arXiv` in `--faint`.
- Cancel, Edit details and Add.

Edit details opens the details form seeded from the lookup, keeping its cover. Enter details by hand opens it empty and focuses Title. Dropping an EPUB on the Library pane or the Add form does the same as choosing a file.

Dropping a link elsewhere in the window opens the shared Source slip with that link. URI lists ignore comments; plain text must be a whole source identifier. Drops handled by an editor, the outline or Library's own drop zone stay there, and the window handler never takes files.

A manual or looked-up title already in the library shows `“{title}” is already in the library.` below the form, with Open to open that source and dismiss Add. Title matching ignores case and diacritics; when both records have creators, at least one creator must also match. The submit button becomes Add another copy, without preventing the addition.

`AddSourceBody` exports the form without its Popup for embedding. Its optional `initialText` prefills the identifier field and starts the ordinary URL ingestion or identifier lookup when recognized; other text stays editable without submitting. Optional file and job hooks let Library keep its existing ingestion handling; an embedded body can choose and upload files itself.

### Import jobs

Queued and running file or article submissions show a job row above the sources: a state icon, name, state, and any error sentence on a second line aligned with the name. Completed jobs leave once their source exists.

Failed jobs appear only in Inbox, under a heading such as `40 imports failed`. The first two are open, with Retry and Dismiss; the rest sit behind `38 more`, beside Dismiss all. Dismissal uses the existing device preference per workshop, including the batch action; it does not delete the service's jobs. Other registers show no failed backlog.

URL names retain the host and final path identifier (the complete DOI for doi.org), with middle ellipsis for long identifiers, and expose the full URL as their title and accessible name. In narrow panes the identifying name wraps to two lines above the state and actions.

An EPUB creator entry that holds more than one person (`A; B`, `A & B`, or inverted pairs such as `Bowen, William G., Guthrie, Kevin M.`) becomes one creator each. Calibre's unknown date, `0101-01-01`, is no date. Earlier EPUB imports carrying that sentinel in their extracted metadata read as undated in Library rows, Decades, year sorting, exports, the source header and the catalog card; other ancient dates and authored dates are kept, and stored fields are not rewritten. Browse facets skip blank values.

Snapshots are deduplicated by the original file's bytes. Re-adding an unchanged file reuses its stored passages; parser updates do not reprocess existing snapshots, and there is no reprocess action or parser-version migration.

### Manual details

The manual details form remains in Add only: labeled rows, Creator name fields with Author, Editor and Translator tabs, Add creator, and the existing “Same as X?” reuse suggestion. Below 600 px, each creator's name spans the field width, with role tabs and Remove on the next row. Published accepts `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; adding a record saves its fields together. Enter while composing accepts the input candidate without submitting the record.

## Inspector

### Opening and layout

Selecting a source through its leading slot or checkbox opens a 460 px catalog-card inspector to the right of the Library ledger or shelf. The ledger keeps its layout until the card's details are ready; then Browse steps aside and the ledger and its toolbar glide left to make room while the card slides in 12 px from the right edge as it fades in. Closing glides them back. The title still opens the source page. Details is also available in each source's actions and the batch bar. Edit details… on a source page opens the same card beside the page, without leaving it, and the page glides aside the same way.

Changing the selection keeps the current card on screen until the next source's details are loaded, then swaps its content in place. Loading source details… shows only when no card is shown yet and loading takes over 300 ms.

Browse steps aside while inspecting and its named button brings it back. The card's × clears the selection and closes it. Escape closes the card alone, one layer per press: the selection stays and focus returns to its row, and a second Escape clears the selection. An edit that moves a source outside the current Library filter leaves its card open. A selected shelf cover has a 2 px gilt ring.

| Context | Inspector layout |
| --- | --- |
| Below 1000 px, the width needed for the list, its one-line selection bar and the card | Details replaces the list with Back to N sources; returning keeps the query, selection and scroll. |
| Touch cover screen under 600 px | Source actions or a long press opens a 70% bottom sheet with an 85% expanded stop, independent group folds and 44 px targets. The sheet resizes above the keyboard. |

### Catalog groups

The card's groups stay in this order:

| Group | Fields |
| --- | --- |
| Work | Title, Subtitle, Creators with book roles, First published, Original language |
| Edition | Published, Publisher, Edition, Series, Number, Volume, Issue, Page range, Pages, Language |
| Identifiers | Every ISBN, DOI and arXiv value, URL and Site |
| About | Description and Cover |
| Apparatus | Siglum and Citation key |
| Shelf | Reading state, Started, Finished, Tags |

Missing values remain visible as quiet Add… slots. A value becomes an inline editor on click, commits on Enter or blur and cancels on Escape, with no Save or Cancel buttons. Escape cancels the active editor before a later Escape closes the inspector.
Volume and Issue keep journal labels as written. Page range holds a journal's pages or article locator; Pages remains the total page count.

Save state belongs only to the pane header. Saving… appears after a second and invalid fields announce that they were not saved. A blank optional date is not an error; invalid partial dates use `--danger` with their format hint.

- Language uses English names in the app's Picker, including every ISO 639-1 code even when the browser's language-name data omits it. Both names and codes are searchable.
- Description uses Piazzolla, clamped to three lines with More, and becomes editable on click.
- Reset to extracted sits beside a changed snapshot value.
- Fill missing details sits with the identifiers and writes only empty fields.
- Visible fields keeps each page's catalog-card visibility on this device through reloads. It changes presentation only; the source's own fields stay in its field bed.
- Replace cover… and Reset to extracted cover stay in About.
- Apparatus names the derived siglum and its basis, offers Set override… or Use derived, and reports citation-key uniqueness errors inline without saving the conflicting key.

### Creators

Creator links use the holder-link treatment: `--text`, a `--line` underline, and gilt only on hover or focus. Author, Editor and Translator belong to each book.

The person's menu separates Open person, inline Rename person… (with the workshop-wide book count), Merge into… and removal from the current book links.

Move up and Move down in that menu reorder creators within the same role, preserving their links and other roles. With a creator row focused, ⌥↑ and ⌥↓ perform the same moves and keep focus with that creator. Each move uses the inspector's normal save and Undo.

Merge is a short explicit confirmation naming the books and notes that follow, the surviving mark, and the old name that remains as an alias. The existing permanent page-merge command keeps book roles. Add creator offers “Same as X?” without silently treating similarity as identity.

### Multi-selection

Selected sources share one inspector headed N sources selected, with one line saying an entered value replaces the field on all of them unless a source is named; a single source's card carries no instruction line. Shared values show once. Differing values show a distinct-value count with disclosure and source counts, with known values and empty counts kept separate. A mixed value and a per-source register share one control in the field's value column: a hairline row with its summary (`2 values · per source`) at the leading edge and the source count at the trailing edge.

A field editor states that Enter or blur sets every selected source, then offers a counted toast and Undo. Dates, series numbers and differing ordered creator roles remain compact per-source registers, initially folded, so editing a register cell changes only its named source. Mixed titles and citation keys also use named per-source editors, because those values must be unique.

Each committed field across the selection is one revision-checked workshop batch and one undo step, including previously empty fields. No server-side metadata operation or alternate storage is introduced. The document layer's shared source-details planner supplies the same ordinary-field actions for individual edits, Add and multi-page batches.

### Transactions

An inspector transaction is not adopted into document state before acknowledgment. A definitive validation rejection writes nothing and is retired from the shared recovery journal. The attempted value stays in its inline editor until corrected or canceled. An uncertain transport outcome remains durable and retries through the existing idempotent workshop command path.

## Highlights desk

### Queue and passage

Highlights is a processing desk: a reading-order queue and selected passage share the desktop and unfolded pane, with source and chapter pickers in the toolbar rather than a permanent navigator. The tab strip keeps its place from the other tabs; the desk's controls span the desk below it. Until the workshop has a highlight there is no desk, so the controls and the empty message keep the other tabs' measure and offset.

Sources retain newest-highlight order. Each source's passages retain ordinal and selection-offset order, including distinct overlapping selections. Queue previews clamp to three lines, marked by a 2 px color bar, with the actual paragraph, date, note count and filing page in mono. A quotation that supplies its own chapter title does not repeat that title above it.

The detail shows the full frozen quotation, preserves rewritten block prose, and fetches context from the citation's snapshot without moving the reading position. Passage continues starts with the rest of the highlighted paragraph after the selection, then following passages. Filing tags appear once as metadata. Adding a tag alone does not repeat the quotation, here or in the source outline.

Markdown export keeps the frozen evidence, authored highlight text, filing tags and child notes. An unchanged quotation appears once; tags or commentary appended to it follow the evidence without repeating the quotation.

On the cover, tapping a queue row opens a dedicated passage state with Back to highlights, Previous and Next. The scrollable passage sits above an always-visible action dock, clear of the bottom nav.

The phone queue keeps its source heading even when only one source matches.

Color and tag filters open a labeled sheet; No color matches unassigned citations. Color facet counts ignore the selected colors while retaining the other filters, so alternatives stay visible even when the current color has no matches. A chapter scope counts its loaded section rows; a truncated queue names its loaded count. The sheet's footer holds Clear filters and a primary `Show N highlights` that carries the match count. With no highlights in the workshop, Filters and the source and section pickers step aside, leaving Unprocessed and All above the empty message. Color controls and menus use the spelling Color.

### Dock and keys

The selected passage keeps these actions visible in its dock. On a fine pointer their buttons show the hints in the shared sans key style; touch hides them.

On touch, the dock's icon-only secondary actions keep a nonshrinking 44 px target even when the neighboring text needs more room.

| Action | Hint |
| --- | --- |
| Mark processed | E |
| Add atom or Open atom | N |
| Make card | C |
| Tag | T |
| Color | 1–5 |
| Undo | ⌘Z |
| Open in reader | O |

The pager labels show ↑ K and J ↓. The active Highlights pane owns these unmodified keys only outside editable targets and open popups, preserving shell chords and the other pane's keys. J/K and arrows select and focus the neighboring queue row. Home and End retain first and last passage navigation. Digits apply yellow, green, blue, red and purple in [Reader](reader.md) order.

Mark processed advances to the next unprocessed passage in the scoped queue, wrapping when necessary. In All, processed passages offer Mark unprocessed. Undo uses the retained source document's existing history, from the dock or ⌘Z, not a separate triage history or toast.

A non-empty child note, an active card or an incoming reference processes a highlight unless its explicit triage overrides that state. Tags and color only organize it. Note counts exclude card children. Add atom opens the first written prose child or reuses a blank note, never a card. Explicit note editing reveals and activates its destination pane.

Add atom and Open atom deliver the live caret without waiting for saving, catalog metadata or a pane-turn snapshot. Plain typing during opening reaches that caret once. Composition and modifier shortcuts retain their native handling.

The shared highlight menu keeps the quotation, color choices, note and card actions, Copy with citation, triage, tags and removal. Removing a highlight with written descendants or incoming references asks for confirmation and names both counts. Removal still deletes the subtree and keeps Undo. Library adds Open in reader. Hovering a highlight still links it to the reader and source outline in the other pane without scrolling or taking focus.

### Make card

Make card opens the [card composer](cards-review.md#card-composer) with the quotation in Back and the source title and paragraph in its rubric line. It hangs from the focused highlight row, or opens near the top of the viewport from a menu. It creates no empty syntax block and shows no initial invalid-state warning. Cancel leaves no card behind. Create makes one child locally and opens its editor before acknowledgment; Create another adds the child without opening it and keeps the quotation for the next card. The form stays busy until delivery settles, preventing duplicate submission and keeping errors in the draft.

Typing during opening, including Backspace corrections, reaches its caret once even when acknowledgment is slow.

### Empty queues

When processing empties the scoped queue, Undo stays in the Highlights toolbar so the final action still has a visible route back.

| State | Message |
| --- | --- |
| Workshop with no highlights | "Select text in the reader to add highlights." |
| Empty Unprocessed queue in a workshop that still has highlights | "No unprocessed highlights." |
| Empty color or tag filter | "No highlights match these filters." |

Empty results and their controls stay on the page measure rather than reserving the two-column workbench width.

## Source pages

### Header and reading progress

A source page puts the current snapshot's cover beside its title, with creators joined by ` · ` followed by one mono imprint line: siglum, format, publisher and year, omitting absent values. The cover opens the reader.

In panes below 600 px, coverless articles omit the empty spine tile and give the title and imprint the whole width. Books and articles with real covers keep the cover rail; Read remains available in the reading controls.

Below it, the current chapter (`Not started` before any reading, `Reading position` in front matter), chapter map, time left in a named chapter and `book % · time left` share the [reader's](reader.md) character-based progress.

Each highlight in the current snapshot is a dot in its color at its exact position. The server gives every citation its start as a character offset in the snapshot's text, the same unit as the contents starts, so the source page, the Library card, Today and the reader place dots identically.

The primary gilt Read button becomes Continue reading once a saved position exists, with the state menu and source actions beside it. The pane header's Read tab opens the book the same way. On the cover those controls are pinned above the bottom nav, within thumb reach. A record source has no snapshot, and its Read tab shows the Read projection instead.

### Source actions and fields

Source actions is titled `Source actions`, with the source title in mono beneath it. Six routine rows keep longer choices in drill-ins:

| Menu | Items |
| --- | --- |
| Source actions | Edit details…, Copy citation key, Collections…, Export…, Source settings…, Delete source… last |
| Collections | Add to collection…, Remove from each collection |
| Export | BibTeX, CSL JSON, Markdown |
| Source settings | Fill missing details, Replace cover…, Show or Hide metadata fields, Reset to extracted when values differ, Snapshots… |
| Snapshots | Each snapshot's date and passage count, opening its reader |

Drill-ins replace rows in the same popup and offer a header Back, including Snapshots inside Source settings. Hairlines separate the root groups and the final danger action. Below 600 px with a coarse pointer, the menu is a bottom sheet with 44 px rows and an explicit Close on its root; desktop stays anchored.

Fill missing details is a fresh lookup that writes only empty fields; without an identifier it stays in the menu, disabled with No identifier.

Edit details… keeps the source page open and shows the Library's 460 px catalog card beside it. While the card is open the page column takes the remaining width, down to 540 px; a narrower pane shows the card as a bottom sheet. × or Escape closes it, the card fades out where it stands while the page glides back, focus returns to the control that opened it, and edits update the header at once.

The remaining page column keeps field labels, block controls and highlight chapter headings inside its inset, rather than hanging their gutter outside the pane.

The header and catalog card own the catalog fields: Subtitle, creators, dates, publisher, edition, series, number, volume, issue, page range, pages, languages, identifiers, URL, site, description, cover, siglum, reading dates and Collections. Their entries stay out of the outline until Show metadata fields, and the page offers no slots for them; Add field neither lists nor creates them there. Every other field is the note's own and shows in the [field area](../design.md#field-area) under the header, with its slots and Add field, like any page. The snapshot's description is clamped to three lines with More. The page has no Table button; ⌘⇧T and the palette still open the table.

Show and Hide metadata fields are saved with the pane's view across reloads and history. A remembered caret in the note's own fields does not reveal catalog fields.

A record source's Read projection keeps those catalog fields in the source card, even when Outline's metadata fields are shown. The note's own fields retain their labels and text edge.

Author, Editor and Translator values may be plain names or linked people. Plain names supply the same Library bylines, creator facets, exports and derived sigla without creating a person page.
Imports can keep any creator as a plain name with `create_page: false`; the default still creates or links an entity. Organization creators become Groups, and combined bylines stay plain rather than becoming one Person. Edit details preserves plain names when other metadata changes.

Creator kinds use an explicit `kind` first, then the source's structured signals, otherwise Person. Crossref's `name` without `given` or `family` denotes an organization; split personal names denote a person. Schema.org `Organization` and `Person` types in JSON-LD or HTML microdata supply the kind, and `givenName` or `familyName` supplies Person when no type is present. A structured kind also takes precedence over a duplicate plain byline. No name-pattern guessing is used.

Open Library's ISBN author names, arXiv author names, ordinary web bylines, `author` and `citation_author` meta values, and EPUB `dc:creator` strings provide no person-or-organization signal, so they retain the Person default. A native record-plan creator with only `name` and `role` does too; use `kind: organisation` for a known collective or `create_page: false` to keep it as a plain name.

An unresolved title-form creator reference reads as its written name, not as an ID or a guessed link to a same-titled source. Only canonical references enable creator navigation. A title-form reference keeps its link intent when its role or other metadata changes, while a bare plain name stays plain. Saving creator names matches eligible people and groups by title or alias; shared names remain unlinked.

The pane header reads Library / title. Library opens the Library pane. ⌘-click opens it beside (Ctrl-click off Mac). Zoomed into a block, Library gives way to the zoom path.

Shown metadata fields use the ordinary field rows. Languages show their English name and identifiers their scheme (`ISBN 978…`) until edited. A value that differs from what the current snapshot extracted offers Reset to extracted in its field menu.

### Source highlights

Highlights has its live total, individually spaced color filters using the highlight tokens, including a No color chip for unassigned citations, then a separated By chapter control which can switch to Reading order.

Highlights follow reading order with their notes beneath. Each chapter heading carries its title and matching count. A 2 px color bar marks the left edge of each full-width quote, with its paragraph number at the right in mono and no trailing color dot.

Highlights filed on other pages remain under Filed elsewhere and respect the same color filters. Recent shows a book or article icon for source pages.

### Citation masthead

Zooming into a source annotation uses a compact citation masthead: imprint, creators and Open source, without the cover, reading progress or Continue reading. The unzoomed source landing keeps its full header.

## Sigla

### Derivation

Every source has a siglum, a short mark as in a critical edition. An authored `Siglum::` field wins when its trimmed value is one to four letters, upper-cased. Empty, longer or non-letter values are ignored.

Otherwise it is the first three letters of the first author's family name (else editor, site, then the title's first word containing letters), upper-cased with Unicode letters kept and non-letters skipped. Shorter names use what they have. Sigla and collision hints are computed from the current fields, not stored assignments, so editing the author changes the stem and existing workshops need no migration.

The source header includes it as a bare mono mark in its one-line imprint, never boxed, and CSL JSON exports it as `citation-label`.

### Placement and collisions

On any other page, a row that cites a passage or references a source page with an authored label or locator hangs that source's siglum right-aligned in the left gutter, boxed in `--control-border`, gilt when the row is selected or its highlight is hovered in the reader. Citation references share passage citations' first-appearance and collision rules. Their hover preview is headed by the source's siglum and, when present, ` · locator`, above the source title.

Sigla are assigned per page in order of first appearance. The first source keeps its bare stem. A later author-derived collision keeps that stem and appends the publication year's last two digits when no earlier collider shares them, else the lowercase initial of the first significant title word when no earlier collider shares it, else the first unused ordinal starting at 2 (`MAT`, `MAT19`, `MATe`, `MAT2`). Significant title words use the citation key's stop-word list, skipping articles and short connecting words. Each candidate also avoids marks already assigned on the page. Only earlier sources affect the choice, so adding a later source never renames existing marks. Sources without an author retain the editor/site/title basis-extension rule, then numbered suffixes when that basis runs out. Authored sigla never change.

The Library list, shelf and source sheet show each source's own siglum without that disambiguation, because the title beside it already tells the books apart; four Rowling books all read `ROW`.

Margin, header, apparatus and Compare marks stay on one line, with boxes sized for five mono letters and room to grow for longer ordinals. Wide outlines retain the critical-edition margin. When the outline's content column is at most 856 px wide, the marks form a compact wrapping line immediately before their cited row instead of reserving a left rail for every paragraph. Prose and standfirst sentences keep the title's edge in both split panes and phones.

## Citation chips

A block with a citation shows a citation chip in its capability metadata:

- The highlight's color dot, a hollow ring without color, as in the Library and the reader.
- The source's short title, before any subtitle colon, cut at a word within 40 characters.
- The passage number, `¶231`.

On the source's own page the chip shows only `¶231` in `--faint` and stays at the end of the block's first line, the text wrapping beside it. Clicking opens the reader at that passage. ⌘-click opens it beside (Ctrl-click off Mac).

A block whose text no longer equals the quote shows the quote beneath it in `--muted` with a quotation rule, so a paraphrase or cloze keeps its evidence visible.

## Collections

### Cards and membership

Collections lives in the Library's More menu. Each card previews up to four member covers in a flat two-by-two grid above the page name and a mono count. Placeholder covers show only the siglum. New collection creates an ordinary page typed Collection.

The first collection adds a Collections Instance field that links to the Collection type, and appends it to the Book and Article templates that exist. A later collection adds it to library types imported since. Membership lives in that field's reference values, so the collection page's backlinks list its sources and ordinary sync carries every edit.

### Collection actions

A collection opens the same sorted rows or shelf as All, filtered by its page ID on the service. Its heading offers Open atom, Rename and Delete.

Multi-selection and source actions offer Add to collection, with a new-collection row in the picker. The metadata form lists the source's collections with add and remove controls. Inside a collection, selected sources can be removed without deleting them. Touch selection stays visible and reveals the bulk controls.

Each action is one revision-checked document commit with a quiet Undo notice, shown once beside the collection chips. The notice rises into place and leaves after 10 seconds unless the pointer or focus is on it or its Undo is running; errors stay until the next action. A chip added on a source page arrives with a gilt border that fades to the hairline, while chips already present do not move. Deletion clears membership values in that same commit and leaves the books intact.

### Saved queries

These are hand-curated collections. A future smart collection can attach a saved library query to the same page, using a SaveLibraryView record keyed by the collection page ID. It need not replace the page or the manual membership field. No saved-query membership is evaluated yet.
