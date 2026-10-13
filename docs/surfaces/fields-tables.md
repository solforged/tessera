# Fields, types and tables

Fields defines the notebook's fields and type templates. Tables show a query as rows: a type's members or a saved view.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Fields register

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
- Shift opens any of these beside the index.
- Narrow panes scroll the table horizontally with Name held in place.

New field asks for Name and Kind together, defaults to Text, and refuses duplicates and the characters `Name::` shorthand refuses. Creating the definition and its chosen kind is one undoable edit; redo restores the same definition.

Filtering the index does not change definitions; an empty result offers Clear filter.

## Field pages

A field page is a specimen sheet on the outline measure, crumbed `Fields / Name`. Under the Piazzolla name sit a mono summary (`Choice · 7 owners · 9 values`) and Rename. Kind, Links to for instance fields, and Hide follow as rows. Hide offers Never, When empty and Always, with one muted line saying what the current choice does; changing it is one undoable edit on the field. The [field menu](../design.md#field-entries) in any note opens this page, at the kind preview, Options or Links to.

Rename refuses another field's name under the same case-insensitive rule as New field.

Numbered sections follow with rubric numerals and hairlines:

| Section | Contents and actions |
| --- | --- |
| Options | Options with their uses and inline rename, then Add option; choice fields only. Option names may wrap; Uses and Edit retain their intrinsic one-line width, including on phones. |
| In templates | Each type's pill, the field's place in its template and the member count. |
| Used by | Up to twelve owners in three columns with their values in mono. View owner (one owner) or View all N owners opens the field-only table. |
| Problem values | The written text in rubric beside its owner and the problem. |

Blocks in the pane header opens the definition in the Fields page, where names and options remain ordinary blocks. Edit definitions opens the Fields page.

## Kind changes

Changing kind never applies at once. Choosing a kind on the page, in the inspector or from a register row shows a preview first: `4 of 6 values won't read as Number`, with the counts in rubric mono and a rubric rule at its left. The preview then shows the values that will become problems and those that will read, each with its owner and its reading after the change.

Apply kind change is one undoable edit that keeps every value's text. Cancel returns to the page.

## Links to

Instance definitions show **Links to** below Kind, both on their page and in the Fields inspector. The type checklist applies as one undoable change; no selected type reads **Any page**. A reference outside the selected types stays written and reads as a problem.

Library Author, Editor and Translator start with Person and Group targets. Import and the one-time notebook backfill file untyped creator pages as Person without changing pages already filed elsewhere.

Metadata suggestions, field-slot pickers and value pickers for such a field show members of the target types. Titles and aliases match with the notebook's name folding; an exact alias match does not offer duplicate creation. A query that names none of them exactly offers **Create person “Name”** and **Create group “Name”**, creating and filing the page together.

## Type page template

A type page shows its template under the title as a Template section, closed by default, headed like the [journal's sections](journal.md#today-tiles): the name, a hairline, the template's fields in mono order and a chevron.

Open, it lists the fields with their kinds. On hover or focus each row offers Move up, Move down and Remove. Add field opens the field picker without the fields already there.

Under the list sits a count of the members that lack template fields and Fill missing fields. This gives each of them an empty entry for every template field it lacks, placed in template order, in one notebook command. Undo beside the result removes the entries it added that are still empty; an entry that gained a value or a note stays. Changing the template never rewrites members.

## Type fields tab

The type's Fields tab opens its template as a third in-pane view, with the same Index, Table and Fields strip and live counts. Its bounded register lists Name, Kind and Used by in template order. Usage counts are notebook-wide distinct owners, including empty entries. Names open their field pages.

Move up, Move down and Remove appear on hover or focus and remain visible on coarse pointers. Add field and Fill missing fields keep the type page's editing behavior. The underlined type crumb opens the ordinary type page; the global Fields register remains separate.

## Tables and views

A table is a query shown as rows: a type's members or a saved view.

### Register and header

The heading, mode strip, toolbar, grid and footer share a centered 984 px register (`--measure + --apparatus-width - --space-16`). It widens only when the visible fields need more room and never exceeds the pane's inset width. They keep one left edge rather than centering a narrower heading inside a wider grid. A many-column grid scrolls horizontally inside that register with the title held at the left.

The type and Register sit in quiet apparatus above a Piazzolla view name. Its menu lists All members of the type and its saved views, then Save as, Rename and Delete separately. Named views store the query only. Query changes show Unsaved changes with Save and Discard; switching views keeps pane-local presentation.

A type shares `Index N`, `Table N` and `Fields N` tabs with its [index](notes.md#finding-aid) and template register. Fields switches the same pane to that type's ordered template; its type crumb opens the ordinary type page.

### Delete view

Delete view confirms that rows are not deleted unless Ask before deleting views is off in [Settings](settings.md#preferences). Library, task and table views all offer Undo for ten seconds after deletion; restoring a view keeps its name and query.

### Toolbar

Search rows, Filters, Sort and Columns align to the register. Applied filter and sort chips sit beneath the controls and remove with their own ×. Chips wrap on narrow panes.

For an instance field, **is** and **is not** choose a page from the field's target types. The filter stores that page's ID and its chip follows the current title. A legacy unresolved value is marked in the picker and needs a page selection.

### Grid

Apparatus headers are sticky on `--canvas`, with the title sticky at the left. Cells are 13 px; rows are at least 28 px, divided by horizontal rules and one edge beside the title.

| Value | Appearance |
| --- | --- |
| Numbers and counts | Right-aligned tabular mono. |
| Dates | Left-aligned mono. |
| Choices | Quiet pills. |
| Instances | Gilt pills. |

Source values keep the first authored label and hostname, with a named derived Refs column opening every original URL destination. Labels can be Markdown links or `Title: URL`; bare URLs use their hostname/path. Remaining prose stays visible, and invalid readings retain their warning.

Tagged non-page members appear in a separate counted Tagged blocks section. Their text is clamped to three lines, with source-page context and an Open action that shows the whole block.

Columns past the right edge fade under the rows. `+N ›` at the header's end counts them and scrolls to them.

### Editing

Enter or double-click edits a single plain text, number, URL or identifier value inline. A cell with one value or none of kind choice, instance or date opens that kind's [value editor](../design.md#field-entries) on the cell, and a checkbox cell toggles on click or Space, keeping focus. Pills follow the outline: a choice pill opens its options, an instance pill opens its page, and Shift opens either beside. Cells with several values open the field's source outline beside the table.

Inline text editors keep authored line breaks. Shift-Enter adds a newline; Enter commits the value.

Cell focus follows the note and field, so an edit that re-sorts the table keeps the keyboard on that note's value.

⌘Z and ⌘⇧Z in the table undo and redo its value edits. Clearing a value preserves its block and child notes; refilling reuses a blank value block. Inline editors do not replace structured text with a rendered label.

### Columns

Columns start with the type template's fields, then fields present on members. Fields used by filters remain available even when every value is empty.

Columns hides or restores fields and derived Refs, and sets the sticky title width from 170 to 340 px (240 by default). Visibility, title width and horizontal scroll belong to pane history and survive back/forward and reload. They do not change the saved query or type template. Visible fields also determine card priorities.

Column menus contain sort, filter and hide. Edit field opens kind/template operations separately. Add field to type template and Open type template remain explicit actions.

### Footer

The footer has a persistent `N of M members` (`1 of 1 member`) readout, followed by `· Show 500 more` while more results remain. Appending retains the loaded rows, scroll position, sort and filters; the action disappears when every result is loaded.

Queries page by a zero-based offset with block ID as the deterministic ordering tie-breaker. Totals and column metadata cover all matches rather than one batch. Tagged block members count toward both totals rather than disappearing from membership. Load errors stay in the footer.

### Empty states

Empty states distinguish an empty note section from the separate tagged-block section.

### Opening and selection

| Input or layout | Behavior |
| --- | --- |
| Desktop title click or Enter | Keeps the current-pane behavior; Shift opens beside. |
| Selected row | Gilt left bar and an explicit open-beside affordance. |
| Coarse pointer at least 900 px wide | A row tap opens the canonical note beside by default. |
| Narrow table pane on that unfolded screen | Becomes a touch-sized row list while keeping its query controls. |

### Cover cards

On coarse pointers below 600 px, cards replace the grid without lateral scrolling. Each shows its title, the first visible non-empty choice and Source or first reference, falling back to other visible values when absent, plus the derived refs count. Field taps open their canonical entries; refs open the destination list.

Filters, Sort and Columns form a bottom toolbar above the nav and bottom inset. Filters uses a sheet with 44 px targets and an explicit Apply. Draft selections leave the rows and totals unchanged; saving the named view remains separate.
