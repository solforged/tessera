# Library and sources

Library is a pane for sources, reading and highlight processing. Source pages retain catalogue details, reading progress and passage evidence.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Library pane

### Header and tabs

The header starts with Reading, Inbox and Highlights with its unprocessed count, then All, Collections, Finished, Abandoned and saved views. Zero counts are left out. The selected tab's 2 px gilt rule spans its label and count on the strip's baseline. The last tab is remembered per notebook.

Under the tabs sit a 28 px search field, a sort menu (Added, Title, Author, Year, Last read, Progress, then Group and Save view…), the List and Shelf toggles, Browse, an Export menu (BibTeX, CSL JSON, Markdown) for the selection or the listed sources, and Add. Every tab keeps this row at one height and the same controls, Browse disabled where the tab has nothing to browse; Collections puts its heading and New collection in the same row. On wide panes the tab strip and the list keep the Browse rail's offset on every tab, so switching tabs never moves them sideways.

Searching, filtering and sorting keep the current rows on screen until the new ones arrive and swap them in one step. Loading… appears only when nothing of that kind is loaded and the load takes over 300 ms.

| Context | Header behaviour |
| --- | --- |
| State and saved-view tabs | Names stay on one line. |
| Narrow desktop pane | The strip scrolls horizontally instead of making the toolbar taller. |
| Half pane | Controls wrap under a full-width search field. |
| Phone | Reading, Inbox and Highlights remain visible. More contains All, Collections, Finished, Abandoned and saved views; its label preserves the selected secondary view. Reading and Inbox counts give way before the Highlights count. |

### List

Rows read as a ledger on one 28 px line:

- A leading slot holds a book or article glyph in `--faint`. A 28 px row cannot show a cover legibly, so covers appear in the Shelf, Reading now and the phone ledger's taller rows.
- The siglum is a mono shelfmark in `--faint` that turns gilt on hover.
- The title precedes the byline in `--muted` (creators, else site). The byline truncates before the title.
- Trailing fixed-width mono columns show year, progress and the unprocessed highlight count, so figures line up across rows.

Progress pairs a short gilt bar with its percentage. A Reading source at zero reads `Not started`; Inbox and Abandoned sources leave the column blank rather than repeat it on every row. A finished source shows `Finished` with its state-change date when recorded, never a percentage. All and saved views spanning several states add a state column (`Inbox`, `Reading`, `Finished`, `Abandoned`) in `--faint` before the year.

In a pane narrower than 560 px on a wide screen, the state and year columns step aside and progress keeps only its number, so the title keeps its room.

The leading slot shows a selection checkbox on hover, focus, or while any row is selected. A selected row takes `--selection` and the accent bar. While rows are selected, a bar of the same height replaces the search line: the count, Details, Browse, Mark as (one batch for all of them), Export, Add to collection…, Delete and Clear selection. Escape clears.

Clicking a row opens the source page; Shift opens it beside. On a wide touch screen, opening a book uses the other pane so the list and detail stay across the hinge. The opened book keeps a quiet current-page marker.

A row menu offers Read or Continue reading, Mark as reading, finished or abandoned, Return to inbox, Export and Delete….

Delete asks once for all the chosen sources, removes their pages and highlights, moves any pane showing or reading one to another page, and offers Undo in the toast (`2 sources deleted`). Undo puts them back in the list without leaving the Library. Delete source… on a source page works the same, and its undo reopens the page.

### List and shelf

Two icon toggles beside the sort menu, List (ledger rows) and Shelf (covers), choose how sources show. The choice is a device preference per notebook. Icons keep the controls on one line on a phone, where the sort button leaves out its grouping and Export shows only its glyph.

The shelf is a grid of 2:3 covers at least `--shelf-cover-width` wide, sharing any spare width, at the list's measure. Under each cover sit:

- The reader's 2 px position rule, with its `--line` track only once reading has started.
- The title in Piazzolla on up to two lines.
- The byline in `--muted`.
- One mono apparatus line in `--faint`: siglum (gilt on hover), state in views spanning states, year, progress (none once finished) and the unprocessed highlight count.

A source without a cover gets a typeset spine on `--surface`: the gilt siglum over a short rule and the title, centred clear of the corners.

The selection checkbox and the actions button sit on the cover's top corners and appear as in the list. A selected cover takes a 2 px accent ring.

On touch the actions button is an always-visible surface disc. Below 600 px it opens the existing source actions in a sheet above navigation, headed by the title, author and mono imprint and progress. Reading and state actions, exports and deletion are separated by rules. Delete still asks for confirmation.

