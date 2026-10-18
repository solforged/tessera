# Fields, types and tables

Fields defines the workshop's fields and type templates. Tables show a query as rows: a type's members or a saved view.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Fields register

The Fields row closes the Index's Notes shelf, with the field glyph and a live definition count. It opens the global register and reads selected while that register is active. The Index directory has the same row. Fields is not a tag or a choice in kind pickers; it has no separate sidebar foot button. Commands, menus and field breadcrumbs still open the register.

Fields opens a searchable register with Name, Kind, Used by and Templates columns. The heading, toolbar, table and footer share one centered `--measure` column; rows stay 28 px high.

| Action or width | Behavior |
| --- | --- |
| Click | Selects a row. |
| Available pane content at least 1096 px wide | Selection adds an `--apparatus-width` inspector with a `--space-48` gap. Table and inspector center together; heading and footer retain the table's left edge. |
| Narrower pane | A click opens the field page. |
| Enter or double-click | Always opens the field page. |
| Arrow keys | Move the selection. |

The inspector shows the name, Open page, the kind, Hide, a Reading line for dates, the first owners with their values and problems in rubric, and the templates that use the field.

- Template pills open their type table.
- Kind reads as muted text and shows its menu chevron on row hover or focus.
- Used by opens the distinct owning blocks, including entries with no values. A field no block uses says Unused in `--faint`.
- ⌘-click opens any of these beside the index (Ctrl-click off Mac).
- Narrow panes scroll the table horizontally with Name held in place.

New field asks for Name and Kind together, defaults to Text, and refuses duplicates and the characters `name::` shorthand refuses. Creating the definition and its chosen kind is one undoable edit; redo restores the same definition.

Filtering the index does not change definitions; an empty result offers Clear filter.

## Field pages

