# Design

How the browser client looks and behaves. Tokens live in `web/src/tokens.css`; components use tokens, never raw values. Orrery gives the notebook a midnight desk, an ink-blue canvas and gilt focus. Reference slips, registers and reading sheets carry the same type hierarchy into floating and comparative surfaces.

Status: applied to the shell, the outline and the table. The permanent global rail and inset workspace are being evaluated in the running app. Later stages add their sections here before they are built.

## Principles

1. **The text is the interface.** Controls stay quiet until hover, focus or selection, and every action is also reachable from a visible control.
2. **Act where you are looking.** Controls attach to the block they affect. Popups open at the caret or at their trigger, never at a pane edge.
3. **One meaning, one form.** Structure is a neutral bullet. A type is a tinted pill with its name. Task state is a glyph. Colour never carries meaning alone, and type hues never reuse status hues.
4. **Work happens in panes.** Tables, views, fields, settings, search results and references open in a pane. Dialogs are for short controls and confirmations only.
5. **Summaries in the row, details on selection.** A block shows its state as compact trailing metadata; field rows appear as children under it.
6. **Calm by night and day.** A midnight shell frames the ink-blue canvas, or a vellum one by day. Gilt marks focus and primary actions. Only floating layers cast shadows.
7. **Built for long sessions.** 28 px rows, 15 px writing, a 760 px measure. Apparatus is 11.5 px; other labels start at 12 px.
8. **Keyboard and pointer parity.** Menus show shortcuts beside actions. Vim is optional.

## Tokens

### Type

Three voices separate writing from publication and apparatus. IBM Plex Sans Variable is bundled for your writing, inputs and ordinary controls. Piazzolla Variable is bundled in normal and italic for page titles, heading rows, library titles, displayed highlights, quotes and the reader. Writing and title editing stay in Plex. Berkeley Mono is used when installed, with system monospace fallbacks. Its commercial font files are not bundled.

Apparatus uses `--apparatus`: 400 at 11.5 / 16, with tabular numerals and slight tracking. It covers breadcrumbs, save state, Vim mode, sidebar section headings, picker metadata, counts, progress and resurfaced metadata. UI labels stay in sentence case. Key hints (`⌃⇧F`, `⇧↵`, `Space`) keep the apparatus size in the sans voice. Plex has no modifier glyphs, so `web/src/ui/keys.css` adds a face to the Plex family with ⌃ ⇧ ⌘ ⌥ ↵ and the four arrows, drawn by `scripts/build-key-font.py` at Plex's cap height and stem; without it each system's fallback drew them, at mismatched sizes on Android.

| Token | Size / line | Use |
|---|---|---|
| `--text-apparatus` | 11.5 / 16 | Apparatus in Berkeley Mono |
| `--text-meta` | 12 / 16 | Pills and labels |
| `--text-control` | 13 / 18 | Buttons, menus, sidebar, table cells |
| `--text-body` | 15 / 24 | Writing and inputs in Plex |
| `--text-quote` | 16 / 24 | Quotes and displayed highlights in Piazzolla |
| `--text-h3` | 16 / 24 | Heading 3 |
| `--text-h2` | 18 / 26 | Pane and section titles |
| `--text-outline-h2` | 19 / 26 | Heading 2 in the outline |
| `--text-h1` | 24 / 30 | Heading 1, view and dialog headings |
| `--text-title` | 32 / 38 | Page titles in Piazzolla |

Piazzolla page titles use weight 430 and optical size 30. Heading rows use weight 480 and optical size 20. Quotes use optical size 16; the reader uses 17.

### Space and size

Steps 2, 4, 8, 12, 16, 24, 32, 48 px. Row height 28 px; indent 24 px; measure 760 px; gutter 48 px left of the measure; sidebar 208 px; global rail 48 px; pane header 36 px. Pointer targets 24 px, touch targets 44 px. Icons 16 px, 14 px inline.

### Colour