Arrow keys move one book sideways and to the nearest cover in the next row up or down, across group headings. Home and End go to the ends.

### Group

The sort menu has a second section, Group: None, Author, Decade, Publisher or Language. A source sits in one group.

| Group | Basis | Group order | Missing value, placed last |
| --- | --- | --- | --- |
| Author | First author, else editor | A–Z by family name | `No author` |
| Decade | Publication decade | Newest first | `Undated` |
| Publisher | Publisher | A–Z | `No publisher` |
| Language | Language | A–Z | `No language` |

Rows keep the chosen sort within each group, and Shift-click ranges follow the grouped order. Each group opens with a sticky heading on `--canvas`: its name in Piazzolla and a mono count. An author's name opens their page. In the shelf the heading spans the grid. The sort button then reads `Added · by decade`. Grouping belongs to the pane, not to saved views.

### Browse

Browse narrows the sources by People, Decades, Publishers and Languages. The service counts each value over the current tab and search, ignoring the Browse filters themselves, so every value the tab offers stays visible.

Values combine with OR inside a field and AND across fields. People match as author, editor or translator, by page, so a renamed person keeps their filter. Languages count by primary code, so `en`, `en-US`, `eng` and case-insensitive English language names such as `English` are one English. Imports resolve ISO language names to codes; existing catalogue fields are normalized when read, without rewriting their authored text.

| Pane width | Browse presentation |
| --- | --- |
| At least 1096 px | A 240 px rail left of the measure, the two centred together. It shows each field's six commonest values with their counts, chosen values pressed, and `All N` opening the rest in a picker. |
| Narrower | A Browse glyph beside the layout toggles, pressed while any filter applies. It opens one sectioned picker. |

Chosen values also show as removable chips under the controls with Clear filters. Continue reading steps aside while Browse filters apply. Filters travel with the query, so saved views and Export of the listed sources keep them.

### Person page works

A person's page lists their works above the related sections: `Works N` in the faint label, then a grid of 72 px covers (`--work-cover-width`). Each has the title on up to two lines and one mono line of year, Editor or Translator when that is their role, and the reading state or progress. Undated works follow the dated ones, oldest first.

The creator field values those works hold are left out of Backlinks, and the person's hover card counts `N works` before its readings and references.

The Works heading and shelf share the page title's left edge. Works and its count sit in mono on either side of a hairline rule.

### Reading now

Reading now leads the unsearched, unfiltered Reading and All tabs with one card for every Reading source, including books not yet started, most recently read first. Other tabs list only their own state. On the Reading tab the cards replace the rows, which would repeat them; a search, filter or saved view brings the rows back. Each card reads top-down:

- Its real cover or spine tile beside the title on up to two lines, the author and the current chapter (`4 · Deus Vult!`; `Not started` before any reading, `Reading position` in front matter).
- Under the cover, spanning the card, the segmented chapter map, then `N min left` inside a named chapter (the full `N min left in chapter` on hover) and the book's percentage on one line. The maps sit at the cards' feet, level across a row.

On the Reading tab a card's top corner selects it, like a shelf cover.

Cards load the source's contents and text length and cancel their requests when removed. If chapter boundaries are unavailable, the map stays one book-length span and the time is labelled for the book, never a guessed chapter.

Clicking a card opens its source page; Shift, or a wide touch screen, opens it beside. Cards wrap into a vertical stack in narrow panes without dropping books.

On the cover, Reading is the first and initial state tab, the cards replace duplicate Reading rows, and the Inbox follows as `Up next · Inbox`. Search and Add sit beside the Library title. Search reveals the search field and the other library controls. No reading-session totals, pace or finish estimates are shown.

### Empty library

A Library with no sources offers Add your first source and a direct Add a source button opening the ordinary ingestion controls. Empty searches, filters and collections retain their contextual guidance instead.

## Adding sources

### Add to library

Add opens Add to library anchored under its button: one field for a URL, ISBN, DOI or arXiv ID, then Choose file… at the leading edge and Enter details by hand at the trailing edge, each with its glyph. Enter submits; Looking up… shows while it works.

An identifier lookup previews a catalogue card before anything is written:

- The cover and the title in Piazzolla with its subtitle.
- The creators with `(ed.)` and `(trans.)` marks.
- Year, publisher and identifiers as mono apparatus.
- `From Open Library`, `From Crossref` or `From arXiv` in `--faint`.
- Cancel, Edit details and Add.