A field page is a specimen sheet on the outline measure, crumbed `Fields / Name`. Rename… and Delete definition… sit at the name's right, and a mono summary (`Choice · 7 owners · 9 values`) under it. A built-in field's Rename… is disabled. Kind, Links to for relation fields, Hide, Role and Counts as follow as rows between single hairlines, each note inside its row. Hide offers Never, When empty and Always, with one muted line saying what the current choice does. Role offers Standfirst, Attribute, Prose and Citation, with a sentence explaining its presentation. Each change is one undoable edit on the definition. The [field menu](../design.md#field-entries) in any note opens this page, at the kind preview, Options or Links to; its Role menu offers the same choices.

Counts as offers Nothing, Creator, Contributor and Originator, as the [domain model](../domain-model.md#counts-as) describes. It is disabled with its reason on a built-in field and on fields that are neither text nor relations.

A note's field entry menu is titled with the field name and names its owning note as mono context. Open field page leads, Definition… groups Kind…, Options… for choices or Links to… for relations, Hide…, Role… and Counts as…, and Remove from this note stays last as a danger action. Templates… contains Add to or Remove from each owning type's template and is absent without an owning type. This gives four root rows, or three without Templates.

Kind, Hide, Role and Counts as are nested drill-ins with nine kinds, three hide modes, four roles and four meanings. Each replaces the rows in the same menu under a header Back. Kind still opens the interpretation preview before any change is applied; Hide, Role and Counts as retain their saving/loading reasons and Undo notices. On a phone below 600 px with a coarse pointer, the same menu is a bottom sheet with 44 px targets and an explicit root Close.

Rename uses New field's case-insensitive duplicate rule. A built-in field's Rename is disabled and names the reason, since the app finds it by name. An existing name opens Merge into with affected owners, pages, templates, saved views and conflicting values. Apply keeps conflicts as separate entries under the surviving definition and redirects every saved recipe to that definition. Column widths and collapsed groups are preserved. Undo restores the original fields and exact saved recipes.

Delete definition opens an impact preview, listing affected views by name. Archive keeps values and views readable and hides the definition from pickers. Merge into opens the same merge preview. Detach keeps values as ordinary `Name: value` blocks with their child notes, replacing links to the definition's choice options with their readable labels before removing the options. Delete values requires a separate confirmation checkbox. Every action offers one Undo, including detaching or deleting an archived definition.

Numbered sections follow with rubric numerals and hairlines, starting at 01 and numbering only sections shown (non-choice definitions omit Options):

| Section | Contents and actions |
| --- | --- |
| Options | Options with their uses and inline rename, then Add option; choice fields only. Option names may wrap; Uses and Edit retain their intrinsic one-line width, including on phones. |
| In templates | Each type's pill, the field's place in its template and the member count. |
| Used by | Up to twelve owners with their values in mono: three columns in wide panes, two below 840 px of pane width and one below 480 px. View owner (one owner) or View all N owners opens the field-only table. |
| Problem values | The written text in rubric beside its owner and the problem. Choice rows offer Make option: create or reuse the matching option and link every matching value in one undoable change. The help reads “Make it an option, or open its owner to edit it.” |

Blocks in the pane header opens the definition in the Fields page, where names and options remain ordinary blocks. Edit definitions opens the Fields page.

Deleting an in-use choice option from Blocks opens an impact confirmation with the affected value and owner counts. Continuing keeps its labels as written problem values, with their child notes, rather than unresolved option IDs. One Undo restores the options and the exact original values.

Choice and relation value pickers check the current value, expose it as selected and start the keyboard cursor there. An unmatched choice query offers `Add option “Y”`; adding the option and selecting it are one undoable change, including in tables. A note's Add field picker offers `Create text field “X”` and `Create field “X” as…`; the latter opens Text, Number, Date, Span, Checkbox, Choice, Relation, URL and Identifier. The definition, chosen kind and entry are created together. A new Choice field opens its value picker so its first option can be added there.

Creating a definition always uses a new block ID. Blank outline rows under Fields are not definitions and are never adopted or offered by field pickers.

## Kind changes

Changing kind opens an interpretation map on the field page before applying. Register rows, the inspector and a note's field menu open the same map. It lists every distinct written value and its use count under Mapped values, Readable as written, or Ambiguous or unreadable.

Choice rows have an editable option name and a mapping checkbox. Existing options are reused; different written values can share one name. Unchecking a row leaves it as written. Relation rows propose a page only when its title or alias matches exactly and uniquely. Choose page adjusts the target; Create page explicitly requests creation during Apply and files the page under the field's only Links to type, or makes it a source when that is Source. Blocks are chosen by hand after the change. Other kinds show their readings, including inclusive year bounds for Span.

Apply changes the kind and all reviewed mappings in one undoable edit. Unmapped values stay as written and show a problem when unreadable. Owners and child notes stay in place. Cancel writes nothing.

## Links to

Relation definitions show **Links to** below Kind, both on their page and in the Fields inspector. The checklist offers Source first, then the types, and applies as one undoable change; no selection reads **Any block**. Members of the selected types qualify whether they are pages or tagged blocks inside a page, and Source admits any source. A reference outside the selected types stays written and reads as a problem.

Library Author, Editor and Translator start with Person and Group targets. Import and the one-time workshop backfill file untyped creator pages as Person without changing pages already filed elsewhere.

Metadata suggestions, field-slot pickers and value pickers for such a field show members of the target types. Page titles and aliases match with the workshop's name folding; an exact alias match does not offer duplicate creation. Blocks match by label and show their page beside it. Blocks on the owner's page lead under **On this page**, and the owner is never offered. A query that names no page exactly offers **Create person “Name”** and **Create group “Name”**, creating and filing the page together. A field that links to Source offers **Create source “Title”**, a manual record in the Inbox. A type with block members offers no creation.

Enter commits the relation query as it is written at that moment, including before its candidates arrive. A pending query never permits accepting an older query's highlighted target. The accepted query and target constraints enter the value's durable outbox immediately; reloading during lookup resumes the selection and stores its canonical reference without reopening the picker.

Without Links to types, the picker offers pages, and from the third character also blocks found by search under **Blocks**.

## Type page template

A type page shows its template under the title as a Template section, closed by default, headed like the [journal's sections](journal.md#today-tiles): the name, a hairline, the template's fields in mono order and a chevron.

Open, it shows the same field rows as the type's Fields tab, described below. Add field opens the field picker without the fields already there. A new name offers Create text field and Create field as…, which add the definition and its template place in one change.

### Field rows

The type page and the Fields tab list a template with one row design: Name, Kind and Used by in template order. A name opens its field page. Kind reads as Relation → Person, Group for a relation, any block when it has no Links to types, and as Choice · 3 options for a choice field. Kind opens a menu of the nine kinds, then Links to… for a relation, Options… for a choice and Open field page.

- A kind every value already reads as applies in place, as a field with no values always does. Otherwise the field page opens its kind review for that kind.
- Links to… opens the same Links to chooser as the field page.
- Rename, Move up, Move down and Remove appear on hover or focus and remain visible on coarse pointers. Rename edits the name in the row; Enter or leaving the input saves it and Escape cancels. A built-in field's Rename is disabled, and a name another field holds is refused, since merging belongs on the field page.
- A required field reads `required` after its name, and its Remove is disabled with the reason, such as Books require author. The field menu's Templates… and the table's column menu disable their Remove from template the same way.
- Each rename, kind change and Links to change reports itself beside Add field, such as rank links to Person, with an Undo while it is the latest change.

Under the list sits a count of the members that lack template fields and Fill missing fields. This gives each of them an empty entry for every template field it lacks, placed in template order, in one workshop command. Undo beside the result removes the entries it added that are still empty; an entry that gained a value or a note stays. Changing the template never rewrites members.

## Type fields tab

The type's Fields tab opens its field template as a third in-pane view, with the same Index, Table, Fields and Cards strip. All four tabs title the kind by its glyph and plural, and Index, Fields and Cards share one left edge. Fields counts the template's fields and Cards its card templates, not values or cards on members, and an empty template shows no count. Its bounded register lists the template in the [field rows](#field-rows) the type page uses. Usage counts are workshop-wide distinct owners, including empty entries.

Add field and Fill missing fields keep the type page's editing behavior. The underlined type crumb opens the ordinary type page; the global Fields register remains separate.

## Field bed

An owner's populated fields stay visible at rest. Standfirst sentences lead, without labels. Attributes and citation fields share a compact label and value column; citation references show siglum · locator. Prose fields follow at full width. A page's empty template slots stay visible under its heading; a nested owner's empty template and recipe slots stay quiet until it or one of its fields is focused. On phones, labels stack above values and long text wraps within the measure.

A value click, or Enter on a selected field, begins filling that owner. Tab and Shift-Tab move through its fields and missing slots in template or recipe order; reaching a missing slot creates its entry and value. Shift-Enter adds a newline. Enter on an empty value leaves for the owner's next ordinary row. While its value picker has a query or an arrow-key highlight, Enter picks instead. Escape leaves without moving. Outside filling mode, Tab and Shift-Tab retain outline indent and outdent. Each value keeps its ordinary undo history.

Every field commit returns keyboard ownership to its value editor, its selected value row or the next slot, never the page body. Accepting a Choice or Relation keeps filling mode active, so Tab still advances without changing the value's parent. Tab commits a valid Date draft before moving; an invalid draft stays open with its error. At either end of the owner's slots, Tab keeps the current row selected. Undo and Redo restore a controlled value's row without reopening its picker.

Creating a text field opens its first value editor and keeps immediate typing and Backspace corrections through the pending handoff. Its accepted text enters the local outbox behind creation, so Escape ends editing without discarding it and reloading before the response still restores the value. Saving or canceling a definition or option rename returns focus to the field page, so its history shortcuts remain available.

Commands → Add field targets the selected block, or the page when no block is selected, and names that context in the palette. Page menu → Add field always targets the page, even while a block or field value is selected.

In Read, filling a field value that its holder-scoped register does not display switches to Outline and edits that same value; it never transfers typing to another row.

For a perspective, Add field begins with From this recipe: missing Gist, Work, then the subject's explicit or derived criteria. The recipe suggests, never requires.

## Tables and views

A table is a query shown as rows. New view… in the sidebar or Commands asks for Notes, Questions, Perspectives, Sources, Tasks or Highlights first. The first toolbar chip names the source and changes it. Existing type tables and note views keep their scope.

### Register and header

The heading, mode strip, toolbar, grid and footer share a centered 984 px register (`--measure + --apparatus-width - --space-16`). It widens only when the visible fields need more room and never exceeds the pane's inset width. They keep one left edge rather than centering a narrower heading inside a wider grid. A many-column grid scrolls horizontally inside that register with the title held at the left.

The type and Register sit in quiet apparatus above a Piazzolla view name. Its menu lists all members of the source or type and its saved views, then Save as view…, Rename and Delete separately. A checkmark means the current query and recipe equal that row's saved query, not merely that the view is open. When they differ, the open row shows faint mono Modified; Save changes updates a saved view in one undoable edit, and Revert changes restores its saved query and recipe. The footer offers Undo after saving; ⌘Z and ⌘⇧Z also undo and redo the update. The one-line purpose under the name edits in place.

A saved view with a detached or deleted field names the remembered field and offers Remove from view. Results pause instead of showing an empty result or a raw identifier. Removing the field clears its filters, sorts, columns, grouping and phone card references, and saves the repaired view. Undoing the field change restores the original recipe.

A type with a required field that some rows lack adds `· 3 need author` after the member count, counted within the table's own query. It adds that field's `is empty` filter to the filters already set. An empty required cell reads faint mono `needed`.

A type shares `Index N`, `Table N`, `Fields N` and `Cards N` tabs with its [index](notes.md#finding-aid) and template registers. Index and Table count the query retained when switching modes, not the unfiltered type total; Index counts notes only. Fields switches the same pane to that type's ordered template; its type crumb opens the ordinary type page.

### Delete view

Delete view confirms that rows are not deleted unless Ask before deleting views is off in [Settings](settings.md#preferences). Library, task and table views all offer Undo for ten seconds after deletion; restoring a view keeps its name and query.

After deleting a table view, its confirmation closes and the table keeps the query with View deleted and Undo. The pane stops reading the deleted view until it is restored.

### Embedded views

A saved view's menu offers Embed on page…. Its page picker inserts an ordinary reference block and opens it on that page. `/Embed view` and Commands offer the same saved views while writing.

An embed follows the saved query, columns, sorts, groups and layout, with twelve visible rows and Show all N to open the full view. Editing an ordinary field uses its canonical value block and one undo; derived attributes remain read-only. Committed workshop changes update the result. Phone cards use the saved card fields.

Enter returns focus to the committed cell before its save finishes. ⌘Z then undoes that commit, even when it created the field's first entry and value.

### Toolbar

The source chip, Search rows, Filters, Sort, Group and Columns align to the register. Applied filter and numbered sort chips sit beneath the controls and remove with their own ×. Chips wrap on narrow panes. A new sort follows the existing keys rather than replacing the primary key. Its left arrow raises its priority.

Sort, Group and Filters list the type template's fields first, then built-in attributes, then the workshop's other fields. Sort and Group head each run with its section and check the fields in use; choosing a sorted field again flips its direction. Filters names each field's kind at the row's end.

Filter and sort chips wait for field definitions before naming their fields, so loading does not briefly label a saved field as missing.

Filters offer conditions by kind. Choice and Relation offer **is**, **is not**, **has a value** and **is empty**; Choice selects an existing option, while Relation selects a member of the field's target types. Text, URL and Identifier also offer **contains** and **has the field**; Number and Date add **>**, **≥**, **<** and **≤**. Checkbox offers **is checked** and **is not checked**. **Has the field** means an entry exists, even blank; **has a value** means at least one authored value is nonblank, including problem readings; **is empty** means none is nonblank. Presence is offered separately on scalar kinds, not on Choice, Relation or Checkbox. Relation filters store target IDs and their chips follow current labels. A legacy unresolved value is marked in the picker and needs a target selection.

Each picker lists the source's attributes before its fields. Holder, Subject, Parent question, Program, Creator and other relation attributes use the same picker as relation fields. Choice attributes offer their written options. Date conditions offer Today, 30 days ago, A week from now or a written date. Before and After also offer Or empty. Relative dates stay relative in saved views.

Choice sorts follow the options' order on the field page, first option first when ascending. Problem values follow all options and empty values come last in either direction. Relation fields sort by their target labels, not authored reference labels.
Title sorts use the finding aid's case- and diacritic-folded filing key, placing accented Latin titles with their base letters.


Span sorts compare start year, then end year. Open starts sort first and open ends last among equal starts. Unreadable and empty values follow readable spans. Span filters offer overlaps, before and after; overlap includes both boundary years. Cells keep the authored notation.

Group offers attributes and fields, except Title, which would make every row its own group. A heading shows its label and distinct row count; clicking it collapses or reopens its rows. Collapsed heading keys travel with the saved recipe.

### Perspective layouts

Layout offers Table, Register and Matrix beside Group. Register and Matrix require Perspectives; other sources show the reason beside their unavailable choices. Old views remain Table.

Register starts grouped by Subject, with Holder also available in Group. Each perspective slip leads with its siglum and holder, then its standfirst sentence, an aligned attribute and citation bed, full-width prose and labeled argument relations. Open perspective zooms into the perspective; the subject link opens its original page or question.

Click a value or focus it and press Enter to edit. Values use the field bed's kind pickers and the outline's text editor. Tab and Shift-Tab commit the current value and fill the next or previous field in recipe order. Shift-Enter adds a newline; Enter on an empty value and Escape leave the editor. Each committed value has one undo in its original page history.

Live result refreshes keep the row's editor and focus. Clicking an empty value writes its entry and text together at commit, so one undo removes both. Tab filling creates a missing recipe slot when reached.

Matrix shows one sheet per subject, with holders as rows and criteria as columns. This keeps six perspectives and three criteria readable without six narrow prose columns. Cells use the existing Compare matrix editor, references and undo. A subject without criteria explains how to add them in Compare; an empty result offers the table's Clear filters action.

On phones the register's labels stack above values. Matrix rows become holder slips with a labeled cell for each criterion. Every value stays within the pane instead of scrolling the document sideways. Saving and reopening keep the layout with the other recipe choices.


### Grid

Apparatus headers are sticky on `--canvas`, with the title sticky at the left. Cells are 13 px; rows are at least 28 px, divided by horizontal rules and one edge beside the title. The title cell is Piazzolla, the same voice as a page title. Gloss and other authored cells stay in Plex.

| Value | Appearance |
| --- | --- |
| Titles | Piazzolla at the cell size. The faint `in <page>` line under a block title stays mono. |
| Numbers and counts | Right-aligned tabular mono. |
| Dates | Left-aligned mono. |
| Choices | Quiet pills. |
| Relations | Gilt pills. |

Source values keep the first authored label and hostname, with a named derived Refs column opening every original URL destination. Labels can be Markdown links or `Title: URL`; bare URLs use their hostname/path. Remaining prose stays visible, and invalid readings retain their warning.

Note and tagged non-page members share the same grid and field cells, ordered notes first and then blocks while retaining query order within each kind. Only a mixed register inserts a full-width mono Tagged blocks row with its count and a hairline above; a block-only register needs no divider. Block titles use the same three-line clamp and More/Less expansion as note titles, followed by a faint apparatus `in <page title>` line (the journal date for journal pages). A run of blocks from one page names it on the first row only. A group heading or the Tagged blocks row starts a new run. Titles reuse the outline's quiet card display: direction arrows are faint and cloze answers have a dotted underline.

Columns past the right edge fade under the rows. `+N ›` at the header's end counts them and scrolls to them.

### Editing

Enter or double-click edits a single plain text, number, URL or identifier value inline. A cell with one value or none of kind choice, relation or date opens that kind's [value editor](../design.md#field-entries) on the cell, and a checkbox cell toggles on click or Space, keeping focus. Editing a missing field creates its entry on that owner, including a position, question or highlight block. Choosing an option writes a reference to that option, as in `Field:: [[option]]`. This works for non-template columns too. Pills follow the outline: a choice pill opens its options and a relation pill opens its target. ⌘-click opens either beside (Ctrl-click off Mac). Cells with more than one value open the field's source outline beside the table. Attribute cells are read-only.

Inline text editors keep authored line breaks. Shift-Enter adds a newline; Enter commits the value and returns focus to its cell before saving finishes. An immediate undo follows that save. Leaving with Tab or a click commits without taking focus back from the new target.

Cell focus follows the member and field, whether a note or a tagged block, so an edit that re-sorts the table keeps the keyboard on that member's value.

Changing the column selection returns the grid to its left edge. Entering an inline editor preserves that scroll position; keyboard focus reveals its cell beside the sticky title and below the sticky header. Committing keeps the focused cell visible, including at the bottom of the grid.

⌘Z and ⌘⇧Z in the table undo and redo its value edits. Repeated Undo and Redo are applied in the order pressed, including while a previous save or history step is pending. Clearing a value preserves its block and child notes; refilling reuses a blank value block. Inline editors do not replace structured text with a rendered label.

### Managing rows

Type tables offer New type… (using the type's name) in their header; an untyped Questions register offers New question…. Both open the shared creation slip with its kind locked. It creates and files a typed page or question in one change, or files an existing page. Creating a page joins the table's undo history as one step: ⌘Z removes the page, its children and its memberships; redo restores the same page and child IDs.

Creation stays in the table, reveals the row and focuses the first empty editable field after Title, opening its inline editor or kind picker. Checkboxes receive focus without toggling. Read-only attributes are skipped; phone cards and rows without an empty editable field keep title focus. Shift+Enter opens beside with the new page's body caret; on coarse layouts with two visible panes this is the default. A new page excluded by the current query gets an Open note notice instead of changing the filters.

Each row's titled actions menu offers Open, Open beside, Rename… and Delete… last. It names the row and becomes a bottom sheet on coarse phones. Rename edits the title in its cell; F2 on a focused title does the same. Enter or leaving the input saves, Escape cancels, and the change joins the table's undo history. Ordinary title click and Enter still open the row. Delete confirms the page and all its blocks, or the tagged block and its children, and offers Undo using the page-deletion toast or the table's block history.

### Columns

Columns start with the type template's fields, then fields present on all members of the type or the view's base membership, including blank entries. Search rows, filter predicates and pagination never remove or reorder these columns. Field-only views use owners of any named filter field as their base membership. Fields used by filters remain available even when every value is empty.

New entity views start with the source's key attributes, its standfirst fields, then fields filled on at least a quarter of the first result's rows. There are at most six starting columns, including Title and derived Refs. Perspectives start with Holder and Subject; Questions with State, Perspectives, Last assessed and Revisit; Sources with Creator; Highlights with Source. Saved recipes keep their chosen columns.

Columns hides or restores attributes, fields and derived Refs. Title only starts a compact selection. Find columns narrows the choices without changing the recipe. Column headers drag into order; their menus also offer Move left and Move right. A header's hover band and click target fill its column to within 4 px of each rule. Dragging a header's edge resizes it. The sticky title stays first and is 170 to 340 px wide, 240 by default. Chosen columns and widths belong to the query recipe and never change the type template. Search and filtering retain them. Older views without a recipe start with their existing pane-local visibility.

With text in Find columns, Only these selects the matching columns together, keeping widths and order for columns already selected.

Derived Refs sit beside their visible backing field. Hiding the field also hides its Refs. The separate Refs toggle stays pane-local and is never a saved column key.

Column menus contain sort, filter and hide. Edit field opens the field page and its reviewed kind-change map. Remove from template is separate. Add field to type template and Open type template remain explicit actions.

### Footer

The footer has a persistent `N of M members` (`1 of 1 member`) readout, followed by `· Show 500 more` while more results remain. Appending retains the loaded rows, scroll position, sort and filters; the action disappears when every result is loaded.

Queries page by a zero-based offset with block ID as the deterministic ordering tie-breaker. Totals cover all matches rather than one batch; column metadata covers the base membership before search and filters. Tagged block members count toward both totals rather than disappearing from membership. Load errors stay in the footer.

### Empty states

An empty result names the source and the conditions that excluded its rows. Clear filters removes search, field and link conditions without dropping the chosen columns, sorts or grouping. A source with no rows and no conditions says that it has none yet.

### Opening and selection

| Input or layout | Behavior |
| --- | --- |
| Desktop title click or Enter | Opens the entity in its original place. Tables fill the pane to the right when one exists; otherwise they use their own pane. A perspective opens its dossier, a question its block and a highlight its passage. ⌘-click or ⌘Enter opens beside (Ctrl-click or Ctrl+Enter off Mac). |
| Selected row | Gilt left bar and an explicit open-beside affordance. |
| Coarse pointer at least 900 px wide | A row tap opens the canonical note or block beside by default. |
| Coarse pointer below 600 px of pane width | Becomes the cover ledger with a query sheet. |

### Cover ledger and query sheet

On coarse pointers below 600 px of available pane width, compact ledger rows replace the grid without lateral scrolling. The title and mode tabs scroll away with the rows. One mono summary beneath the title describes the count, conditions, sorts and grouping; a changed saved recipe ends with Modified in gilt. An empty purpose stays hidden; Add purpose… in the title menu opens its editor, and a set purpose remains below the title.

Notes and tagged blocks share the same ordered list, with the counted apparatus divider only for mixed membership. Each row shows its Piazzolla title and `in <page title>` beneath a block title, named once per run of blocks from one page. Gloss values clamp to two lines without their labels. Choice and instance pills also omit labels; other values retain mono labels on one line. The grouped field hides inside its own groups, whose counted hairline headings stick while scrolling. The whole row opens the note, with field taps still opening their canonical entries and refs opening the destination list.

A fixed bar above the bottom navigation holds Find in the type's plural and Query N. N counts active text, link conditions, filters, sorts, grouping and a non-default source. Query opens a bottom sheet containing the existing finder, source, filters, sort, group, layout, columns and Phone card fields controls. Save changes and Revert changes appear at its foot when a saved view differs, and remain in the title menu. Done closes the sheet. Pagination, load errors and Undo remain available at the end of the rows.

Columns chooses Phone card fields; every sort field is always included except the field already named by its group heading. A view without a card recipe uses the first visible non-empty choice and Source or first reference, falling back to other visible values. Filters uses its own sheet with 44 px targets and an explicit Apply. Draft selections leave the rows and totals unchanged; saving the named view remains separate. Saving and reopening restore columns, widths, sort priority, grouping, collapsed headings, card fields and purpose, including after a reload. At least 600 px of pane width and fine pointers retain the existing header, toolbar and grid.
