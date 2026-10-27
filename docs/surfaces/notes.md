# Notes

A note is a titled page; the [domain model](../domain-model.md#notes) defines its kinds.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Index

Index is a sidebar section after Pinned. Its count is the distinct notes filed, left out at zero. It reads as a finding aid: kinds sit on shelves under small tracked capital heads, in this order:

| Shelf | Kinds |
| --- | --- |
| Atoms | People, Groups, Concepts and Theses (types with those titles), then Questions (a capability), then the fixed Fields register row on desktop. |
| Sources | Sources (a capability), Book, Article and Collection, and any other type most of whose notes are sources. |
| Work | Tasks and Projects (capabilities), and any other type most of whose notes are projects. |
| Tags | Every other type you made, including types that only tag blocks. |
| Loose | Unfiled. |

The service assigns each kind its shelf, so a type moves shelf only when most of its notes change capability. Saved spreads follow under their own Spreads head. A shelf with no listed rows leaves out its head; the desktop Atoms shelf always contains Fields.

Rows stay on one line: the kind's glyph in `--faint`, the name at control size, and a bare mono count right. A kind with notes uses its plural. A tag that only marks blocks uses the spelling you wrote, so `#arabic` stays `arabic` unless you set a plural.

| Kind | Count and appearance |
| --- | --- |
| Note kind | Titled notes. |
| Tasks, Questions, Projects and Sources | Every visible atom with the active capability, including inline atoms and behavior added without a written tag. Tasks excludes checkbox-free appointments. Their finding aids, tables and kind filters list the same set. |
| Tag-only type | Tagged atoms. The row uses the tag's spelling, not an automatic plural. |
| Fields | Live named definitions, including archived definitions, as in the Fields register. Always shown, including at zero. |
| Empty built-in kind | On desktop, the same row, named in `--faint` without a count, on its shelf. On the touch cover, collected in one counted disclosure below the populated shelves. Each name opens its finding aid. |

An empty built-in kind that has a saved view keeps that row, still without a count. The Questions menu stays off until that kind has visible members or a saved view. Each other type and Unfiled are listed only while they have titled notes or tagged non-page blocks. The distinct-note total never includes inline atoms.

The sidebar's Index heading opens the all-atoms finding aid. Tag-only rows open their [member table](fields-tables.md#tables-and-views) directly; other kinds open their finding aid. On desktop, a saved view sits under the kind whose type it lists, on a hairline elbow and without its table glyph. The section refreshes with the desk counts and disappears rather than go stale when its request fails.

On a touch screen under 600 px, the shell's Index button instead opens a pushed navigation page. Its head is Index with a quiet atom count, followed by plain shelf names. Revisits starts the Atoms group. All saved views, including pinned views, appear once in Views rather than under their kinds or Pinned; each view's actions menu offers Pin view or Unpin view, and New view comes last. Empty kinds fold into one row such as `3 empty kinds`: expanding it preserves access to unused destinations without making them full rows by default. Recent follows the views, and pinned pages keep their own section when present.

Fields is a fixed row, not a kind. Its field glyph and definition count come from the index read, separate from the tag registry. It closes the desktop Atoms shelf and opens the [Fields register](fields-tables.md#fields-register). On the touch-cover Index page it moves to the foot, where the workshop switcher, Settings and Fields are full rows. Its sidebar row reads selected while the global register is active; a tag's Fields tab still selects that tag instead.

Tags keep their page identity across renames. The sidebar, pills, table filters and tag decks read the current title by ID. Choosing an existing tag writes `#[[id|Title]]`; a new tag starts as `#Title` and normalizes on save. A missing tag page leaves a faint pill with its remembered name, not membership in another page that reuses that name.

## Finding aid

A kind opens with its plural in Piazzolla and a mono note tally, without an Index eyebrow. Sources and Unfiled instead have sentence-case Bibliography and Filing queue eyebrows. When notes lack a field their type requires, a link such as `1 needs author` follows the tally and adds that field's `is empty` filter, and each such note reads `needs author` under its title. Both count the listed notes, not tagged blocks. A type's List, Table, Fields and Cards modes share the ruled tab strip. List and Table count matching members; Fields counts the template's fields and Cards its card templates, not values or cards on members, and an empty template shows no count. Fields opens [that type's template](fields-tables.md#type-fields-tab), not the global register.

Titles sit under rubric letters with a hairline and a distinct-note count:

| Pane width | Columns |
| --- | --- |
| 840 px or wider | Three. |
| Below 840 px | Two. |
| Below 600 px | One. |

Long titles clamp to three lines and keep the full title in a tooltip.

Each note shows two lines of its first populated standfirst field, else its first non-field prose block, then one populated template field and its nonempty visible prose-block count in mono. Field entries and their descendants, headings, blank blocks and archived subtrees do not count as prose. Zero prose counts are omitted; a note without prose shows a nonzero ordinary backlink count instead, or no apparatus if neither exists. The Collections finding aid instead shows its member-source count in mono, using the same Library collection query as the collection cards. A title without prose has no empty preview. The batched index read derives this apparatus without a page read per row. A whole-kind alphabetical visit uses that read directly; filtered and grouped queries still use the query engine, and populated field choices load when Group or Filters opens.

Only populated jump letters appear, and only with Letter grouping. The strip stays on one line, using compact targets on desktop. On the touch cover it becomes a vertical rail at the right edge, with touch-sized letter targets and compact inline initials in the list. The rail scrolls when its letters exceed the available height; it never occupies a dock above bottom navigation. Sort as, diacritic folding, `#` last and alias cross-references retain their filing rules. A title opens its note. The finding aid fills the pane to the right when one exists; otherwise it uses its own pane. ⌘-click or ⌘Enter opens beside (Ctrl-click or Ctrl+Enter off Mac). A coarse pointer at least 900 px wide opens beside by default.

Below the mode tabs, `Find in Concepts…` (using the kind's plural) matches plain words against title or Gloss. `links:`, `from:` and `cites:` resolve titles and aliases; `cites:` also resolves source sigla and citation keys. Quote a multiword value, for example `links:"Three generations of a dynasty"`. Names complete after the colon. Enter, a closing quote or leaving the input resolves each term to a removable table-style chip; unresolved names show `No note named “X”`. All terms and field filters intersect. `cites:` includes passage citations of any of the source's snapshots and any reference to its source page.

The names that complete after a colon open as a list under the field. Arrows highlight, Enter picks the highlighted name, and Escape closes the list for the text typed; typing on reopens it.

On the touch cover, one search row follows the tabs on both List and Table. Its filter button opens a sheet containing Group, Filters and Save as view, plus Select atoms. Group, Filters and Save as view open inside that sheet rather than as sheets on a sheet, so Escape or the scrim first backs out of an open editor to the options list, and the next one closes the sheet. The in-page New action is hidden; the glass top bar starts the same kind-locked creation slip.

Group offers Letter, Source cited, Atom linked, Created month, then the kind's populated fields. A note appears under every applicable heading. Source, link and field-value headings sort by descending distinct-note count, then name; None is last. Source headings show siglum then title, and link headings open their note. Created month is newest first. Both layout tabs count the current query, including a saved view's members, rather than all members of the kind.

Save as view… keeps the query, layout and grouping in the existing view store. A typed view name survives a click outside its form, as does a changed title in Rename. On the cover Index, saved views sit together in Views; desktop lists them under their kind. Reopening restores chips and grouping. Older table views remain Table with Letter grouping when opened as a list. List and Table retain the same query on switching.

Field grouping travels between List and Table: Table translates the finding aid's saved field grouping into its row grouping, and its Group menu updates the field grouping used on return to List.

If a saved finding aid names a detached or deleted field, it shows the remembered name and offers Remove from view. Results pause until that reference is removed or the field change is undone. The action saves the repaired query, without discarding other filters or presentation choices.

Counts, empty states and field-filter chips wait for the relevant reads; a pending request never claims there are zero notes or a missing field. Search and grouping keep the previous rows, headings and counts visible together until the new query finishes. Index and note panes reserve scrollbar space so shorter results do not move the text column sideways.

List rows reveal a checkbox on hover or focus and keep it visible on larger touch layouts. On the cover, checkboxes only appear after Select atoms in the filter sheet; tapping a title then toggles its selection instead of opening it, and Done leaves Select mode and clears the selection. Its label supplies the shared pointer target without enlarging the glyph. Cmd/Ctrl-click on the checkbox toggles a note; Shift-click extends from the selection anchor. The bar shows `N selected` and Clear, plus Spread when the shell provides it. Spread accepts two to five notes. ⌘-click opens it beside (Ctrl-click off Mac). Selection counts distinct notes even when a note occurs under more than one heading.

`is:resolved` filters `@resolved` to true. `revisit:due` filters `@revisit` through today in the workshop's time zone; `revisit:set` and `revisit:none` select set and empty dates. Question notes use their question's revisit date. These predicates share the query's field filters and remain live when saved. State grouping in the finding aid's Group menu is not implemented.

Their chips use the same attribute labels as entity views: Resolved and Revisit on or before today. Raw query keys stay out of the finding aid.

### Questions ledger

Questions opens a ledger rather than the alphabetical finding aid. Its heading, tally and create action align like other type pages, under a sentence-case Inquiry ledger eyebrow and with a question glyph beside Questions. Its ruled tabs are Active, Recurrent, Due, Answered, Parked and All, kept on one horizontally scrolling line in narrow panes. Active includes questions that are active or recurrent; Due selects non-parked questions whose revisit date has arrived. Each tab reads the same state filter from `/api/questions`. Find in Questions uses the finding aid's words, link/source predicates and Revisit/Resolved chips, intersected with the selected state; it includes inline questions and preserves program grouping.

Questions are grouped by their top-level program, with branches below it. Inline questions show their containing page and open their original block. The tally and sidebar count include inline questions. Each row shows state, perspective count, current assessment's first line and date, or No current answer, then the next revisit date. No progress percentage is shown.

The sidebar's Questions menu opens the [research desk](desk.md), which links question, perspective and source queries. A question's own menu offers Open in desk.

## Empty kinds

An empty finding aid says `No people yet.` in muted Piazzolla below the find row, lowercasing a built-in kind but keeping a type's own capitals (`No Italian words yet.`), then one sentence on how pages arrive:

- Type kinds are filed from Unfiled.
- Tasks can be written inline with `#task` or started in the shared task creation slip.
- Questions and Projects use Make… → Question or Project in the page menu.
- Sources arrive through the [Library](library.md).

A tag-only type's index has no notes but does have members. It says `No atoms filed as Italian word.`, counts the blocks it tags, and offers Open table.

Every built-in kind except Sources, and every user type with an index, offers New person…, New question… and so on, in the empty state or beside the finding aid's tally. The shared creation slip locks that kind. Creation files the page and inserts its first body block as one acknowledged batch, creating the kind's type page too when missing, then opens its unzoomed Outline with the body caret live. Shift+Enter opens beside; Shift+⌘Enter creates another without leaving the slip. On coarse layouts with two visible panes, creation from an index or ledger opens beside by default. An existing title files that page instead, or opens it when already of the kind, without forcing an editing caret. The type's own title is refused.

Generated create labels use sentence case for built-in and notebook-defined types, such as `New book…`.

New task uses that same slip to append a task atom to Today or the chosen page rather than creating a titled task page; its active capability is enough to include it in Tasks.

The slip names New person in its apparatus rubric. An autosizing page-title textarea wraps without inserting newlines on Enter; the optional gist becomes the first block, with the caret at its end. With no gist, the first block is empty and ready for typing. A project's gist instead sets its outcome, shown in the project header, without duplicating it in the body. Up to four similar pages match anywhere in titles and aliases, excluding the exact title: Link appends a bracketed title to the gist without closing; Open opens the existing page and closes the slip.

The slip's primary choices are `#task`, `#question`, note, card and `#source`, in that order. More reads the remaining tags and their glyphs from the registry. A plain atom with `@friday` is an appointment. Agenda shows its time without a checkbox; `#task`, `/Todo` or ⌘Enter adds one.

Under the gist, compact field rows pair apparatus labels with values, separated by hairlines; each row opens the matching editor. Tab moves from title to gist, fields and Create. Rows keep their full width on a sheet. Questions offer Parent question (page or inline), Revisit (In a week, In a month, In three months, On a date… or None), Recurrent and First perspective (the same people and groups offered by Add perspective). These save with the full question state; the first perspective and its empty Gist save in the creation batch. Projects offer Deadline.

Typed drafts offer the first four template fields in template order, or all fields when there are fewer. Longer templates say More fields after creating. The editors match table cells, including choice options and creating a linked page for a relation value. Values save in the page's creation batch. Filing an existing title shows already-filled fields read-only and sets only empty fields, checking the current page again at submission.

## Unfiled

Unfiled is a filing queue grouped into With text and Blank, with All, With text and Blank filters and real block/backlink apparatus. Blank can still be referenced and is not a deletion recommendation.

Opening a blank note does not add stored blocks. Add a block starts writing only when chosen.

Each row has File and a titled Atom actions menu containing Open, File under…, Rename…, Delete… and More…. More holds Merge into… and Copy reference, which copies `[[id]]`. The existing title and apparatus header stays above the root rows; Back returns from More, and Close, Escape or clicking outside dismisses the menu. Desktop and unfolded layouts pair the list with a selected-note inspector, a short excerpt from its first three visible prose blocks (separate from the gloss), and links to its referring pages. The excerpt is bounded to eight display lines. The touch cover uses a filing sheet above navigation.

The shared one-step type picker serves row File, the inspector and bulk filing. Clicking a type or pressing Enter files immediately; Create tag “X” and file creates and files in the same acknowledged batch. Escape or clicking away cancels. The list reserves at least three full rows (or all choices when fewer), scrolls internally and flips above the trigger when there is more room there. After filing, focus moves to the next remaining row's File button, or the previous row when the queue ends.

Checkboxes appear at each row's left on hover or keyboard focus and stay visible when selected or on touch screens. Cmd/Ctrl-click toggles selection; Shift-click extends it in visible queue order. The selection bar shows `N selected`, `File…` and `Clear`; changing All, With text or Blank clears it. Bulk File uses `FILE N NOTES`, names up to three titles followed by `and N more`, and files every selected note in one attributed batch. The filing status offers one Undo for the whole batch, using revision checks so later edits are not overwritten. Undo removes memberships but retains a newly created type page; without remaining members or template fields, that page returns to Unfiled. Rename uses the canonical page document; merge and delete retain their existing confirmations and undo rules.

## Streams

A stream is a running page such as Reading inbox or Japanese practice. Make… → Stream in the page menu adds the `Stream` type, so streams get their own Index entry; Stream… → Remove stream takes it off.

Notes are written in the journal, under a line that links the stream. On a stream or project page, Arrivals sits between the outline and Backlinks: the direct children of those journal lines, grouped by day with the newest first, each with a mono nested count and Add. Field entries under the line are not arrivals.

Add links rather than moves. It adds a whole-row `[[note]]` line at the end of the page, filling a trailing empty line first, in one undo step, and the note stays in its journal. The page outline is the stream's order, so the usual drag and ⌥⇧↑/↓ reorder it.

A whole-row link to a block, other than a field entry or value, shows that block live: its text, up to 12 nested lines and then `Show N more`, and a faint provenance (`Mon 12` in mono, or the page title in the apparatus) that opens the source. ⌘-click opens the source beside (Ctrl-click off Mac). Editing the note in its journal updates every stream that shows it.

### Embedded views

`/Embed view` and Embed view in Commands offer saved views by name. Choosing one fills an empty block or inserts a sibling after the selected block, then selects it. A view's Embed on atom… menu action appends the reference to the chosen page and opens its block.

The embed names the view, with its purpose beneath, then shows up to twelve live rows using the saved layout and recipe. Its name and Show all N open the saved view. ⌘-click opens beside (Ctrl-click off Mac). Edits use the same field cells and page history as the view. Committed workshop changes refresh its query without a manual refresh, and reload keeps the reference. Read shows the same quiet result under its heading.

A desk recipe stays compact: its name, purpose and Open desk. Opening it shows the linked columns in a pane. ⌘-click opens beside (Ctrl-click off Mac).

A missing view keeps the remembered name with Relink… and Remove embed. Undoing the view's deletion makes its rows return. Inline references and Find show named links; plain-text block export keeps the authored reference, as for page links. Phone embeds use the recipe's card fields without lateral scrolling.

## Sources

Sources is a bibliography, not a second reading shelf. It shows siglum, source title and author byline; stable person references open that page, while unlinked or bracketed names read as plain names without wiki syntax. One apparatus line, its figures in mono, combines format, publisher, publication year when stored, citation key and nonzero highlight/page-backlink counts. Entries use 12 px vertical padding. Open source atoms is the default; actions sit inline with the apparatus, revealed on hover or focus and always visible on touch. Read appears only for sources with a current snapshot and hands off to the [reader](reader.md), and Open Library sits in the ruled strip. Reading progress and invented metadata are absent.

Collection pages show member sources in a Sources section. Their Table opens the Library collection view.

## Note header

A note at its top level shows its kinds above the title in rubric tracked capitals, separated by a faint slash (`PERSON / ECONOMIST`). Each opens that kind's finding aid.

Type breadcrumbs use the plural. Truncated breadcrumbs keep their full label in a tooltip. Project and question pane headers carry flag and question glyphs.

The note waits for its kinds and alias fields before appearing. Its title, aliases and opening rows appear together; background refreshes keep the current note visible. Offline, cached notes remain visible and editable without that metadata. Reconnecting refreshes the note's apparatus and the sidebar Index. New notes remain visible and editable while creation is pending; their service-only apparatus and Find and reference previews wait for the root's acknowledgment, showing empty or loading states rather than missing-block errors.

The title wraps within its available header width, including unbroken names and URLs, without overlapping the header actions. Tag tokens in the title do not display: a behavior tag is its glyph before the title and any other tag a pill after it, and the pane breadcrumb, sidebar, Index, Library and Find read the same tagless title.

The Opening navigator appears only after the title leaves the viewport, with 24 px hysteresis. A fresh page's empty root reads `Start writing…`. Read keeps each child's inset at its outline depth.

Page fields use two columns: label and value. Empty fields of every kind show `Add…`. Multiple values of one field share a row; dates and numbers use mono. Relation pills open their target with an `Open …` label. A pencil appears on hover or focus, and always on touch, to edit the value; F2 also edits. When bullets are shown, a task's status glyph takes the bullet slot and Plan stays inline.

A note with aliases shows them under the title: `ALSO` in faint tracked capitals, then the aliases in italic Piazzolla at the quote size, separated by faint dots. Then one apparatus line reads `Created 2026-10-06`, the date in mono and in the workshop's time zone, without the note's ID at any width, then Revisit. Revisit is muted, reads `Revisit 2026-11-12` once a date is set and turns gilt when that date is due; a resolved note reads Resolved. The gloss follows as the first row.

Unfiled notes show no kinds. Sources keep their own header; journal days and the Fields page have none.

The titled Atom actions menu names the page (or journal date), then shows the full ID in mono, its Created date and Copy ID. Copy ID leaves the menu open and confirms with Copied; Copy reference is the first action and copies `[[id]]`, as the block menu does. Clipboard failures are reported without claiming success.

Rename, Merge into…, Pin or Unpin and Open beside stay at the top. Description… holds Gloss and Add alias; Add field… stays direct. Make… offers only absent Task, Project, Stream and Question features, with Task and Project only on journal days. Existing features have named Task…, Project…, Stream… and Question… managers. Appearance… holds bullets in Outline and archived visibility; Delete atom… is last. Description… wears the note glyph and Appearance… the rows glyph, so no two rows share one.

Built-in tag pages are system pages. Their title control and Rename action accept a change of case, such as Task to task. The engine refuses a different name with `Task is a built-in tag; its name cannot change.` Merge and Delete remain disabled with their engine refusals. Removing a task, question, project or source removes its written tag token when present; its glyph is that tag's pill at rest.

Tags… lists Add tag… and a Remove action for each manual membership, on filed and unfiled pages alike. Add uses the shared type picker; removing a type keeps the note's written field values and is undoable. Commands offers Tags on this atom…, Add tag to this atom… and Remove tag from this atom… without requiring a selected body row. The kind names above the title still open their finding aids.

Compare remains a projection tab and palette command, and Undo and Redo remain palette commands and shortcuts rather than menu rows. On coarse phones the menu becomes a bottom sheet with Close, 44 px rows and Back for drill-ins; it scrolls on shorter screens.

An unavailable Compare tab explains the reason in its tooltip.

The Revisit menu sets a date with Revisit in a week, Revisit in a month, Revisit in three months, a calendar date or No revisit date. Resolve clears the date and marks the note resolved; Reopen returns it to working. Editing alone never reopens it. The latest action offers Undo revisit, then Redo revisit after undo.

The Backlinks section appears and its count refreshes when incoming links change, including links to the note's own blocks. It reports the full count after removing links already represented as perspectives or works, groups sources by referring page, shows the first 100 when open, and offers Load more for each further batch. Unlinked mentions of the title and aliases follow it; see [Backlinks](../design.md#backlinks).

Backlinks, Cited in, Unlinked mentions and Linked to this atom use apparatus section heads with a rule and faint mono count. Zero results collapse to one quiet line. Journal backlink rubrics use the shared civil-date rule: `today`, `tomorrow` and `yesterday`, the weekday within six days either side, then the month and day, with the year outside today's.

## Deleted pages

Deleting a page retains its identity, blocks and deletion event. The toast and Undo atom deletion in Commands restore the latest deletion; Commands → Restore deleted atom… lists retained deletions by title, newest first, including after reload and deletions from another window. Restoration checks the event and current revision and leaves newer changes alone. A reused title must be renamed before the deleted page can return. Permanent merge tombstones are not listed.

⌘Z (Ctrl+Z off Mac) restores a page deletion while it is the latest action in that window, even after navigation to the replacement page. A newer edit returns the shortcut to that edit's history; the deletion remains recoverable through its toast or Commands.

## Reference previews

Resting on an inline reference opens its read-only slip at the hovered line, including links in the standfirst and fields. The slip prefers below the link, flips above when that side has more room, and remains inside the originating pane and visible viewport. Its content and fonts load before it is measured and shown; it fades in without moving or resizing. Refreshing a reference label keeps the same anchor rather than reopening the slip.

Reference previews stay closed while a field value editor is open.

Pinning with ⌘ or Pin expands the slip to its perspectives and permits scrolling. Open and Beside retain the originating pane; nested references open further slips within that pane. A passive preview leaves global navigation shortcuts available and closes when the pane navigates; focusing its controls gives the card keyboard ownership until it is closed.

## Aliases

Add alias, under Description… in the page menu and in the palette, adds the Aliases field after the gloss and starts a new value with keyboard focus, ready for the first typed character. `[[` completion and Find name the alias a result was found through as `via Tully`, in the faint apparatus at the row's end.

An inline link can display different wording without changing its target: `[[Target|alias]]`. While `[[` completion is open, type `|` to accept the highlighted target and begin the alias inside the paired `]]`; if no match or Create atom is highlighted, the typed target stays as written without creating a page. Alias text never filters or reopens completion. To add an alias to an existing link, place the caret just before `]]` and type `|alias`. Enter and Tab still accept a completion and continue after the link; Escape still dismisses it without accepting a target.

At a note's top level, populated Aliases entries stay out of the outline while the header's ALSO line presents them. Clicking or tapping that line, or activating it with the keyboard, reveals the field and edits its first value. Add alias also reveals it before starting the new value. Zoomed outlines and sources keep ordinary field presentation.

A hand-typed `[[Name]]` that two or more pages answer to stays unlinked and reads in `--warning` with a dotted underline and a small `?`. Clicking it lists the pages and Create atom; the choice links it with the typed wording kept. Imported creators with a shared name read the same way.

Merging leaves the merged page's title as an alias and retains both pages' types, without duplicates. The alias, memberships, moved blocks and redirected references commit together; the confirmation states that the title stays as an alias.

Unavailable Merge into items name the protected page capability or history, such as a spread, rather than referring to root state.

## Starting templates

A Person, Group or Concept type page with an empty template offers `Start from the Person template` in its template area, naming the fields. A type page the app creates with one of those titles starts with it.

## Type icons and names

A type's template offers **Icon and name…**: a compact glyph grid and an editable plural name. The empty name previews the automatic English plural; Reset removes both overrides. Apply records one undoable change on the type page, shared across devices.

The sidebar, Index directory, note eyebrow and table title read the same kind presentation. Book, Article and Collection default to their book, article and shelf glyphs without writing workshop data; other made types use a tag. An unknown glyph also reads as a tag.

## Spreads

New spread opens an unsaved sheet; a view's selected notes can open the same sheet. Add atom… uses the note picker, up to five columns. The `SPREAD` rubric heads aligned rows: kind, title and gloss; the union of fields in first-column-then-next outline order, with absent cells blank; Sources, Links and Opening. Sources include passage citations and references to a source page. Opening is the first visible non-field prose block.

An exact value shared by at least two columns carries `=` with title Shared. Text is compared after trimming; a whole reference is compared by its target, regardless of its label. A link to a selected column carries `↔`. Differences carry no mark.

A faint apparatus legend beneath the sheet explains `= Shared value · ↔ Links to another column`.

Each column offers Move left, Move right and Remove column. Save spread asks for a title, initially the column titles joined with ` / `. Saving creates a page with the spread capability and one top-level `[[id]]` block per column in order. Saved spreads appear after kinds in the Index directory and sidebar.

On a saved page, the sheet sits above the ordinary outline. Children of a reference are commentary on that column; other top-level blocks are notes on the whole spread. Column controls insert, move or delete these reference subtrees through the page document, preserving attributed history and Undo/Redo. They retain keyboard focus in the spread so Undo works immediately after a column disappears. Undo restores the removed column's captured position and commentary even after other columns have moved. ⌘-click opens notes, saved spreads and the newly saved page beside (Ctrl-click off Mac).

With fewer than two notes the sheet says `Select two to five atoms to compare them.` The selected column remains available to remove or accompany with another note.