Edit details opens the details form seeded from the lookup, keeping its cover. Enter details by hand opens it empty, in the same popup. Dropping an EPUB on the Library pane or the popup does the same as choosing a file.

### Import jobs

Each file or article submission becomes a job row above the sources while queued, running or failed: a state icon, the name without its extension, the state, and the error sentence on a second line aligned with the name. Failures offer Retry and Dismiss.

The name truncates first, so state and actions stay on the first line in a narrow pane. Dismissal is a device preference per notebook. Finished jobs leave the list once their source exists, whichever tab lists it, so a large import never stacks rows above another tab's sources. The Highlights tab shows no jobs.

An EPUB creator entry that holds several people (`A; B`, `A & B`, or inverted pairs such as `Bowen, William G., Guthrie, Kevin M.`) becomes one creator each. Calibre's unknown date, `0101-01-01`, is no date. Earlier EPUB imports carrying that sentinel in their extracted metadata read as undated in Library rows, Decades, year sorting and exports; other ancient dates and authored dates are kept, and stored fields are not rewritten.

### Manual details

The manual details form remains in Add only: labelled rows, Creator name fields with Author, Editor and Translator tabs, Add creator, and the existing “Same as X?” reuse suggestion. Published accepts `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; adding a record saves its fields together.

## Inspector

### Opening and layout

Selecting a source through its leading slot or checkbox opens a 460 px catalogue-card inspector to the right of the Library ledger or shelf. The title still opens the source page. Details is also available in each source's actions and the batch bar. Edit details… on a source page opens this same Library inspector, not a second popup editor.

Browse steps aside while inspecting and its named button brings it back. Closing details clears selection. An edit that moves a source outside the current Library filter leaves its card open. A selected shelf cover has a 2 px gilt ring.

| Context | Inspector layout |
| --- | --- |
| Below the width needed for the list and card | Details replaces the list with Back to N sources; returning keeps the query, selection and scroll. |
| Touch cover screen under 600 px | Source actions or a long press opens a 70% bottom sheet with an 85% expanded stop, independent group folds and 44 px targets. The sheet resizes above the keyboard. |

### Catalogue groups

The card's groups stay in this order:

| Group | Fields |
| --- | --- |
| Work | Title, Subtitle, Creators with book roles, First published, Original language |
| Edition | Published, Publisher, Edition, Series, Number, Pages, Language |
| Identifiers | Every ISBN, DOI and arXiv value, URL and Site |
| About | Description and Cover |
| Apparatus | Siglum and Citation key |
| Shelf | Reading state, Started, Finished, Tags |

Missing values remain visible as quiet Add… slots. A value becomes an inline editor on click, commits on Enter or blur and cancels on Escape, with no Save or Cancel buttons.

Save state belongs only to the pane header. Saving… appears after a second and invalid fields announce that they were not saved. A blank optional date is not an error; invalid partial dates use `--danger` with their format hint.

- Language uses English names in the app's Picker.
- Description uses Piazzolla, clamped to three lines with More, and becomes editable on click.
- Reset to extracted sits beside a changed snapshot value.
- Fill missing details sits with the identifiers and writes only empty fields.
- Replace cover… and Reset to extracted cover stay in About.
- Apparatus names the derived siglum and its basis, offers Set override… or Use derived, and reports citation-key uniqueness errors inline without saving the conflicting key.

### Creators

Creator links use the holder-link treatment: `--text`, a `--line` underline, and gilt only on hover or focus. Author, Editor and Translator belong to each book.

The person's menu separates Open person, inline Rename person… (with the notebook-wide book count), Merge into… and removal from the current book links.

Merge is a short explicit confirmation naming the books and notes that follow, the surviving mark, and the old name that remains as an alias. The existing permanent page-merge command keeps book roles. Add creator offers “Same as X?” without silently treating similarity as identity.

### Multi-selection

Several selected sources share one inspector headed N sources selected, with one line saying an entered value replaces the field on all of them unless a source is named; a single source's card carries no instruction line. Shared values show once. Differing values show a distinct-value count with disclosure and source counts, with known values and empty counts kept separate. A mixed value and a per-source register share one control in the field's value column: a hairline row with its summary (`2 values · per source`) at the leading edge and the source count at the trailing edge.

A field editor states that Enter or blur sets every selected source, then offers a counted toast and Undo. Dates, series numbers and differing ordered creator roles remain compact per-source registers, initially folded, so editing a register cell changes only its named source. Mixed titles and citation keys also use named per-source editors, because those values must be unique.

Each committed field across the selection is one revision-checked notebook batch and one undo step, including previously empty fields. No server-side metadata operation or alternate storage is introduced. The document layer's shared source-details planner supplies the same ordinary-field actions for individual edits, Add and multi-page batches.

### Transactions

An inspector transaction is not adopted into document state before acknowledgement. A definitive validation rejection writes nothing and is retired from the shared recovery journal. The attempted value stays in its inline editor until corrected or cancelled. An uncertain transport outcome remains durable and retries through the existing idempotent notebook command path.

## Highlights desk

### Queue and passage

Highlights is a processing desk: a reading-order queue and selected passage share the desktop and unfolded pane, with source and chapter pickers in the toolbar rather than a permanent navigator. The tab strip keeps its place from the other tabs; the desk's controls span the desk below it.

Sources retain newest-highlight order. Each source's passages retain ordinal and selection-offset order, including distinct overlapping selections. Queue previews clamp to three lines, marked by a 2 px colour bar, with the actual paragraph, date, note count and filing page in mono. A quotation that supplies its own chapter title does not repeat that title above it.

The detail shows the full frozen quotation, preserves rewritten block text, and fetches the following passage from the citation's snapshot without moving the reading position.

On the cover, tapping a queue row opens a dedicated passage state with Back to highlights, Previous and Next. The scrollable passage sits above an always-visible action dock, clear of the bottom nav.

Colour and tag filters open a labelled sheet; No colour matches unassigned citations. Colour counts appear only for the loaded, unfiltered rows, never as whole-notebook facets, and a truncated queue names its loaded count.

### Dock and keys

The selected passage keeps these actions visible in its dock. On a fine pointer their buttons show the hints in the shared sans key style; touch hides them.

| Action | Hint |
| --- | --- |
| Mark processed | E |
| Add note or Open note | N |
| Make card | C |
| Tag | T |
| Colour | 1–5 |
| Undo | ⌘Z |
| Open in reader | O |

The pager labels show ↑ K and J ↓. The active Highlights pane owns these unmodified keys only outside editable targets and open popups, preserving shell chords and the other pane's keys. J/K and arrows select and focus the neighbouring queue row. Home and End retain first and last passage navigation. Digits apply yellow, green, blue, red and purple in [Reader](reader.md) order.

Mark processed advances to the next unprocessed passage in the scoped queue, wrapping when necessary. In All, processed passages offer Mark unprocessed. Undo uses the retained source document's existing history, from the dock or ⌘Z, not a separate triage history or toast.

A non-empty child note, an active card or an incoming reference processes a highlight unless its explicit triage overrides that state. Tags and colour only organise it. Add note opens the first written child or reuses a blank note.

The shared highlight menu keeps the quotation, colour choices, note and card actions, Copy with citation, triage, tags and removal. Library adds Open in reader. Hovering a highlight still links it to the reader and source outline in the other pane without scrolling or taking focus.

### Make card

Make card opens a deliberate front/back draft with the quotation in Back and source context above it. It creates no empty syntax block and shows no initial invalid-state warning. Cancel leaves no card behind. Successful delivery creates one child under the highlight and opens its refreshed outline. Unresolved delivery keeps the form busy rather than permitting duplicate insertion.

### Empty queues

When processing empties the scoped queue, Undo stays in the Highlights toolbar so the final action still has a visible route back.

| State | Message |
| --- | --- |
| Notebook with no highlights | "Select text in the reader to add highlights." |
| Empty Unprocessed queue in a notebook that still has highlights | "No unprocessed highlights." |

## Source pages

### Header and reading progress

A source page puts the current snapshot's cover beside its title, with author chips followed by one mono imprint line: siglum, format, publisher and year, omitting absent values. The cover opens the reader.

Below it, the current chapter (`Not started` before any reading, `Reading position` in front matter), chapter map, time left in a named chapter and `book % · time left` share the [reader's](reader.md) character-based progress.

Each highlight in the current snapshot is a dot in its colour at its exact position. The server gives every citation its start as a character offset in the snapshot's text, the same unit as the contents starts, so the source page, the Library card, Today and the reader place dots identically.

The primary gilt Read button becomes Continue reading once a saved position exists, with the state menu and source actions beside it. On the cover those controls are pinned above the bottom nav, within thumb reach. A record source has no snapshot and no Read.

### Source actions and metadata

Source actions retain:

- Copy citation key.
- Edit details….
- Replace cover….
- Fill missing details when the source has an identifier: a fresh lookup that writes only empty fields.
- Export BibTeX, Export CSL JSON and Export Markdown.
- Snapshots and Delete source….

They add Show metadata fields to expose the original editable field rows; Hide metadata fields folds them again. The snapshot's description is clamped to three lines with More. It has no Table button; ⌘⇧T and the palette still open the table.

Author, Editor and Translator values may be plain names or linked people. Plain names supply the same Library bylines, creator facets, exports and derived sigla without creating a person page.

The pane header reads Library / title, and Library opens the Library pane (Shift beside). Zoomed into a block, Library gives way to the zoom path.

The expanded details group uses control size, labels in `--muted`, and field icons only on hover. Languages show their English name and identifiers their scheme (`ISBN 978…`) until edited. A value that differs from what the current snapshot extracted offers Reset to extracted in its field menu.

### Source highlights

Highlights has its live total, individually spaced colour filters using the highlight tokens, then a separated By chapter control which can switch to Reading order.

Highlights follow reading order with their notes beneath. Each chapter heading carries its title and matching count. A 2 px colour bar marks the left edge of each full-width quote, with its paragraph number at the right in mono and no trailing colour dot.

Highlights filed on other pages remain under Filed elsewhere and respect the same colour filters. Recent shows a book or article icon for source pages.

### Citation masthead

Zooming into a source annotation uses a compact citation masthead: imprint, creators and Open source, without the cover, reading progress or Continue reading. The unzoomed source landing keeps its full header.

## Sigla

### Derivation

Every source has a siglum, a short mark as in a critical edition. An authored `Siglum::` field wins when its trimmed value is one to four letters, upper-cased. Empty, longer or non-letter values are ignored.

Otherwise it is the first three letters of the first author's family name (else editor, site, then the title's first word containing letters), upper-cased with Unicode letters kept and non-letters skipped. Shorter names use what they have. It is read from the current fields so editing the author changes it.

The source header includes it as a bare mono mark in its one-line imprint, never boxed, and CSL JSON exports it as `citation-label`.

### Placement and collisions

On any other page, a row that cites a passage hangs its source's siglum right-aligned in the left gutter, boxed in `--control-border`, gilt when the row is selected or its highlight is hovered in the reader.

Sigla are assigned per page in order of first appearance. The later derived mark in a collision takes further letters of its basis name (`THO`, then `THOM`, `THOMA`), or adds `2`, `3`, … after the basis runs out. Authored sigla never change.

The Library list, shelf and source sheet show each source's own siglum without that disambiguation, because the title beside it already tells the books apart; four Rowling books all read `ROW`.

Margin, header, apparatus and Compare marks stay on one line, with boxes sized for four mono letters and room to grow. A page that shows sigla widens its outline body's left edge by `--siglum-width` plus 8 px, so a four-letter mark is never clipped in a narrow pane. The title keeps the shared inset.

## Citation chips

A block with a citation shows a citation chip in its capability metadata:

- The highlight's colour dot, a hollow ring without colour, as in the Library and the reader.
- The source's short title, before any subtitle colon, cut at a word within 40 characters.
- The passage number, `¶231`.

On the source's own page the chip shows only `¶231` in `--faint` and stays at the end of the block's first line, the text wrapping beside it. Clicking opens the reader at that passage; Shift opens it beside.

A block whose text no longer equals the quote shows the quote beneath it in `--muted` with a quotation rule, so a paraphrase or cloze keeps its evidence visible.

## Collections

### Cards and membership

Collections follows All in the Library's mode tabs. Each card fans up to three member covers above the page name and a mono count. New collection creates an ordinary page typed Collection.

The first collection adds a Collections Instance field that links to the Collection type, and appends it to the Book and Article templates that exist. A later collection adds it to library types imported since. Membership lives in that field's reference values, so the collection page's backlinks list its sources and ordinary sync carries every edit.

### Collection actions

A collection opens the same sorted rows or shelf as All, filtered by its page ID on the service. Its heading offers Open page, Rename and Delete.

Multi-selection and source actions offer Add to collection, with a new-collection row in the picker. The metadata form lists the source's collections with add and remove controls. Inside a collection, selected sources can be removed without deleting them. Touch selection stays visible and reveals the bulk controls.

Each action is one revision-checked document commit with a quiet Undo notice. Deletion clears membership values in that same commit and leaves the books intact.

### Saved queries

These are hand-curated collections. A future smart collection can attach a saved library query to the same page, using a SaveLibraryView record keyed by the collection page ID. It need not replace the page or the manual membership field. No saved-query membership is evaluated yet.
