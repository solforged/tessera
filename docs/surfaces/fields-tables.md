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

A field page is a specimen sheet on the outline measure, crumbed `Fields / Name`. Under the Piazzolla name sit a mono summary (`Choice · 7 owners · 9 values`) and Rename. Kind, Links to for instance fields, Hide and Role follow as rows. Hide offers Never, When empty and Always, with one muted line saying what the current choice does. Role offers Standfirst, Attribute, Prose and Citation, with a sentence explaining its presentation. Each change is one undoable edit on the definition. The [field menu](../design.md#field-entries) in any note opens this page, at the kind preview, Options or Links to; its Role menu offers the same choices.

Rename uses New field's case-insensitive duplicate rule. An existing name opens Merge into with affected owners, pages, templates, saved views and conflicting values. Apply keeps conflicts as separate entries under the surviving definition and redirects every saved recipe to that definition. Column widths and collapsed groups are preserved. Undo restores the original fields and exact saved recipes.

Delete definition opens an impact preview, listing affected views by name. Archive keeps values and views readable and hides the definition from pickers. Merge into opens the same merge preview. Detach keeps values as ordinary `Name: value` blocks with their child notes. Delete values requires a separate confirmation checkbox. Every action offers one Undo, including detaching or deleting an archived definition.

Numbered sections follow with rubric numerals and hairlines:

| Section | Contents and actions |
| --- | --- |
| Options | Options with their uses and inline rename, then Add option; choice fields only. Option names may wrap; Uses and Edit retain their intrinsic one-line width, including on phones. |
| In templates | Each type's pill, the field's place in its template and the member count. |
| Used by | Up to twelve owners in three columns with their values in mono. View owner (one owner) or View all N owners opens the field-only table. |
| Problem values | The written text in rubric beside its owner and the problem. Choice rows offer Make option: create or reuse the matching option and link every matching value in one undoable change. The help reads “Make it an option, or open its owner to edit it.” |

Blocks in the pane header opens the definition in the Fields page, where names and options remain ordinary blocks. Edit definitions opens the Fields page.

Choice and instance value pickers check the current value, expose it as selected and start the keyboard cursor there. An unmatched choice query offers `Add option “Y”`; adding the option and selecting it are one undoable change, including in tables. A note's Add field picker offers `Create text field “X”` and `Create field “X” as…`; the latter opens Text, Number, Date, Span, Checkbox, Choice, Instance, URL and Identifier. The definition, chosen kind and entry are created together. A new Choice field opens its value picker so its first option can be added there.

Creating a definition always uses a new block ID. Blank outline rows under Fields are not definitions and are never adopted or offered by field pickers.

## Kind changes

Changing kind opens an interpretation map on the field page before applying. Register rows, the inspector and a note's field menu open the same map. It lists every distinct written value and its use count under Mapped values, Readable as written, or Ambiguous or unreadable.

Choice rows have an editable option name and a mapping checkbox. Existing options are reused; several written values can share one name. Unchecking a row leaves it as written. Instance rows propose a page only when its title or alias matches exactly and uniquely. Choose page adjusts the target; Create page explicitly requests creation during Apply. Other kinds show their readings, including inclusive year bounds for Span.

Apply changes the kind and all reviewed mappings in one undoable edit. Unmapped values stay as written and show a problem when unreadable. Owners and child notes stay in place. Cancel writes nothing.

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

## Field bed

An owner's populated fields stay visible at rest. Standfirst sentences lead, without labels. Attributes and citation fields share a compact label and value column; citation references show siglum · locator. Prose fields follow at full width. Empty template and recipe slots stay quiet until the owner or one of its fields is focused. On phones, labels stack above values and long text wraps within the measure.

A value click, or Enter on a selected field, begins filling that owner. Tab and Shift-Tab move through its fields and missing slots in template or recipe order; reaching a missing slot creates its entry and value. Shift-Enter adds a newline. Enter on an empty value leaves for the owner's next ordinary row; Escape leaves without moving. Outside filling mode, Tab and Shift-Tab retain outline indent and outdent. Each value keeps its ordinary undo history.

For a position, Add field begins with From this recipe: missing Gist, Work, then the subject's explicit or derived criteria. The recipe suggests, never requires.

## Tables and views

A table is a query shown as rows. New view… in the sidebar or Commands asks for Notes, Questions, Positions, Sources, Tasks or Highlights first. The first toolbar chip names the source and changes it. Existing type tables and note views keep their scope.

### Register and header

The heading, mode strip, toolbar, grid and footer share a centered 984 px register (`--measure + --apparatus-width - --space-16`). It widens only when the visible fields need more room and never exceeds the pane's inset width. They keep one left edge rather than centering a narrower heading inside a wider grid. A many-column grid scrolls horizontally inside that register with the title held at the left.

The type and Register sit in quiet apparatus above a Piazzolla view name. Its menu lists all members of the source or type and its saved views, then Save as view…, Rename and Delete separately. A checkmark means the current query and recipe equal that row's saved query, not merely that the view is open. When they differ, the open row shows faint mono Modified; Save changes updates a saved view in one undoable edit, and Revert changes restores its saved query and recipe. The footer offers Undo after saving; ⌘Z and ⌘⇧Z also undo and redo the update. The one-line purpose under the name edits in place.

A saved view with a detached or deleted field names the remembered field and offers Remove from view. Results pause instead of showing an empty result or a raw identifier. Removing the field clears its filters, sorts, columns, grouping and phone card references, and saves the repaired view. Undoing the field change restores the original recipe.

A type shares `Index N`, `Table N` and `Fields N` tabs with its [index](notes.md#finding-aid) and template register. Fields switches the same pane to that type's ordered template; its type crumb opens the ordinary type page.

### Delete view

Delete view confirms that rows are not deleted unless Ask before deleting views is off in [Settings](settings.md#preferences). Library, task and table views all offer Undo for ten seconds after deletion; restoring a view keeps its name and query.

### Toolbar

The source chip, Search rows, Filters, Sort, Group and Columns align to the register. Applied filter and numbered sort chips sit beneath the controls and remove with their own ×. Chips wrap on narrow panes. A new sort follows the existing keys rather than replacing the primary key. Its left arrow raises its priority.

Filters offer conditions by kind. Choice and Instance offer **is**, **is not**, **has a value** and **is empty**; Choice selects an existing option, while Instance selects a page from the field's target types. Text, URL and Identifier also offer **contains** and **has the field**; Number and Date add **>**, **≥**, **<** and **≤**. Checkbox offers **is checked** and **is not checked**. **Has the field** means an entry exists, even blank; **has a value** means at least one authored value is nonblank, including problem readings; **is empty** means none is nonblank. Presence is offered separately on scalar kinds, not on Choice, Instance or Checkbox. Instance filters store page IDs and their chips follow current titles. A legacy unresolved instance value is marked in the picker and needs a page selection.

Each picker lists the source's attributes before its fields. Holder, Subject, Parent question, Program, Creator and other instance attributes use the same page picker as instance fields. Choice attributes offer their written options. Date conditions offer Today, 30 days ago, A week from now or a written date. Before and After also offer Or empty. Relative dates stay relative in saved views.

Choice sorts follow the options' order on the field page, first option first when ascending. Problem values follow all options and empty values come last in either direction. Instance fields sort by their target titles, not authored reference labels.

Span sorts compare start year, then end year. Open starts sort first and open ends last among equal starts. Unreadable and empty values follow readable spans. Span filters offer overlaps, before and after; overlap includes both boundary years. Cells keep the authored notation.

Group offers attributes and fields. A heading shows its label and distinct row count; clicking it collapses or reopens its rows. Collapsed heading keys travel with the saved recipe.

### Grid

Apparatus headers are sticky on `--canvas`, with the title sticky at the left. Cells are 13 px; rows are at least 28 px, divided by horizontal rules and one edge beside the title.

| Value | Appearance |
| --- | --- |
| Numbers and counts | Right-aligned tabular mono. |
| Dates | Left-aligned mono. |
| Choices | Quiet pills. |
| Instances | Gilt pills. |

Source values keep the first authored label and hostname, with a named derived Refs column opening every original URL destination. Labels can be Markdown links or `Title: URL`; bare URLs use their hostname/path. Remaining prose stays visible, and invalid readings retain their warning.

Note and tagged non-page members share the same grid and field cells, ordered notes first and then blocks while retaining query order within each kind. Only a mixed register inserts a full-width mono Tagged blocks row with its count and a hairline above; a block-only register needs no divider. Block titles use the same three-line clamp and More/Less expansion as note titles, followed by a faint apparatus `in <page title>` line (the journal date for journal pages). Titles reuse the outline's quiet card display: direction arrows are faint and cloze answers have a dotted underline.

Columns past the right edge fade under the rows. `+N ›` at the header's end counts them and scrolls to them.

### Editing

Enter or double-click edits a single plain text, number, URL or identifier value inline. A cell with one value or none of kind choice, instance or date opens that kind's [value editor](../design.md#field-entries) on the cell, and a checkbox cell toggles on click or Space, keeping focus. Editing a missing field creates its entry on that owner, including a position, question or highlight block. Choosing an option writes a reference to that option, as in `Field:: [[option]]`. This works for non-template columns too. Pills follow the outline: a choice pill opens its options, an instance pill opens its page, and Shift opens either beside. Cells with several values open the field's source outline beside the table. Attribute cells are read-only.

Inline text editors keep authored line breaks. Shift-Enter adds a newline; Enter commits the value.

Cell focus follows the member and field, whether a note or a tagged block, so an edit that re-sorts the table keeps the keyboard on that member's value.

⌘Z and ⌘⇧Z in the table undo and redo its value edits. Clearing a value preserves its block and child notes; refilling reuses a blank value block. Inline editors do not replace structured text with a rendered label.

### Columns

Columns start with the type template's fields, then fields present on all members of the type or the view's base membership, including blank entries. Search rows, filter predicates and pagination never remove or reorder these columns. Field-only views use owners of any named filter field as their base membership. Fields used by filters remain available even when every value is empty.

Columns hides or restores attributes, fields and derived Refs. Title only starts a compact selection. Find columns narrows the choices without changing the recipe. Column headers drag into order; their menus also offer Move left and Move right. Dragging a header's edge resizes it. The sticky title stays first and is 170 to 340 px wide, 240 by default. Chosen columns and widths belong to the query recipe and never change the type template. Search and filtering retain them. Older views without a recipe start with their existing pane-local visibility.

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
| Desktop title click or Enter | Opens the entity in its original place; a position opens its dossier, a question its block and a highlight its passage. Shift opens beside. |
| Selected row | Gilt left bar and an explicit open-beside affordance. |
| Coarse pointer at least 900 px wide | A row tap opens the canonical note or block beside by default. |
| Narrow table pane on that unfolded screen | Becomes a touch-sized row list while keeping its query controls. |

### Cover cards

On coarse pointers below 600 px, cards replace the grid without lateral scrolling. Notes and tagged blocks share the same ordered list, with the counted apparatus divider only for mixed membership. Each shows its title and `in <page title>` beneath a block title. Columns also chooses Phone card fields, which keep their labels; every sort field is always included. A view without a card recipe uses the first visible non-empty choice and Source or first reference, falling back to other visible values. Field taps open their canonical entries; refs open the destination list. Group headings and collapsed state stay the same as on the grid.

Filters, Sort, Group and Columns form a bottom toolbar above the nav and bottom inset. Filters uses a sheet with 44 px targets and an explicit Apply. Draft selections leave the rows and totals unchanged; saving the named view remains separate. Saving and reopening restore columns, widths, sort priority, grouping, collapsed headings, card fields and purpose, including after a reload.