Orrery uses midnight `--shell` (#0a0d13), ink-blue `--canvas` (#0e121a), parchment `--text` (#e6e1d6) and gilt `--accent` (#d8aa55). Muted text is cool grey. Rubric red `--danger` (#d97a6b) marks danger and short insertion rules; `--warning` is warm orange. Doing and scheduled work are blue; done is sage. Type and highlight hues stay separate from these roles.

Orrery by day is the light theme: the same roles on vellum, a `--canvas` of #f8f5ee inside a #ebe5d8 shell, ink `--text` (#1f1b15), antique gold `--accent` (#93650f), oxblood `--danger` (#ad3a2b) and a deeper steel blue. It overrides colour tokens only, under `:root[data-theme="light"]`; type, space and shape never change, and reader figures are not dimmed. Settings › Appearance chooses System (the default, following the operating system), Light or Dark per device, stored in local storage rather than the notebook. The entry imports `shell/theme.ts` first so the page paints in the right theme, and `index.html` paints the system theme before any script runs.

| Role | Token |
|---|---|
| Shell: global rail and sidebar | `--shell` |
| Table headers and banners | `--surface` |
| Canvas: panes | `--canvas` |
| Raised: popups, pills, chips | `--raised` |
| Hover, selection, divider, control border | `--hover` `--selection` `--line` `--control-border` |
| Selected text, in the editor, static rows and the reader | `--text-selection` |
| Text primary, secondary, tertiary | `--text` `--muted` `--faint` |
| Gilt accent and focus ring | `--accent` |
| Warning, danger | `--warning` `--danger` |
| Type hues, pills only | `--type-1` to `--type-6` |
| Task states, stage 3 | `--status-*` |
| Highlight colours: reader tints at 24%, dots at full strength | `--highlight-yellow` `-green` `-blue` `-red` `-purple` |

Pills take a 12% tint of their hue with a 30% border. A selected row adds a 2 px gilt bar at its left edge; keyboard focus inside a menu looks the same, never a ring.

Controls share four shapes. Modes and tabs (Library states, Highlights processing, Agenda, Week and Tasks, Review's Due, New and All, reader settings, a creator's role) are mono labels with faint counts; the current one is gilt with a 1 px gilt rule beneath, never a box or fill. Forms use these tabs instead of native selects. Menu triggers and date ranges are bordered buttons with a `--line` hairline that brightens to `--control-border` on hover. Text fields sit on `--surface` with a `--line` hairline that brightens while hovered or typed in; Agenda's add field is a bare row on a hairline under the plus. Section heads (sidebar, journal Agenda and Resurfaced, Settings) are mono: an optional rubric numeral, the name, a hairline rule, then state or count at the right in `--faint`, with the chevron last on collapsible ones. Counts, dates and result lines (`1 of 1 task`, `15 of 15 rows`, `1 card · 1 due`) are mono; sentences never are. Civil dates in the apparatus read as ISO, `2026-10-03`.

Focus has one frame per control. A focused text field turns its border gilt with no outer ring. A focused mode tab draws a faint rule beneath its label, thickened gilt when it is the current one. Other controls keep the gilt ring.

### Shape and elevation

Radius 2 px for controls, 3 px for popups, zero for the workspace and resurfaced slips, full for pills. Popups have a 1 px `--line` border and `--popup-shadow`; dialogs `--dialog-shadow`. The workspace frame has a 1 px `--line` border and no shadow. Rows and tables cast none.

Each pane has 9 px registration corners 4 px inside its content, clear of toolbars, gilt when active and `--line` otherwise. Popups and resurfaced cards carry a 24 × 2 px rubric mark at the top. Resurfaced cards sit on `--raised` with a bottom rule, 8 px apart; their meta line is the short source title, location and date, and Open, Keep and Mute are quiet text starting on the quote's edge. The rail notebook name has an oculus mark in gilt.

### Motion

Motion acknowledges an action without delaying it: 140 ms for popup entry and sidebar movement, 90 ms for popup exit and hover feedback, with a short ease-out and no bounce. Popups travel 4 px; toasts and the reader's selection toolbar rise the same distance. Clickable button icons scale subtly on hover, focus and press. Rows, pills and list items fade their hover fill. Fold and disclosure chevrons turn rather than swap, a menu trigger's trailing chevron turns while its menu is open, and Recent, related sections and review history expand and collapse in place. A revealed answer fades in. The save state icon turns while saving. Reduced motion sets durations and travel to zero and disables icon scaling.

## Shell

- **Voices by job.** Mono is for what the machine knows: ids, dates, counts, paths and modes. Key hints are the exception, in sans at apparatus size. Sans is for what you write and for places and actions. The serif is for what was written to be read. Glyphs mark places (Today, Agenda, Review, Library) and kinds of page; one glyph stands for one place everywhere it appears, and actions that read well as a word keep the word. Place glyphs are drawn from circles and rules like the oculus, with an optional filled hub.
- **Global rail.** Permanent across one or two panes. A three-column grid: the sidebar toggle and the Tessera wordmark with its oculus at the left (its tooltip is the notebook path), Find or create with the Commands icon in one 400 px search-shaped control centred on the window, and an icon-only Layout button at the right. Find or create shows the eye glyph and opens its picker beneath the search trigger; Commands opens the command palette. Layout opens the active view beside, switches panes, closes the active pane or toggles the sidebar. Global controls are never duplicated inside pane headers.
- **Sidebar**, 208 px. The desk has no heading: Today, Agenda, Review and Library, in `--text` with their glyphs, each with live state at the right in mono. Today shows the weekday and day; Agenda the tasks planned for today, in `--danger` when any is overdue; Review the cards due; Library the unprocessed highlights. Zero counts are left out. Counts refresh 800 ms after committed changes settle and disappear rather than go stale when a request fails. Then Pinned, shown only when a page or saved table view is pinned; unpinned saved Views; and collapsible Recent. Section headings are mono: a rubric numeral counted over the sections shown, the name, a hairline rule and a count. Saved table views have a pin control on hover or keyboard focus; pinning is stored per notebook alongside page pins. Task views and decks are selected in their own destinations. Settings sits at the foot above a hairline, with an icon-only Fields button beside it; the foot carries no notebook name or build. Rows are 28 px with one left edge at 8 px. The row for the active pane's target gets the 2 px gilt bar, the selection fill and a gilt glyph. Destinations open in the active pane; Shift-click opens beside.
- **Workspace frame.** The panes share one square inset canvas, with a 12 px outside gutter at the right and bottom. Collapsing the sidebar adds the same gutter on the left. The rail and sidebar use the same shell surface.
- **Panes.** Up to two, split equally. Each has a header: back and forward, the glyph of the place or page kind (gilt in the active pane), breadcrumbs or the pane title in mono, save state, the Vim mode when on, the page menu, and Close while split. A table pane is titled with its saved view's name, else its type's. In a narrow pane the title gives way first: ancestors such as Library keep their width up to 10em, so the header reads `Library / Discourses on…`. On journal days the page menu leaves out what only titled pages can do (Rename, Gloss, Compare perspectives, Make question) rather than listing it disabled. Saved shows as a 4 px dot with a hidden label; slow saves, offline and errors speak in sans, errors in `--danger`. The Vim mode shows only in the active pane, as a hairline-boxed mono tag of fixed width: Normal in `--text`, Insert gilt, Visual on `--selection`, and Blocks, in `--muted`, while moving between blocks. Every label is six letters, so a mode change never shifts the header. Journal headers also hold their own previous-day, calendar and next-day controls; these always target the owning pane. Page errors stay under their owning header. Notebook recovery feedback appears once above both panes, so activating a pane cannot move a control between pointer-down and click. Non-page panes (table, fields, settings, agenda, review, library, reader) share the workspace frame.
- **Narrow layouts.** Below 1048 px the sidebar becomes a toggleable overlay. Hidden navigation is inert immediately, including during its exit. Below 840 px working-pane tabs show one pane at a time. Below 600 px Find or create, Commands and Layout retain accessible labels on icon controls, and the workspace gutter shrinks to 4 px. The global rail remains visible in every layout.
- **Measure.** Outline content is at most 760 px, centred, with a 48 px gutter to its left for row controls. Two panes split the width; text never shrinks to fit.

### Find or create

One picker searches pages and blocks; a leading `>` switches to commands. A case-insensitive exact page-title match appears first, including a locally created page not yet in server search. Otherwise a non-empty query offers an explicit Create page row after the search results, even when partial matches exist. Creation errors remain in the picker with the entered title intact. Enter opens or creates in the pane that invoked the picker; Shift-Enter uses the other pane. Tab drills into a result's children and Shift-Tab returns; a drilled search never offers root-page creation. New page remains a command with a direct title form anchored below search, not a separate rail button.

## Block row

```text
 gutter            measure
 [⋮] [›]   (•)  Text of the block  #book  #source      ◷ Oct 4  3
 handle fold  bullet text         type pills              trailing
```

- **Handle** and **fold** live in the gutter and show on hover, focus and selection. The handle opens the block menu and drags. The fold is hidden on leaf rows; a collapsed block shows a ringed bullet.
- **Bullet** is a filled dot in `--faint`, 24 px target, gilt on hover and selection. Click or ⌘. to zoom (⌘⇧. zooms out), drag to move. The page title aligns with the bullet column.
- **Prose and bullets.** Journal days show bullets; titled pages read as prose. On a prose page the bullet rests hidden and returns on hover or selection, where it still zooms and drags, and a collapsed block keeps its ringed bullet. Depth shows as 1 px `--line` threads under each ancestor's bullet column. Show bullets and Hide bullets in the page menu override a page's default; overrides are stored per notebook with the pins. Editing, keys and export are the same in both.
- **Gloss.** A titled page's gloss is an entry for the built-in Gloss field among its top-level blocks, added or edited from Gloss in the page menu or the palette, which create the field and put the entry first. It reads as a standfirst under the title: Piazzolla at `--text-gloss`, muted, on the text edge, with no field label; clicking edits it, and an empty gloss says what to write. Reference preview cards show it under the page title and leave it out of their rows.
- **Depth.** Titled pages have four depths: Gloss (the gloss alone), Opening (the gloss and the top-level text before the first top-level heading), Perspectives (the opening, every heading whose parent shows, and positions directly under a shown heading, each closed to its own row) and Full. The dial sits in the pane header as four irises whose pupils widen with depth, the current one gilt in a `--surface` well, followed by its name in sans; below 600 px the name is dropped so the title keeps its room. `[` and `]` step it when no block is being edited, and the palette has a command per stop. Depth belongs to the pane's history entry, so back, forward and reload restore it; a zoomed page always shows in full, and the dial hides there and on journal days. Rows that leave the list stop being edited or selected.
- **Text** is the block body. References render inline in the accent with a soft underline; wrapped references align left.
- **Type pills** follow the text at meta size. Clicking a pill opens a menu: open the table, open the type page, remove a manual membership. A text membership says so instead of offering removal.
- **Field entries** are children rendered with a field icon and muted name; editing one shows the name as an atomic widget, never the reference ID. Values are ordinary child blocks. A field with one leaf value shares one row: the field icon takes the bullet slot, the name sits in a 144 px muted column, and the value follows, edited in place. Clicking the name edits the entry, which then shows as two rows; so do fields with several values or nested values. Backspace at the start of an inline value does nothing. A page that opens on a field selects its value row instead of editing. Choice and instance values render as pills outside editing.
- **Capability metadata** follows the source text without replacing it. Task glyphs open status choices; planning summaries show schedule, deadline, priority and repeat. Project and review controls open the attached capability. Source text keeps its natural width; controls wrap beneath it when they cannot fit beside it. Wrapped planning values stay left-aligned.
- **Cards** show their syntax quietly outside editing: `>>`, `<<` and `<>` become →, ← and ↔ in `--faint`, and cloze answers carry a dotted accent underline with the hint in their tooltip. Clicking places the caret at the same source offset. The summary reads `2 cards · 1 due` and opens a Cards popup listing each card's kind, front and state (New, Due, In 6 days), Reset with confirmation for reviewed cards, and Review. Shift opens Review beside.
- **Headings** are Piazzolla block styles at the h1, outline-h2 and h3 tokens, weight 480. `# ` at block start sets one.
- Rows highlight on hover with `--hover`; selection uses `--selection` plus the accent bar. While a range is selected, every row under a selected block takes the same fill and bar, field values included, because those rows move, copy and delete with it.
- Shift-click on another row selects the range from the current row; Shift-click inside the block being edited extends its text selection instead.
- Opening a page selects nothing, so no row lights up that you did not choose; journals still open editing their last empty block. ↓ or `j` then selects the first visible row and ↑ or `k` the last; other keys wait for a selection. Back and forward restore the row you had selected. An open that names a block selects it, and one that names a caret (Add note, Make card, Highlight and note) starts editing there.
- An inline field's label edits its value, caret at the end, and the field stays on one line. ← on a selected inline value selects the field entry itself; Enter then edits its name.

### Row mechanics

Settled by the 2026-10-02 audit; each rule has a document-layer test in `web/src/document/outline-*.test.ts`.

- **Enter** at the end of a block with children inserts its first child; at the end of a leaf, a sibling after it; at the start, an empty block above with the caret staying in the text; mid-text, the right part moves to a new block and the original id stays on the left. Enter inside a `[[reference]]` or `#tag` does nothing.
- **Backspace** at the start merges into the previous visible row (a sibling's last unfolded descendant, never a folded hidden row), the merged block's children follow it. A first child with no previous sibling outdents instead. On a task it acts first on the checkbox: an empty, childless todo is deleted and the caret moves to the end of the previous row; a todo with text loses its task state, and the next Backspace follows the plain rules. Headings likewise drop their style first. Deleting into a reference removes the whole token; undo restores the original caret.
- **Delete** at the end joins the next sibling, appending its children in order.
- **Arrows** at a row boundary cross to the neighbouring row keeping the visual column; Escape keeps the caret offset so the next Enter or `i` resumes there.
- **Indent, outdent and move** act on the selection's roots with their subtrees, never leave the zoomed subtree, and are silent no-ops without a history entry at a boundary (no previous sibling, top level, first or last sibling). Outdent leaves the following siblings under their original parent. A multi-row selection survives the command.
- **Delete** of a subtree selects the previous visible survivor; folding a descendant selects the folded parent; zooming out selects the block being left.
- **Capability identity** stays on the original block through moves, end splits, undo and restoration. A merge cannot remove an active task or project, a block with completion or work history, or reviewed cards; a block that was a task and has no history merges like any other. Deleting is allowed. An interior split cannot divide active card syntax; moving reviewed syntax onto a new source identity is also refused.

## Keyboard language

Three layers, each reaching the same actions as the palette and the block menu.

1. **Typed triggers** in block text. Each character means one thing, opens a picker at the caret, and Escape keeps it as text. References, inline code and field shorthand never open one.

   | Trigger | Means |
   |---|---|
   | `[[` | reference to a page, field or block |
   | `((` | reference to a block, searching blocks only |
   | `#name` | type: picks a page used as a type, or creates one |
   | `@` | when: `@fri` schedules, `@by fri` or `@due fri` sets a deadline; Tab flips the field, Enter picks |
   | `/` | every block verb: statuses, schedule, deadline, priority, repeat, clock, project, headings, references, types, cards |
   | `Name::`, `::` at block start | field entry; `::` alone picks the field |
   | `[] `, `# ` | todo, heading |
   | `>>`, `<<`, `<>`, `{{c1::}}` | cards |

   `[[` and `((` close their pair as in Roam and Logseq, and a typed closer steps over the paired one. The picker opens under the opening brackets and stays there while the query grows; the open `[[query]]` is tinted in the accent until a choice replaces it with a reference. Enter or Tab picks, including when pressed before results arrive. The caret lands after the reference, with a space when a word or the end of the block follows; punctuation or a space typed next takes that space's place. Backspace in an empty `[[]]` removes both pairs. A query that names no page or field exactly offers Create page after the matches.

   `[[Title]]` typed by hand, or kept as text with Escape, links the page with that exact title once the block is left, creating the page if none exists; a date only links a journal that already exists.

   `#` at block start or after whitespace opens a type picker under the hash once a non-space name character follows. It searches the same pages as Add type and offers Create type for a new name. Enter or Tab replaces the token with `#Title` for a single word of letters, digits, `_`, `-` or `/`, otherwise `#[[Title]]`, followed by a space. Escape keeps the text. A bare `#`, `# `, repeated hashes, URL fragments, references, code, card/cloze syntax and field shorthand do not open the type picker; `# ` at block start still makes a heading.

   `Name::` reads as a field label while it is typed: the field icon, the name in `--muted`, and a tinted hint at the end, New field for a name no field has or the field's kind until a value is typed. Space straight after `::`, or Tab anywhere in the name, makes the entry at once and puts the caret in its value; leaving the block converts it as before. `::` at the start of a block opens a field picker listing each field with its kind and Create field for a new name, and picking makes the entry the same way. A choice field's value offers its options as you type, with Add option for a new one; a new date entry opens the date picker for its value.

2. **Chords** for what happens constantly. ⌘ acts on the current block: ⌘Enter toggles todo and done, ⌘⇧Enter opens the status menu, ⌘. zooms in and ⌘⇧. out, ⌘⇧T opens the table. ⌃⇧ is shell navigation. ⌥↑ and ⌥↓ move blocks. No ⌥-letter chords: on macOS they type accented letters.
3. **Leader.** Space on a selected row, or in Vim normal mode, opens a menu of single letters: `t` status, `s` schedule, `d` deadline, `p` priority, `r` repeat, `w` clock in or out, `o` make project or open its controls, `q` make question (make answer beneath the nearest question, or open the menu of an existing question), `v` make or remove perspective, `c` add card, `z` zoom in. Unavailable actions stay listed with their reason.

`/` matches titles and aliases (`/due` finds Deadline, `/h1` Heading 1) and shows each row's faster key, so the menu teaches the chords. `/question` finds Make question rather than Card; `/link` finds Reference rather than Copy reference. A slash command removes its `/query` before it runs; syntax rows such as Reference and Cloze replace it with their syntax and leave the caret inside. Planning commands on a plain block make it a todo first.

## Fields

Fields opens a searchable register with Name, Kind, Used by and Templates columns. Its heading uses the same Piazzolla title and mono apparatus as the other registers; rows stay 28 px high. Names open the definition in its source outline; template pills open their type table. Kind reads as muted text and shows its menu chevron on row hover or focus. Used by opens the distinct owning blocks, including entries with no values; a field no block uses says Unused in `--faint`. New field asks for Name and Kind together, defaults to Text, and refuses duplicates and the characters `Name::` shorthand refuses. Creating the definition and its chosen kind is one undoable edit; redo restores the same definition. Shift opens any of these beside the index. Narrow panes scroll the table horizontally with Name held in place.

Changing kind preserves value text and supports undo and redo from the index. Edit definitions opens the Fields page, where names and choice options remain ordinary blocks. Filtering the index does not change definitions; an empty result offers Clear filter.

## Settings

Settings is a pane on the outline measure with a mono `Notebook and device` register over a Piazzolla title, the save status in faint mono, and Undo and Redo as icon buttons at its right. Preferences come first: Appearance, Editing and Time zone, each a row with its name and one muted sentence on the left and its control on the right (theme tabs, a Vim switch that slides gilt, the time-zone picker). Backups follow, with Back up now, the latest backup under its label and earlier backups folded into a disclosure. Notebook and Service facts come last as a mono list, since they are read rarely and changed never.

## Tables and views

A table is a query shown as rows: a type's members or a saved view.

- **Header**: the type and Register in quiet apparatus, the view name in Piazzolla as a menu button (Save as view, Rename, Delete), and saved/unsaved state. Columns opens presentation controls.
- **Toolbar**: a 16 rem search field, then filter chips and the sort chip. A chip shows its field and operator and removes with its own ×; the trailing "+ Filter" and "Sort" buttons add more. Chips wrap on narrow panes.
- **Grid**: sticky apparatus headers on `--canvas`. The title column is sticky at the left with the page name under the text in `--faint`. Cells are 13 px, rows at least 28 px, divided by horizontal rules and one edge beside the sticky title. Numbers are right-aligned and tabular. Choice and instance values use pills. URL and text cells containing links show the first authored label and a quiet hostname, with a refs count opening every original destination. Labels can be Markdown links or `Title: URL`; bare URLs use their hostname/path. Remaining prose stays visible, and invalid readings retain their warning. The last text/URL column takes spare width; narrow tables scroll inside the pane.
- **Editing**: Enter or double-click edits a single plain text, number, date, URL or identifier value inline. Multiple values, references, choices, instances and checkboxes open the field's source outline beside the table. Clearing a value preserves its block and child notes; refilling reuses a blank value block. Inline editors do not replace structured text with a rendered label.
- **Columns**: the type template's fields first, then fields present on members. Fields used by filters remain available even when every value is empty. Columns hides or restores fields and sets the sticky title width from 170 to 340 px (240 by default). Visibility, title width and horizontal scroll belong to pane history and survive back/forward and reload; they do not change the saved query or type template. Column menus contain sort, filter and hide; Edit field opens kind/template operations separately. Add field to type template remains an explicit action.
- **Footer**: "N of M rows", and the load error with Retry when a request failed.
- **Empty states** say what to do: no members yet for a type, no matches for a filter set, with a control that clears filters.
- Rows open the block in the active pane; Shift-click or Shift-Enter opens beside.

## Tasks, projects and agenda

Tasks are made as in Tana, Roam and Logseq: ⌘Enter makes a block a todo, then toggles it between todo and done (⌥Enter is an alias); `[] ` or `[ ] ` at the start of a plain block makes it a todo; `/todo`, `/doing` and the other statuses set any status, as does the ⌘⇧Enter menu; Make task sits in block and page menus. Task state, dates, optional times, deadline warning, priority and repeat are anchored controls, not text prefixes. Plan task opens a compact slip headed by Planning and the task's authored text. Scheduled, Deadline, Priority and Repeat are labelled rows with their current values or None; Warning appears only with a deadline.

Typing `@` after a space or at block start opens date suggestions under the `@`: Today, Tomorrow, the next five weekdays and Next week, with a parsed query first. Dates accept ISO labels, today/tomorrow/yesterday, weekdays, relative forms (`@in 2 weeks`, `@+2d`) and full or abbreviated month names in either order (`@oct 12`, `@12 october 2027`; `sept` also works). A month and day without a year means its next occurrence on or after the context date; impossible dates such as `feb 30` are errors. A bare weekday includes today when it matches; `next mon` means Monday in the following Monday-start week. Times accept `09:30`, `9:30`, `9am` and `3:30pm` after any date, or alone for the context date; `12am` is midnight and `12pm` noon. A leading `by` or `due` word followed by a space or the token's end makes it a deadline (`@by oct 12 3pm`, `@due fri`). The picker's first, non-selectable row reads Scheduled or Deadline, with a mono Tab hint: Tab flips the field by inserting `by ` or removing `by `/`due ` while retaining the query. Enter picks a date: a plain block becomes a todo, the task is scheduled or due, and the token and its leading space leave the text. Other pickers keep Tab to pick. Pick a date… opens the full picker. Escape keeps the `@` as text. A multi-word query that matches no date is prose (`@sam about the report`): the picker closes so Enter splits the block as usual, and it reopens if the words become a date again.

Date pickers pair the text field with a month grid shared with the journal calendar. Today is ringed. The chosen day is filled with the accent and follows what the field parses (`fri` previews Friday). Scheduled work has a solid dot. Deadlines have an outlined square. These marks count open tasks only, with accessible labels such as `3 scheduled · 1 deadline`. The task's other planning date keeps a separate related-date line. Planning counts load and cache per visible month, and refresh after notebook commits without moving the grid. Clicking a day applies it. Arrows move by day and week, Page Up and Page Down by month. The optional time, Clear and Apply stay in a fixed footer; only the calendar body scrolls when the viewport is short.

Completion uses the displayed journal or agenda date. Repeating tasks retain their source identity and advance their plan; history on an earlier day shows that occurrence's plan, not the next repeat. A running work session requires an explicit stop, with Stop and complete offered as one atomic action. Work-session notes and prior sessions remain accessible from the block menu.

Project controls edit outcome, deadline and status. Show actions opens a task query over canonical descendants. Completing a project does not complete its tasks.

The Agenda destination switches between Agenda, Week and Tasks. Its Add a task field captures into today's journal, scheduled for the displayed day unless a trailing `@date` names another or `@by`/`@due` sets a deadline instead. A live mono preview beneath the field shows the date, optional time and scheduled/deadline field in `--faint`; an unmatched trailing token warns in `--warning` that it stays in the text. The preview shows exactly the first date suggestion that submission will use, including preset prefixes such as `@t` for Today.

Tasks has one mono query line on a hairline: focus edits plain text, Enter or blur applies it, and outside editing each term is a chip with its own remove control. Invalid terms keep their text, carry a `--danger` underline and explain the error beneath; the last valid query stays applied. A faint mono count sits under the line. Terms combine before the result limit, and double quotes group words or multi-word date expressions.

| Task query term | Means |
|---|---|
| `is:todo,doing` | Any of the named statuses: `todo`, `doing`, `waiting`, `done`, `cancelled` |
| `show:open` | Unfinished tasks only |
| `show:recent:7`, `show:recent` | Unfinished or completed in the last seven days; this is the default and omitted from the line |
| `show:all` | All tasks |
| `priority:high`, `priority:medium`, `priority:low` | Priority |
| `#Book`, `#[[Research notes]]` | Source type by an existing page title |
| `[[Finish thesis]]` | Tasks beneath a block with a project capability |
| `@fri`, `@today..+7d`, `@"next fri"..`, `@..2026-10-12` | Scheduled date or inclusive range; either endpoint may be open |
| `by:fri`, `due:fri` | Deadline date or range, with the same date syntax |
| `limit:50` | Result limit |
| Other words, `"read carefully"` | Source text search |

Add condition opens one searchable picker grouped into Task, Source and Fields. Task holds selection, status, priority, project, scheduled/deadline ranges and result limit; Source holds type and text; Fields lists the notebook's definitions. Choosing a condition replaces the picker with its editor at the same trigger. Changing a syntax-backed condition rewrites the query line. Field predicates stay outside the syntax as editable, removable chips in the condition row, with the task count at the trailing edge. Editing a field predicate preserves its place and the other predicates. Named task views store the `TaskQuery`, never the line's spelling, and preserve its date context. Pane history restores the query across Agenda, Week, Tasks and reload; relative dates become absolute dates when applied.

Agenda rows start as one 28 px line: status, source text with its page (omitted for the displayed day's own journal), then planning on the right, which wraps under the text in narrow panes. Long task text clamps at two lines. Planning is relative to the displayed day: only facts not implied by the listing appear, and carried or missed dates use `--danger`.

Week shows the displayed date's Monday-start week in seven day columns. Previous week, Next week and Today keep the same date controls. The mode and date toolbar keeps the same 760 px measure and alignment across Agenda, Week and Tasks even when the week grid is wider. The all-day strip holds untimed scheduled tasks and deadlines labelled Due. Timed scheduled tasks sit in an hourly grid, initially scrolled to 08:00 or the earliest earlier task. Overlapping times use separate lanes. Narrow panes scroll horizontally rather than compressing tasks into overlapping columns.

Dragging a task into the grid sets its scheduled date and time, snapped to 15 minutes. Dropping in the all-day strip sets its date and clears the time. Each drop is one undoable notebook command. The position changes immediately and rolls back if the commit fails. Focused tasks also support Alt+Left or Alt+Right to move one day, Alt+Up or Alt+Down to move 15 minutes, and Alt+Home to clear the time. Clicking opens the source. Shift-click opens it beside.

A journal's agenda sits under its title and lists canonical tasks from other pages; the day's own tasks are already in the outline below. Its header summarises the day (`3 to do · 1 overdue · 2 done`, or Nothing planned), so the collapsed state still answers what is due; collapse is one device preference across journals. Each group shows its first 12 rows and a Show N more button, so a backlog cannot push the day's own blocks out of view. Undated tasks gather under a collapsed Unplanned group. Clicking a row opens the source and Shift-click opens it beside. Completion and planning never insert copies into the journal.

## Cards and review

Author `front >> back`, `front << back`, `front <> back`, or numbered clozes such as `{{c1::answer::hint}}` in ordinary blocks. `::` remains field shorthand. A trailing `>>>` makes a multi-line card whose answer is the block's child outline; a trailing `>>1.` makes a list card whose children are revealed one at a time. The editor draws these markers as `↓` and `↓1.` in `--faint`. Explicit malformed syntax shows diagnostics instead of guessed cards. Each numbered cloze and each direction has its own stable progress.

Review is a pane on the outline measure, like Library. Its header has a mono `Review` register (`Review · in progress` during a review) over the deck as a Piazzolla title, which opens the deck picker (a saved deck or All cards); Open reviews when another review is open and a Deck actions menu sit at its right. Under it sit the Due, New and All tabs with counts. Decks compose source type, text and field predicates; their editor shows how many cards the draft matches and saves a query, never a copied card collection. A status line shows Start review with the queue's count (`3 due cards`), Nothing due or Queue complete with Finish review, and pending commands. Before a review the landing lists the first eight cards of the queue, front text in Piazzolla with kind and source in mono, each opening its source (Shift beside), and Start review takes focus so Enter or Space begins. During a review a progress rule sits at the right of the tabs: a hairline that fills gilt with `N done · N left` beside it, counting grades acknowledged since the pane opened the review.

The card reads as a quiet sheet on the page rather than a boxed panel, headed by the same rubric mark as popups. A top rule turns to the accent on focus. Its mono meta row shows the source path, which opens the canonical block (Shift opens it beside review), Reverse, Multi-line, List or Cloze N for those kinds, and Reset progress once a reviewed card is revealed. The prompt and answer use 17 px Piazzolla with a 26 px line height and no side labels; a rule separates them. A side of at most 40 characters on one line, such as a vocabulary word, is set at the h1 size instead. A multi-line answer reads as an outline with small `--faint` bullets in the indent. A list answer numbers its items in rubric mono; Space reveals the next item, a faint mono `2 of 7` counts them, and grading waits for the last. The four grades share one compact strip with internal dividers, keyboard hints and interval previews. A cloze shows its gaps as tinted slots holding `…` or the hint, and reveals in place with each answer marked, so the sentence appears once. Review history appears only for reviewed cards, newest first.

Space reveals the answer; 1–4 select Again, Hard, Good and Easy. Scheduling is FSRS-6 at 90% retention in whole days. Buttons show the next interval in days, then months and years. When two neighbouring grades have different intervals that round to the same label, both show one decimal (`1.4 mo`), then whole days if they still match; equal intervals, such as Again and Hard on a new card, read the same. A source or schedule change invalidates the shown snapshot and requires Review current card before grading. Changed wording retains identity and progress; the card shows the last reviewed text beside its current text, with Keep progress and Start over choices. Reset progress requires confirmation and keeps review history.

The current card stays until a grade is acknowledged. Pending commands survive offline reload with their original request bytes; rejection preserves the command for copying and requires a fresh card snapshot. Unrelated local page edits do not invalidate the shown card. Finishing, abandoning or switching an open review is explicit; committed grades and their shown-text evidence remain. Pane history and reload preserve the deck, queue selection and session.

## Library and reading

Library is a pane. Its header holds state tabs with counts (Inbox, Reading, Finished, Abandoned, All), then Highlights with its unprocessed count; a zero count is left out so the tabs fit a split pane. The last tab is remembered per notebook. Under them sit a 28 px search field, a sort menu (Added, Title, Author, Year, Last read, Progress), Add, and an Export menu (BibTeX, CSL JSON, Markdown) for the selection or the listed sources. Searching, filtering and sorting keep the current rows on screen until the new ones arrive and swap them in one step; Loading… appears only when nothing of that kind is loaded and the load takes over 300 ms. Rows read as a ledger on one 28 px line: a leading slot with the cover thumbnail in a hairline frame or a book or article icon, the siglum as a mono shelfmark in `--faint` that turns gilt on hover, the title, the byline in `--muted` (creators, else site), and trailing fixed-width mono columns for year, progress and the unprocessed highlight count, so figures line up across rows. The byline truncates before the title. The leading slot shows a selection checkbox on hover, focus, or while any row is selected; a selected row takes `--selection` and the accent bar. While rows are selected, a bar replaces the search line: the count, Mark as (one batch for all of them), Export and Clear selection; Escape clears. Clicking a row opens the source page; Shift opens it beside. A row menu offers Read, Mark as reading, finished or abandoned, Return to inbox and Export.

Add opens Add to library anchored under its button: one field for a URL, ISBN, DOI or arXiv ID, then Choose file… at the leading edge and Enter details by hand at the trailing edge, each with its glyph. Enter submits; Looking up… shows while it works. An identifier lookup previews a catalogue card before anything is written: the cover, the title in Piazzolla with its subtitle, the creators with `(ed.)` and `(trans.)` marks, then year, publisher and identifiers as mono apparatus and `From Open Library`, `From Crossref` or `From arXiv` in `--faint`, with Cancel and Add. Enter details by hand opens the details form in the same popup. Dropping an EPUB on the Library pane or the popup does the same as choosing a file. Each file or article submission becomes a job row above the sources while queued, running or failed: a state icon, the name without its extension, the state, and the error sentence on a second line aligned with the name, with Retry and Dismiss on failures. The name truncates first, so state and actions stay on the first line in a narrow pane. Dismissal is a device preference per notebook. Finished jobs leave the list once the source appears in the current view. The Highlights tab shows no jobs.

The details form, in Add and in Edit details…, is a column of labelled rows: label in `--muted` on the left, field on the right. Creators is a group of rows, each a name field, Author, Editor and Translator tabs and a remove button, with Add creator beneath. Published accepts `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Saving writes every changed field as one undoable step.

Highlights lists cited blocks newest first, grouped by source in the order sources first appear, Unprocessed by default with an All toggle. A group heading is the source title, which opens the source page, with its count. Each card has its colour dot in a hanging column, the block text, a meta line (section, `¶N`, date, tags, `N notes`) and the quoted passage when the text has been rewritten. A note is a non-empty child of the highlight block. Colour filters are dot-only toggles. A highlight is processed once it has a child, a card or an incoming reference, so working the list means writing under highlights, linking them or making cards from them; that sentence is the Unprocessed button's tooltip and the empty state. Clicking edits the block in its source outline; Shift opens it beside.

A highlight's menu, in the reader and on Highlights cards, starts with its quote clamped to two lines and a row of colour dots (the five hues, then No colour as a ring; the current one is ringed in `--text`; `1`–`5` and `0` pick them), then Add note or Open note, Make card, Copy with citation, Mark processed, Add tag… and Remove highlight; cards put Open in reader first. Add note reuses a blank note left from an earlier attempt. Hovering a highlight on its source page, in the reader or on a Highlights card points to the same highlight in the other pane: the reader underlines its mark in the accent and the source page tints its row with `--hover`. Nothing scrolls or takes focus.

A source page shows a compact header under its title: the current snapshot's 48 px cover (which opens the reader), the siglum, format and reading position as `N%`, then a state menu button, Read, and a menu with Copy citation key, Edit details…, Replace cover…, Fill missing details when the source has an identifier (a fresh lookup that writes only empty fields), Export BibTeX, Export CSL JSON, Export Markdown, Snapshots and Delete source…. A record source, added by lookup or by hand, has no snapshot and no Read. The snapshot's description is clamped to three lines with More. Metadata appears once, as ordinary editable fields beneath a quiet rule; the header does not repeat a derived byline. It has no Table button; ⌘⇧T and the palette still open the table. The pane header reads Library / title, and Library opens the Library pane (Shift beside); zoomed into a block, Library gives way to the zoom path. The details group uses control size, labels in `--muted`, and field icons only on hover. Languages show their English name and identifiers their scheme (`ISBN 978…`) until edited. A value that differs from what the current snapshot extracted offers Reset to extracted in its field menu. The first top-level block after the fields carries a "Highlights N" section label; highlights follow reading order, each with its notes beneath, and highlights of this source filed on other pages are listed under Filed elsewhere so the count matches the library. Recent shows a book or article icon for source pages.

Every source has a siglum, a short mark as in a critical edition. An authored `Siglum::` field wins when its trimmed value is one to four letters, upper-cased; empty, longer or non-letter values are ignored. Otherwise it is the first three letters of the first author's family name (else editor, site, then the title's first word containing letters), upper-cased with Unicode letters kept and non-letters skipped; shorter names use what they have. It is read from the current fields so editing the author changes it. The source header leads its format and progress apparatus with it as a bare gilt mono mark and a short `--line` rule, never boxed, and CSL JSON exports it as `citation-label`. On any other page, a row that cites a passage hangs its source's siglum right-aligned in the left gutter, boxed in `--control-border`, gilt when the row is selected or its highlight is hovered in the reader. Sigla are assigned per page in order of first appearance: the later derived mark in a collision takes further letters of its basis name (`THO`, then `THOM`, `THOMA`), or adds `2`, `3`, … after the basis runs out. Authored sigla never change. Margin, header, apparatus and Compare marks stay on one line, with boxes sized for four mono letters and room to grow.

A page that shows sigla widens its outline's left padding to `--siglum-width` plus 8 px, so a four-letter mark is never clipped in a narrow pane.

The reader is a pane: the pane header reads Library / source title, and the title opens the source page. Inside, one toolbar line at the reading measure holds Contents labelled with the current section, Highlights with its count, Find in source, the reading position as `N%`, `Aa` for reader settings and an actions menu (Open source page, then every reader shortcut with its key). A 2 px rule under it fills to the reading position. Progress anywhere (library rows, the source header, the reader) is this one number: the share of the text before the first passage on screen, rounded down, `<1%` once started. The text starts with a Piazzolla title and a mono byline. Reader settings are a device preference shared by every reader pane: Sans (Plex) or Serif (Piazzolla), default Serif; saved choices are preserved. Size is 15 to 22 px, default 17; width Narrow 28em, Medium 34em (default) or Wide at the outline measure; line spacing 1.5, 1.65 or 1.8. Changing one keeps the first visible passage in place. Headings scale from the reader size, footnote references are superscript links that open the note in a popover, images keep their natural size up to the measure and 70% of the viewport height, dimmed to 85% brightness on the dark canvas until hovered, and code sits on `--surface` in a horizontally scrolling block. Contents opens on the current section, marked with a check; the Highlights picker lists each highlight's colour, quote and section; Find marks matches and counts passages. The reading position saves while scrolling; opening from a citation scrolls to the passage and flashes it without counting as reading. Selecting text shows a small toolbar beside the selection, centred on it and below it when there is no room above, with Highlight (`H`), Highlight and note (`N`) and the five colours (`1`–`5`); both append a block quoting the selection to the source page, and the second also starts an empty child and opens the highlight beside the reader with the caret there. An empty note does not mark the highlight processed. Highlights tint their ranges in their colour, or a neutral 12% `--text` tint without one; one with notes ends in a small note icon in `--faint` that opens them. Clicking a highlight opens its menu; Shift-click opens its block beside the reader.

Highlighting a selection that overlaps existing highlights extends the earliest one on the source page to cover the union instead of stacking a new mark. Merge overlapping highlights, in the reader's actions menu, does the same for every overlapping group and reports `Merged N highlights` or `No overlapping highlights`. Highlights cited from other pages are kept and still count toward the union, with `; N cited elsewhere kept` added to the report. Contents falls back to the EPUB guide and fills in lazily when the navigation document is empty; a passage's tooltip names its number and section, `Passage 37 · Chapter 1`.

On a touch screen, Highlight and note keeps the passage in view instead of opening the source page. A sheet covers the shell: the book's title and byline, the reading rule, the section and position in mono, the sentence leading into the quotation in `--muted`, the quotation itself larger on a highlight tint with a gilt rule, and the sentence after it. Below, on `--surface`, sit "A thought on this passage" with a gilt Keep note button, the note field and a footer with the save state and Back to reading. The note is the highlight's child block and saves as it is typed. Back to reading with nothing typed removes the empty note; the highlight stays. When the keyboard takes room, the passage scrolls so the whole quotation and as much of the lead-in as fits stay visible, and the byline goes.

A block with a citation shows a citation chip in its capability metadata: the highlight's colour dot (a hollow ring without colour, as in the library and the reader), the source's short title (before any subtitle colon, cut at a word within 40 characters) and the passage number, `¶231`. On the source's own page the chip shows only `¶231` in `--faint` and stays at the end of the block's first line, the text wrapping beside it. Clicking opens the reader at that passage; Shift opens it beside. A block whose text no longer equals the quote shows the quote beneath it in `--muted` with a quotation rule, so a paraphrase or cloze keeps its evidence visible.

## Perspectives and questions

A concept page holds several attributed readings. Make perspective, in the block menu, the palette and `/perspective`, turns a block such as `[[Plato]]` into a position; Remove perspective undoes it. Its row names the holder in Piazzolla at control weight, the holder link in `--text` with a `--line` underline that turns gilt on hover, and its source's siglum hangs in the margin. A `Gist::` child drops its label and reads as the line under the holder, so the pair reads "Plato / A line of decline". At the Perspectives depth each position closes to its holder and gist.

A holder's page lists Perspectives held above its backlinks, and a subject's page lists Perspectives filed elsewhere (positions about it that live on other pages, such as under a highlight); neither repeats under Backlinks.

Compare perspectives, in the page menu and the palette once a page has two positions filed under it, opens a reading sheet. Its toolbar names the subject in Piazzolla with a mono count; selection starts with two readings, and the holder controls add or remove columns while retaining at least one. Each column shows an unboxed source siglum, an 18 px holder name, its authored Shape glyph alongside, the Work reference, a 17 px gist and 16 px authored prose. Shape is not its own cell. Other fields stay in the source outline, reached through the holder or Open reading (Shift beside), rather than becoming a universal questionnaire. No prose is generated from field values and differing strings are not treated as evidence of disagreement. Actual question blocks on the subject page appear below the sheet and open their original blocks. Columns have a readable minimum width and scroll horizontally on narrow panes.

A titled page with three or more perspectives filed under it gains an apparatus margin, `--apparatus-width` (240 px) wide, 48 px right of the measure, whenever its pane fits both (a 1096 px content width, so a single pane on a laptop but not a split). The column then shifts left so the pair stays centred, and the margin scrolls with the page. It holds the constellation, the page as a gilt hub with its holders on the inner ring (blued-steel spokes, holder names in `--muted`) and up to twelve pages that link to it as faint dots on an outer ring with their titles on hover, then a Sources key pairing each siglum used on the page with its source's title. Every node and source opens its page; Shift opens it beside. Zoomed views and narrower panes have no margin.

Make question and Make answer, in the block menu, the palette and `/question` or `/answer`, mark a block as a question or as an answer beneath one; a titled page can be a question from its page menu. A question reads in Piazzolla. Its state control sits in the capability metadata with the question glyph and its state: Open in gilt, Unsettled in `--agree`, Answered in `--status-done` with the settled glyph, Parked in `--faint`, then any review date. Clicking it opens the question menu: Park or Resume, Keep open or Let it settle, Set review date and Remove question. An answer shows `Answer 2026-10-06`, or `Accepted` in gilt once its question accepts it, and `Aporia` when it records that no answer holds. Commands that cannot apply stay listed with their reason, such as "Resume the question before accepting an answer."

## Popups and feedback

Floating layers open below the element or caret that opened them, with a 4 px gap, start-aligned unless the anchor is in the viewport's right half, flipping above when below is too short (a menu flips whenever only the space above holds all of its items), clamped to the viewport, never covering the anchor. Fixed forms opt into intrinsic-height fitting and choose the larger space when they cannot fit below; growing result lists keep the stable-placement policy. Find or create opens beneath the global search trigger; the dedicated command palette centres near the top of the viewport. Escape closes the topmost one and returns focus. Closing retires input handlers immediately; only an inert, accessibility-hidden visual remains for the brief exit animation. It has no IDs and cannot steal focus from a successor popup. Reduced motion removes it immediately.

Shared popup patterns:

- **Menu**: 28 px rows with an icon slot, label and shortcut at the right; sections as 12 px labels; danger last. The icon column is reserved whenever any item has one, so labels align. A header may sit above the rows, as the highlight menu's quote and colour dots; its buttons join the arrow-key order.
- **Picker**: an input on top and 28 px rows below. Arrows move, Enter picks, typing filters, the mouse hovers to highlight. Chips before the input show steps already chosen. Optional mono section headings group results without entering the keyboard selection order. Used by the palette, reference completion, Add type, Add condition and the time zone.
- **Form**: compact labelled controls with an optional 18 px Piazzolla title and an action row. Fixed forms fit their content; a date picker's footer remains visible when its body must scroll.
- **Confirm**: 13 px body text and two buttons.
- **Preview**: a read-only card for a reference's target, described under "Reference previews" below.

| Surface | Shape | Placement |
|---|---|---|
| Find or create: pages, blocks and explicit page creation; `>` finds commands | Picker, one line per hit with the page path in meta size; Tab drills into children | Below the global search trigger, 560 px |
| Dedicated command palette | Picker, grouped by action section, with shortcuts; disabled reasons appear on the selected row and remain available to assistive technology | Top centre, 560 px |
| `[[`, `((`, `#`, `Name::` completion and Add type | Picker | Below the opening brackets, the caret or the block |
| `@` dates and `/` commands | Picker without an input; the block text is the query, sections label `/` rows, faster keys at the right | Below the token |
| Leader, status and priority menus | Menu; leader letters at the right and pressed directly | Below the row |
| Add filter | Picker in three steps: field, condition, value; Backspace on an empty query steps back | Below its trigger |
| Block menu | Menu in sections Block, Move, Select; navigation stays in the palette | Below the handle |
| Page, notebook, layout, pill, column, view, sort and field kind menus | Menu | Below their trigger |
| New page, Delete page | Confirm | Below their trigger |
| Reference preview | Preview, 380 px | Below the line of the reference under the pointer, or the reference at the caret |
| Undo toast | Bottom centre, one at a time |
| Save state | Pane header, never a toolbar or a row; it says Saving… only when a save takes longer than a second |

Native `<select>` is never used; a bordered menu button or a picker replaces it.

### Reference previews

Resting the mouse on a `[[reference]]` for 350 ms opens a slip in the outline, editor or another reference-rendering surface. Moving to another reference while a slip is open takes a third of the delay; a 200 ms grace period covers the gap. A page slip shows its breadcrumb, 24 px Piazzolla title, 16 px gloss, existing type/source/task/project metadata, and reading/backlink counts. Without a gloss it shows a short prose preview, with actual field values as a fallback for field-only pages. A block slip retains its parent, highlighted target and first descendants. The footer uses Plex for Beside and Open (Go to block for blocks), mono for counts.

Pin or ⌘ keeps the slip open; Unpin restores its compact form. A pinned page lists its actual attributed readings, with sigla, holders, gists and inline shape glyphs. Selecting a holder expands authored prose, or opens the original position if there is no prose to expand. Open reading and source links preserve access to the original outline; Compare readings opens the subject's sheet. Pages without readings keep their prose preview. Bodies scroll within `--preview-body-height`; unpinned block previews fade only when clipped. References inside a slip open stacked slips. ⌥Space opens the reference at the caret or the focused reference; Enter opens it, Shift+Enter opens it beside, and Escape closes the topmost slip. Opening does not steal focus; focused slip controls retain native keyboard behavior. Deleted targets and failed requests have explicit notices. Touch input does not open hover slips.

## Decisions

1. Three voices: Plex for writing, Piazzolla for publication, Berkeley Mono for apparatus. Orrery palette. Density: 28 px rows.
2. Handle and fold in a gutter outside the measure; bullets inside it, filled.
3. Shift is the one "open beside" modifier.
4. Fields, Settings, tables and views are panes, not dialogs.
5. Pills are hue-tinted at meta size; bullets stay neutral.
6. Tables divide rows, not columns; the title column is sticky.
7. A permanent global rail owns notebook-wide actions; pane headers own document actions.

## Open

- Type hue assignment: by a stable hash of the type title, or chosen per type and stored on the type page.
- Whether single-value field rows should also fold into the parent block's line.
- Direct drag resizing and notebook-shared column presentation; the current title-width control is pane-local.
