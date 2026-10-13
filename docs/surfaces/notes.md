# Notes

A note is a titled page; the [domain model](../domain-model.md#notes) defines its kinds.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Index

Index is a sidebar section after Pinned. Its count is the distinct notes filed, left out at zero. It reads as a finding aid: kinds sit on shelves under small mono capital heads, in this order:

| Shelf | Kinds |
| --- | --- |
| Notes | People, Groups, Concepts and Theses (types with those titles), then Questions (a capability on the page). |
| Sources | Sources (a capability), Book, Article and Collection, and any other type most of whose notes are sources. |
| Work | Projects (a capability), and any other type most of whose notes are projects. |
| Tags | Every other type you made, including types that only tag blocks. |
| Loose | Unfiled. |

The service assigns each kind its shelf, so a type moves shelf only when most of its notes change capability. Saved spreads follow under their own Spreads head. A shelf with no listed kinds leaves out its head.

Rows stay on one line: the kind's glyph in `--faint`, the plural at control size, and a bare mono count right.

| Kind | Count and appearance |
| --- | --- |
| Note kind | Titled notes. |
| Questions | Visible question blocks, including inline questions. |
| Tag-only type | Tagged blocks. |
| Empty built-in kind | Folded into one faint mono line after the shelves, `Empty: Groups · Theses · Questions`. Each name opens its finding aid, so the vocabulary stays visible without a row each. |

An empty built-in kind that has a saved view keeps its row, named in `--faint` without a count. Each other type and Unfiled are listed only while they have titled notes or tagged non-page blocks. Note counts and the distinct-note total never include tagged blocks.

The Index heading opens a bounded directory in the same order, with explicit note, source or `N tagged` counts. Tag-only rows open their [member table](fields-tables.md#tables-and-views) directly; other kinds open their finding aid. A saved view sits under the kind whose type it lists, on a hairline elbow and without its table glyph. The section refreshes with the desk counts and disappears rather than go stale when its request fails.

## Finding aid

A kind opens with rubric `INDEX`, its plural in Piazzolla and a mono note tally. A type's Index, Table and Fields modes share the ruled tab strip with live counts. Fields opens [that type's template](fields-tables.md#type-fields-tab), not the global register.

Titles sit under rubric letters with a hairline and a distinct-note count:

| Pane width | Columns |
| --- | --- |
| 840 px or wider | Three. |
| Below 840 px | Two. |
| Below 600 px | One. |

Each note shows two lines of its first populated standfirst field, else its first non-field prose block, then one populated template field and the live descendant-block count in mono. The Collections finding aid instead shows its member-source count in mono, using the same Library collection query as the collection cards. A title without prose has no empty preview. The batched index read derives ordinary note apparatus from existing data, including field entries, values and headings in block counts.

Only populated jump letters appear, and only with Letter grouping. On the touch cover they sit above bottom navigation, with the selected letter on the shared gilt tab rule and compact inline initials in the list. Sort as, diacritic folding, `#` last and alias cross-references retain their filing rules. A title opens its note; a coarse pointer at least 900 px wide opens it beside.

Below the mode tabs, `Find in Concepts…` (using the kind's plural) matches plain words against title or Gloss. `links:`, `from:` and `cites:` resolve titles and aliases; `cites:` also resolves source sigla and citation keys. Quote a multiword value, for example `links:"Three generations of a dynasty"`. Names complete after the colon. Enter, a closing quote or leaving the input resolves each term to a removable table-style chip; unresolved names show `No note named “X”`. All terms and field filters intersect. `cites:` includes passage citations of any of the source's snapshots and any reference to its source page.

Group offers Letter, Source cited, Note linked, Created month, then the kind's populated fields. A note appears under every applicable heading. Source, link and field-value headings sort by descending distinct-note count, then name; None is last. Source headings show siglum then title, and link headings open their note. Created month is newest first. Both layout tabs count the current query, including a saved view's members, rather than all members of the kind.

Save as view… keeps the query, layout and grouping in the existing view store. Saved views sit under their kind, including capability kinds, and reopening restores chips and grouping. Older table views remain Table with Letter grouping when opened as an index. Index and Table retain the same query on switching.

If a saved finding aid names a detached or deleted field, it shows the remembered name and offers Remove from view. Results pause until that reference is removed or the field change is undone. The action saves the repaired query, without discarding other filters or presentation choices.

Index rows reveal a checkbox on hover or focus. Cmd/Ctrl-click toggles a note; Shift-click extends from the selection anchor. The bar shows `N selected` and Clear, plus Spread when the shell provides it. Spread accepts two to five notes and Shift opens it beside. Selection counts distinct notes even when a note occurs under several headings.

`is:resolved` filters `@resolved` to true. `revisit:due` filters `@revisit` through today in the notebook's time zone; `revisit:set` and `revisit:none` select set and empty dates. Question notes use their question's revisit date. These predicates share the query's field filters and remain live when saved. State grouping in the finding aid's Group menu is not implemented.

Their chips use the same attribute labels as entity views: Resolved and Revisit on or before today. Raw query keys stay out of the finding aid.

### Questions ledger

Questions opens a ledger rather than the alphabetical finding aid. Its ruled tabs are Active, Recurrent, Due, Answered, Parked and All. Active includes questions that are active or recurrent; Due selects non-parked questions whose revisit date has arrived. Each tab reads the same state filter from `/api/questions`.

Questions are grouped by their top-level program, with branches below it. Inline questions show their containing page and open their original block. The tally and sidebar count include inline questions. Each row shows state, reading count, current assessment's first line and date, or No current reading, then the next revisit date. No progress percentage is shown.

The sidebar's Questions menu opens the [research desk](desk.md), which links question, position and source queries. A question's own menu offers Open in desk.

## Empty kinds

An empty finding aid says `No people yet.` in muted Piazzolla under a hairline, then one sentence on how pages arrive:

- Type kinds are filed from Unfiled.
- Questions and Projects use Make question or Make project in the page menu.
- Sources arrive through the [Library](library.md).

Every built-in kind except Sources offers New person…, New question… and so on, in the empty state or beside the populated finding aid's tally. Creation files the page as one acknowledged batch, creating the kind's type page too when it is missing, then opens the page; Shift-Enter opens it beside. A title that an existing page already has files that page instead, or opens it when it is already of the kind, and the form says so before you submit. The type's own title is refused.

The form opens under a `NEW PERSON` rubric with the title in the page-title face on a hairline and an optional gist line beneath it in the gloss face. The gist becomes the page's first block, which the finding aid shows under the title. A type with template fields lists them in mono. Up to four similar pages, matched by title or alias, follow under Similar pages: one already of the kind opens, any other is filed as the kind.

## Unfiled

Unfiled is a filing queue grouped into With text and Blank, with All, With text and Blank filters and real block/backlink apparatus. Blank can still be referenced and is not a deletion recommendation.

Opening a blank note does not add stored blocks. Add a block starts writing only when chosen.

Each row has File and a menu containing Open, File under a type…, Rename…, Merge into… and Delete…. Desktop and unfolded layouts pair the list with a selected-note inspector and links to its referring pages. The touch cover uses a filing sheet above navigation.

The shared one-step type picker serves row File, the inspector and bulk filing. Clicking a type or pressing Enter files immediately; Create type “X” and file creates and files in the same acknowledged batch. Escape or clicking away cancels. The list reserves at least three full rows (or all choices when fewer), scrolls internally and flips above the trigger when there is more room there. After filing, focus moves to the next remaining row's File button, or the previous row when the queue ends.

Checkboxes appear at each row's left on hover or keyboard focus and stay visible when selected or on touch screens. Cmd/Ctrl-click toggles selection; Shift-click extends it in visible queue order. The selection bar shows `N selected`, `File…` and `Clear`; changing All, With text or Blank clears it. Bulk File uses `FILE N NOTES`, names up to three titles followed by `and N more`, and files every selected note in one attributed batch. The filing status offers one Undo for the whole batch, using revision checks so later edits are not overwritten. Undo removes memberships but retains a newly created type page; without remaining members or template fields, that page returns to Unfiled. Rename uses the canonical page document; merge and delete retain their existing confirmations and undo rules.

## Streams

A stream is a running page such as Reading inbox or Japanese practice. Make stream, in the page menu after Make project, adds the `Stream` type, so streams get their own Index entry; Remove stream takes it off.

Notes are written in the journal, under a line that links the stream. On a stream or project page, Arrivals sits between the outline and Backlinks: the direct children of those journal lines, grouped by day with the newest first, each with a mono nested count and Add. Field entries under the line are not arrivals.

Add links rather than moves. It adds a whole-row `[[note]]` line at the end of the page, filling a trailing empty line first, in one undo step, and the note stays in its journal. The page outline is the stream's order, so the usual drag and ⌥⇧↑/↓ reorder it.

A whole-row link to a block, other than a field entry or value, shows that block live: its text, up to 12 nested lines and then `Show N more`, and a faint mono provenance (`Mon 12`, or the page title) that opens the source, Shift beside. Editing the note in its journal updates every stream that shows it.

### Embedded views

`/Embed view` and Embed view in Commands offer saved views by name. Choosing one fills an empty block or inserts a sibling after the selected block, then selects it. A view's Embed on page… menu action appends the reference to the chosen page and opens its block.

The embed names the view, with its purpose beneath, then shows up to twelve live rows using the saved layout and recipe. Its name and Show all N open the saved view; Shift opens beside. Edits use the same field cells and page history as the view. Committed notebook changes refresh its query without a manual refresh, and reload keeps the reference. Read shows the same quiet result under its heading.

A desk recipe stays compact: its name, purpose and Open desk. Opening it shows the linked columns in a pane; Shift opens beside.

A missing view keeps the remembered name with Relink… and Remove embed. Undoing the view's deletion makes its rows return. Inline references and Find show named links; plain-text block export keeps the authored reference, as for page links. Phone embeds use the recipe's card fields without lateral scrolling.

## Sources

Sources is a bibliography, not a second reading shelf. It shows siglum, source title, author byline, format, publisher, publication year when stored, citation key, highlight count and ordinary page-backlink count. Open source notes is the default; Read appears only for sources with a current snapshot and hands off to the [reader](reader.md), and Open Library sits in the ruled strip. Reading progress and invented metadata are absent.

## Note header

A note at its top level shows its kinds above the title in rubric mono capitals, separated by a faint slash (`PERSON / ECONOMIST`). Each opens that kind's finding aid.

The title wraps within its available header width, including unbroken names and URLs, without overlapping the header actions.

A note with aliases shows them under the title: `ALSO` in faint mono, then the aliases in italic Piazzolla at the quote size, separated by faint dots. Then one mono line reads the last ten characters of the note's ID, lower-cased, with the full ID as its tooltip, then `Created 2026-10-06` in the notebook's time zone. The gloss follows as the first row.

Unfiled notes show no kinds. Sources keep their own header; journal days and the Fields page have none.

The Revisit menu sets a date with Revisit in a week, Revisit in a month, Revisit in three months, a calendar date or No revisit date. Resolve clears the date and marks the note resolved; Reopen returns it to working. Editing alone never reopens it. The latest action offers Undo revisit, then Redo revisit after undo.

The Backlinks section appears and its count refreshes when incoming links change, including links to the note's own blocks. It reports the full count after removing links already represented as perspectives or works, groups sources by referring page, shows the first 100 when open, and offers Load more for each further batch. Unlinked mentions of the title and aliases follow it; see [Backlinks](../design.md#backlinks).

## Reference previews

Resting on an inline reference opens its read-only slip at the hovered line, including links in the standfirst and fields. The slip prefers below the link, flips above when that side has more room, and remains inside the originating pane and visible viewport. Its content and fonts load before it is measured and shown; it fades in without travelling or resizing. Refreshing a reference label keeps the same anchor rather than reopening the slip.

Pinning with ⌘ or Pin expands the slip to its readings and permits scrolling. Open and Beside retain the originating pane; nested references open further slips within that pane. A passive preview leaves global navigation shortcuts available and closes when the pane navigates; focusing its controls gives the card keyboard ownership until it is closed.

## Aliases

Add alias, in the page menu after Gloss and in the palette, adds the Aliases field after the gloss and starts a new value with keyboard focus, ready for the first typed character. `[[` completion and Find name the alias a result was found through as `via Tully`, in faint mono at the row's end.

An inline link can display different wording without changing its target: `[[Target|alias]]`. While `[[` completion is open, type `|` to accept the highlighted target and begin the alias inside the paired `]]`; if no match or Create page is highlighted, the typed target stays as written without creating a page. Alias text never filters or reopens completion. To add an alias to an existing link, place the caret just before `]]` and type `|alias`. Enter and Tab still accept a completion and continue after the link; Escape still dismisses it without accepting a target.

At a note's top level, populated Aliases entries stay out of the outline while the header's ALSO line presents them. Clicking or tapping that line, or activating it with the keyboard, reveals the field and edits its first value. Add alias also reveals it before starting the new value. Zoomed outlines and sources keep ordinary field presentation.

A hand-typed `[[Name]]` that two or more pages answer to stays unlinked and reads in `--warning` with a dotted underline and a small `?`. Clicking it lists the pages and Create page; the choice links it with the typed wording kept. Imported creators with a shared name read the same way.

Merging leaves the merged page's title as an alias, which the confirmation states in one sentence.

## Starting templates

A Person, Group or Concept type page with an empty template offers `Start from the Person template` in its template area, naming the fields. A type page the app creates with one of those titles starts with it.

## Type icons and names

A type's template offers **Icon and name…**: a compact glyph grid and an editable plural name. The empty name previews the automatic English plural; Reset removes both overrides. Apply records one undoable change on the type page, shared across devices.

The sidebar, Index directory, note eyebrow and table title read the same kind presentation. Book, Article and Collection default to their book, article and shelf glyphs without writing notebook data; other made types use a tag. An unknown glyph also reads as a tag.

## Spreads

New spread opens an unsaved sheet; a view's selected notes can open the same sheet. Add note… uses the note picker, up to five columns. The `SPREAD` rubric heads aligned rows: kind, title and gloss; the union of fields in first-column-then-next outline order, with absent cells blank; Sources, Links and Opening. Sources include passage citations and references to a source page. Opening is the first visible non-field prose block.

An exact value shared by at least two columns carries `=` with title Shared. Text is compared after trimming; a whole reference is compared by its target, regardless of its label. A link to a selected column carries `↔`. Differences carry no mark.

Each column offers Move left, Move right and Remove column. Save spread asks for a title, initially the column titles joined with ` / `. Saving creates a page with the spread capability and one top-level `[[id]]` block per column in order. Saved spreads appear after kinds in the Index directory and sidebar.

On a saved page, the sheet sits above the ordinary outline. Children of a reference are commentary on that column; other top-level blocks are notes on the whole spread. Column controls insert, move or delete these reference subtrees through the page document, preserving attributed history and Undo/Redo. They retain keyboard focus in the spread so Undo works immediately after a column disappears. Undo restores the removed column's captured position and commentary even after other columns have moved. Shift opens notes, saved spreads and the newly saved page beside.

With fewer than two notes the sheet says `Select two to five notes to compare them.` The selected column remains available to remove or accompany with another note.
