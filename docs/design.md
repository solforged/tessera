# Design

How the browser client looks and behaves. Tokens live in `web/src/tokens.css`; components use tokens, never raw values. This carries over the system remcard settled on in its `design-language.md`, keeps what worked, and adds the surfaces tessera has that remcard did not: saved views, a Fields destination and settings as panes.

Status: applied to the shell, the outline and the table. The permanent global rail and inset workspace are being evaluated in the running app. Later stages add their sections here before they are built.

## Principles

1. **The text is the interface.** Controls stay quiet until hover, focus or selection, and every action is also reachable from a visible control.
2. **Act where you are looking.** Controls attach to the block they affect. Popups open at the caret or at their trigger, never at a pane edge.
3. **One meaning, one form.** Structure is a neutral bullet. A type is a tinted pill with its name. Task state is a glyph. Colour never carries meaning alone, and type hues never reuse status hues.
4. **Work happens in panes.** Tables, views, fields, settings, search results and references open in a pane. Dialogs are for short controls and confirmations only.
5. **Summaries in the row, details on selection.** A block shows its state as compact trailing metadata; field rows appear as children under it.
6. **Calm dark.** A slightly lighter shell frames the darker canvas. One accent marks focus and primary actions. Only floating layers cast shadows.
7. **Built for long sessions.** 28 px rows, 15 px body text, a 760 px measure. Nothing below 12 px.
8. **Keyboard and pointer parity.** Menus show shortcuts beside actions. Vim is optional.

## Tokens

### Type

IBM Plex Sans Variable, bundled; weights 400, 500, 600.

| Token | Size / line | Use |
|---|---|---|
| `--text-meta` | 12 / 16 | Pills, labels, breadcrumbs, status, table headers |
| `--text-control` | 13 / 18 | Buttons, menus, sidebar, table cells |
| `--text-body` | 15 / 24 | Block text, inputs |
| `--text-h3` | 16 / 24 | Heading 3 |
| `--text-h2` | 18 / 26 | Heading 2, pane and section titles |
| `--text-h1` | 24 / 30 | Heading 1, view and dialog headings |
| `--text-title` | 30 / 36 | Page titles |

### Space and size

Steps 2, 4, 8, 12, 16, 24, 32, 48 px. Row height 28 px; indent 24 px; measure 760 px; gutter 48 px left of the measure; sidebar 208 px; global rail 48 px; pane header 36 px. Pointer targets 24 px, touch targets 44 px. Icons 16 px, 14 px inline.

### Colour

| Role | Token |
|---|---|
| Shell: global rail and sidebar | `--shell` |
| Table headers and banners | `--surface` |
| Canvas: panes | `--canvas` |
| Raised: popups, pills, chips | `--raised` |
| Hover, selection, divider, control border | `--hover` `--selection` `--line` `--control-border` |
| Selected text, in the editor, static rows and the reader | `--text-selection` |
| Text primary, secondary, tertiary | `--text` `--muted` `--faint` |
| Accent and focus ring | `--accent` |
| Warning, danger | `--warning` `--danger` |
| Type hues, pills only | `--type-1` to `--type-6` |
| Task states, stage 3 | `--status-*` |
| Highlight colours: reader tints at 24%, dots at full strength | `--highlight-yellow` `-green` `-blue` `-red` `-purple` |

Pills take a 12% tint of their hue with a 30% border. A selected row adds a 2 px accent bar at its left edge.

### Shape and elevation

Radius 4 px for controls, 8 px for popups and the workspace frame, full for pills. Popups have a 1 px `--line` border and `--popup-shadow`; dialogs `--dialog-shadow`. The workspace frame has a 1 px `--line` border and no shadow. Rows and tables cast none.

### Motion

Motion acknowledges an action without delaying it: 140 ms for popup entry and sidebar movement, 90 ms for popup exit and hover feedback, with a short ease-out and no bounce. Popups travel 4 px; toasts and the reader's selection toolbar rise the same distance. Clickable button icons scale subtly on hover, focus and press. Rows, pills and list items fade their hover fill. Fold and disclosure chevrons turn rather than swap, a menu trigger's trailing chevron turns while its menu is open, and Recent, related sections and review history expand and collapse in place. A revealed answer fades in. The save state icon turns while saving. Reduced motion sets durations and travel to zero and disables icon scaling.

## Shell

- **Global rail.** Permanent across one or two panes. The left holds the sidebar toggle and notebook-name menu (Fields, Settings); Vim is toggled only in Settings. The right groups Find or create and the Commands icon in one 320 px search-shaped control, followed by an icon-only Layout button. Find or create opens its picker beneath the search trigger; Commands opens the command palette. Layout opens the active view beside, switches panes, closes the active pane or toggles the sidebar. Global controls are never duplicated inside pane headers.
- **Sidebar**, 208 px. Today, Agenda, Review and Library; Pinned, shown only when a page or saved table view is pinned; unpinned saved Views; and collapsible Recent. Saved table views have a pin control on hover or keyboard focus; pinning is stored per notebook alongside page pins. Task views and decks are selected in their own destinations. Rows are 28 px with one left edge: icons at 8 px, text and section headings at 32 px. The row for the active pane's target gets the 2 px accent bar. Destinations open in the active pane; Shift-click opens beside.
- **Workspace frame.** The panes share one inset canvas, with a 12 px outside gutter at the right and bottom and an 8 px corner radius. Collapsing the sidebar adds the same gutter on the left. The rail and sidebar use the same shell surface.
- **Panes.** Up to two, split equally. Each has a header: back and forward, breadcrumbs or the pane title, the page menu, save state, the Vim mode when on, and Close while split. Journal headers also hold their own previous-day, calendar and next-day controls; these always target the owning pane. Page errors stay under their owning header. Notebook recovery feedback appears once above both panes, so activating a pane cannot move a control between pointer-down and click. Non-page panes (table, fields, settings, agenda, review, library, reader) share the workspace frame.
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
- **Bullet** is a filled dot in `--muted`, 24 px target. Click or ⌘. to zoom (⌘⇧. zooms out), drag to move. The page title aligns with the bullet column.
- **Text** is the block body. References render inline in the accent with a soft underline; wrapped references align left.
- **Type pills** follow the text at meta size. Clicking a pill opens a menu: open the table, open the type page, remove a manual membership. A text membership says so instead of offering removal.
- **Field entries** are children rendered with a field icon and muted name; editing one shows the name as an atomic widget, never the reference ID. Values are ordinary child blocks. A field with one leaf value shares one row: the field icon takes the bullet slot, the name sits in a 144 px muted column, and the value follows, edited in place. Clicking the name edits the entry, which then shows as two rows; so do fields with several values or nested values. Backspace at the start of an inline value does nothing. A page that opens on a field selects its value row instead of editing. Choice and instance values render as pills outside editing.
- **Capability metadata** follows the source text without replacing it. Task glyphs open status choices; planning summaries show schedule, deadline, priority and repeat. Project and review controls open the attached capability. Source text keeps its natural width; controls wrap beneath it when they cannot fit beside it. Wrapped planning values stay left-aligned.
- **Cards** show their syntax quietly outside editing: `>>`, `<<` and `<>` become →, ← and ↔ in `--faint`, and cloze answers carry a dotted accent underline with the hint in their tooltip. Clicking places the caret at the same source offset. The summary reads `2 cards · 1 due` and opens a Cards popup listing each card's kind, front and state (New, Due, In 6 days), Reset with confirmation for reviewed cards, and Review. Shift opens Review beside.
- **Headings** are block styles at the h1 to h3 tokens, semibold. `# ` at block start sets one.
- Rows highlight on hover with `--hover`; selection uses `--selection` plus the accent bar.

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
   | `#` | type |
   | `@` | when: `@fri` schedules, `@due fri` sets a deadline |
   | `/` | every block verb: statuses, schedule, deadline, priority, repeat, clock, project, headings, references, types, cards |
   | `Name::`, `::` at block start | field entry; `::` alone picks the field |
   | `[] `, `# ` | todo, heading |
   | `>>`, `<<`, `<>`, `{{c1::}}` | cards |

   `[[` and `((` close their pair as in Roam and Logseq, and a typed closer steps over the paired one. The picker opens under the opening brackets and stays there while the query grows; the open `[[query]]` is tinted in the accent until a choice replaces it with a reference. Enter or Tab picks, including when pressed before results arrive. The caret lands after the reference, with a space when a word or the end of the block follows; punctuation or a space typed next takes that space's place. Backspace in an empty `[[]]` removes both pairs. A query that names no page or field exactly offers Create page after the matches.

   `[[Title]]` typed by hand, or kept as text with Escape, links the page with that exact title once the block is left, creating the page if none exists; a date only links a journal that already exists.

   `Name::` reads as a field label while it is typed: the field icon, the name in `--muted`, and a tinted hint at the end, New field for a name no field has or the field's kind until a value is typed. Space straight after `::`, or Tab anywhere in the name, makes the entry at once and puts the caret in its value; leaving the block converts it as before. `::` at the start of a block opens a field picker listing each field with its kind and Create field for a new name, and picking makes the entry the same way. A choice field's value offers its options as you type, with Add option for a new one; a new date entry opens the date picker for its value.

2. **Chords** for what happens constantly. ⌘ acts on the current block: ⌘Enter toggles todo and done, ⌘⇧Enter opens the status menu, ⌘. zooms in and ⌘⇧. out, ⌘⇧T opens the table. ⌃⇧ is shell navigation. ⌥↑ and ⌥↓ move blocks. No ⌥-letter chords: on macOS they type accented letters.
3. **Leader.** Space on a selected row, or in Vim normal mode, opens a menu of single letters: `t` status, `s` schedule, `d` deadline, `p` priority, `r` repeat, `w` clock in or out, `c` add card, `z` zoom in.

`/` matches titles and aliases (`/due` finds Deadline, `/h1` Heading 1) and shows each row's faster key, so the menu teaches the chords. A slash command removes its `/query` before it runs; syntax rows such as Reference and Cloze replace it with their syntax and leave the caret inside. Planning commands on a plain block make it a todo first.

## Fields

The notebook menu opens a searchable index with Name, Kind, Used by and Templates columns. Names open the definition in its source outline; template pills open their type table. Kind reads as muted text and shows its menu chevron on row hover or focus. Used by opens the distinct owning blocks, including entries with no values; a field no block uses says Unused in `--faint`. New field asks for a name, refuses duplicates and the characters `Name::` shorthand refuses, and appends a Text definition to the Fields page. Shift opens any of these beside the index. Controls remain visible on narrow panes.

Changing kind preserves value text and supports undo and redo from the index. Edit definitions opens the Fields page, where names and choice options remain ordinary blocks. Filtering the index does not change definitions; an empty result offers Clear filter.

## Tables and views

A table is a query shown as rows: a type's members or a saved view.

- **Header**: the type pill, the view name as a menu button (Save as view, Rename, Delete, Discard changes), and "Saved view" or "Unsaved changes" at the right.
- **Toolbar**: a 16 rem search field, then filter chips and the sort chip. A chip shows its field and operator and removes with its own ×; the trailing "+ Filter" and "Sort" buttons add more. Chips wrap on narrow panes.
- **Grid**: header row on `--surface`, meta size, sticky. The title column is sticky at the left with the page name under the text in `--faint`. Cells are 13 px, rows at least 28 px, divided by horizontal lines only. Numbers right-aligned and tabular. Multi-value cells retain every value; choice and instance values use pills. An unreadable value gets a dotted warning underline, never a rewrite.
- **Editing**: Enter or double-click edits a single plain text, number, date, URL or identifier value inline. Multiple values, references, choices, instances and checkboxes open the field's source outline beside the table. Clearing a value preserves its block and child notes; refilling reuses a blank value block. Inline editors do not replace structured text with a rendered label.
- **Columns**: the type template's fields first, then fields present on members. Fields used by filters remain visible even when every value is empty. The trailing `+` adds a column and sets a kind. Column menus offer sort, filter by this field, change kind, remove from template.
- **Footer**: "N of M rows", and the load error with Retry when a request failed.
- **Empty states** say what to do: no members yet for a type, no matches for a filter set, with a control that clears filters.
- Rows open the block in the active pane; Shift-click or Shift-Enter opens beside.

## Tasks, projects and agenda

Tasks are made as in Tana, Roam and Logseq: ⌘Enter makes a block a todo, then toggles it between todo and done (⌥Enter is an alias); `[] ` or `[ ] ` at the start of a plain block makes it a todo; `/todo`, `/doing` and the other statuses set any status, as does the ⌘⇧Enter menu; Make task sits in block and page menus. Task state, dates, optional times, deadline warning, priority and repeat are anchored controls, not text prefixes.

Typing `@` after a space or at block start opens date suggestions under the `@`: Today, Tomorrow, the next five weekdays and Next week, or the parse of what follows (`@fri`, `@in 2 weeks`, `@2026-11-01 09:30`). `@due` switches the same list to the deadline, and `@d` offers that switch as a row. Enter or Tab picks one: a plain block becomes a todo, the task is scheduled or due, and the token and its leading space leave the text. Pick a date… opens the full picker. Escape keeps the `@` as text.

Date pickers pair the text field with a month grid shared with the journal calendar. Today is ringed. The chosen day is filled with the accent and follows what the field parses (`fri` previews Friday). Scheduled work has a solid dot. Deadlines have an outlined square. These marks count open tasks only, with accessible labels such as `3 scheduled · 1 deadline`. The task's other planning date keeps a separate related-date line. Planning counts load and cache per visible month, and refresh after notebook commits without moving the grid. Clicking a day applies it. Arrows move by day and week, Page Up and Page Down by month.

Completion uses the displayed journal or agenda date. Repeating tasks retain their source identity and advance their plan; history on an earlier day shows that occurrence's plan, not the next repeat. A running work session requires an explicit stop, with Stop and complete offered as one atomic action. Work-session notes and prior sessions remain accessible from the block menu.

Project controls edit outcome, deadline and status. Show actions opens a task query over canonical descendants. Completing a project does not complete its tasks.

The Agenda destination switches between Agenda, Week and a composable Tasks query. Its Add a task field captures into today's journal, scheduled for the displayed day unless a trailing `@date` names another. Status, priority, project, independent scheduled/deadline ranges, source type, text and fields combine before the result limit. Named task views preserve that query and its date context. Agenda rows start as one 28 px line: status, source text with its page (omitted for the displayed day's own journal), then planning on the right, which wraps under the text in narrow panes. Long task text clamps at two lines. Planning is relative to the displayed day: only facts not implied by the listing appear, and carried or missed dates use `--danger`.

Week shows the displayed date's Monday-start week in seven day columns. Previous week, Next week and Today keep the same date controls. The all-day strip holds untimed scheduled tasks and deadlines labelled Due. Timed scheduled tasks sit in an hourly grid, initially scrolled to 08:00 or the earliest earlier task. Overlapping times use separate lanes. Narrow panes scroll horizontally rather than compressing tasks into overlapping columns.

Dragging a task into the grid sets its scheduled date and time, snapped to 15 minutes. Dropping in the all-day strip sets its date and clears the time. Each drop is one undoable notebook command. The position changes immediately and rolls back if the commit fails. Focused tasks also support Alt+Left or Alt+Right to move one day, Alt+Up or Alt+Down to move 15 minutes, and Alt+Home to clear the time. Clicking opens the source. Shift-click opens it beside.

A journal's agenda sits under its title and lists canonical tasks from other pages; the day's own tasks are already in the outline below. Its header summarises the day (`3 to do · 1 overdue · 2 done`, or Nothing planned), so the collapsed state still answers what is due; collapse is one device preference across journals. Each group shows its first 12 rows and a Show N more button, so a backlog cannot push the day's own blocks out of view. Undated tasks gather under a collapsed Unplanned group. Clicking a row opens the source and Shift-click opens it beside. Completion and planning never insert copies into the journal.

## Cards and review

Author `front >> back`, `front << back`, `front <> back`, or numbered clozes such as `{{c1::answer::hint}}` in ordinary blocks. `::` remains field shorthand. Explicit malformed syntax shows diagnostics instead of guessed cards. Each numbered cloze and each direction has its own stable progress.

Review is a pane on the outline measure, like Library. Its toolbar holds the deck picker (a saved deck or All cards), Due, New and All tabs with counts, Open reviews when another review is open, and a Deck actions menu. Decks compose source type, text and field predicates; their editor shows how many cards the draft matches and saves a query, never a copied card collection. A status line under the toolbar shows Start review and the card count, `N left` during a review, Nothing due or Queue complete with Finish review, and the pending command, without inserting rows above the card.

The card is a bordered panel; focus turns its border to the accent. A meta row shows the source path, which opens the canonical block (Shift opens it beside review), Reverse or Cloze N for those kinds, and Reset progress once a reviewed card is revealed. The prompt and answer use the h2 size without side labels; a rule separates them. A cloze shows its gaps as tinted slots holding `…` or the hint, and reveals in place with each answer marked, so the sentence appears once. Review history appears only for reviewed cards, newest first.

Space reveals the answer; 1–4 select Again, Hard, Good and Easy. Buttons show the next interval in days, then months and years. A source or schedule change invalidates the shown snapshot and requires Review current card before grading. Changed wording retains identity and progress; the card shows the last reviewed text beside its current text, with Keep progress and Start over choices. Reset progress requires confirmation and keeps review history.

The current card stays until a grade is acknowledged. Pending commands survive offline reload with their original request bytes; rejection preserves the command for copying and requires a fresh card snapshot. Unrelated local page edits do not invalidate the shown card. Finishing, abandoning or switching an open review is explicit; committed grades and their shown-text evidence remain. Pane history and reload preserve the deck, queue selection and session.

## Library and reading

Library is a pane. Its header holds state tabs with counts (Inbox, Reading, Finished, Abandoned, All), then Highlights with its unprocessed count; under them a 28 px search field, a sort menu (Added, Title, Last read, Progress), Add, and an Export menu (BibTeX, CSL JSON, Markdown) for the selection or the listed sources. Rows are one 28 px line: a leading slot with the cover thumbnail or a book or article icon, the title, the byline in `--muted` (creators, else site; then year), and trailing fixed-width columns for progress and the unprocessed highlight count, so figures line up across rows. The byline truncates before the title. The leading slot shows a selection checkbox on hover, focus, or while any row is selected; a selected row takes `--selection` and the accent bar. While rows are selected, a bar replaces the search line: the count, Mark as (one batch for all of them), Export and Clear selection; Escape clears. Clicking a row opens the source page; Shift opens it beside. A row menu offers Read, Mark as reading, finished or abandoned, Return to inbox and Export.

Add is a popup with one field that takes a URL, and Choose EPUB… for files; dropping an EPUB on the Library pane does the same. Each submission becomes a job row above the sources while queued, running or failed: a state icon, the name without its extension, the state, and the error sentence on a second line aligned with the name, with Retry and Dismiss on failures. Dismissal is a device preference per notebook. Finished jobs leave the list once the source appears in the current view. The Highlights tab shows no jobs.

Highlights lists cited blocks newest first, grouped by source in the order sources first appear, Unprocessed by default with an All toggle. A group heading is the source title, which opens the source page, with its count. Each card has its colour dot in a hanging column, the block text, a meta line (section, `¶N`, date, tags) and the quoted passage when the text has been rewritten. Colour filters are dot-only toggles. A highlight is processed once it has a child, a card or an incoming reference, so working the list means writing under highlights, linking them or making cards from them; that sentence is the Unprocessed button's tooltip and the empty state. Clicking edits the block in its source outline; Shift opens it beside.

A source page shows a header under its title: creators, year and site in `--muted`, a state menu button, progress, Read, and a menu with Copy citation key, Export BibTeX, Export CSL JSON and Snapshots. Metadata stays ordinary fields beneath it. A value that differs from what the current snapshot extracted offers Reset to extracted in its field menu.

The reader is a pane: the pane header shows the source title, which opens the source page; inside, Contents (a picker over the table of contents), Find in source and progress; body at the outline measure with 16 px passage text in `--text`, headings at the h1–h3 tokens, footnote references as superscript links that open the note in a popover, images at their natural size up to the measure. Reading position and coverage save while scrolling; opening from a citation scrolls to the passage and flashes it without counting as reading. Progress shows `<1%` once reading has started. Selecting text shows a small toolbar above the selection with Highlight (`H`) and Highlight and note (`N`); both append a block quoting the selection to the source page, and the second also starts an empty child and opens the highlight beside the reader with the caret there. An empty note does not mark the highlight processed. Existing highlights tint their ranges with `--selection`; clicking one opens its block beside the reader, Shift in the same pane.

A block with a citation shows a citation chip in its capability metadata: the source's short title (before any subtitle colon, cut at a word within 40 characters) and the passage number, `¶231`. Clicking opens the reader at that passage; Shift opens it beside. A block whose text no longer equals the quote shows the quote beneath it in `--muted` with a quotation rule, so a paraphrase or cloze keeps its evidence visible.

## Popups and feedback

Floating layers open below the element or caret that opened them, with a 4 px gap, start-aligned unless the anchor is in the viewport's right half, flipping above only when below is too short, clamped to the viewport, never covering the anchor. Find or create opens beneath the global search trigger; the dedicated command palette centres near the top of the viewport. Escape closes the topmost one and returns focus. Closing retires input handlers immediately; only an inert, accessibility-hidden visual remains for the brief exit animation. It has no IDs and cannot steal focus from a successor popup. Reduced motion removes it immediately.

Four shapes only, so every popup is recognisable at a glance:

- **Menu**: 28 px rows with an icon slot, label and shortcut at the right; sections as 12 px labels; danger last. The icon column is reserved whenever any item has one, so labels align.
- **Picker**: an input on top and 28 px rows below. Arrows move, Enter picks, typing filters, the mouse hovers to highlight. Chips before the input show steps already chosen. Used by the palette, reference completion, Add type, Add filter and the time zone.
- **Confirm**: 13 px body text and two buttons.
- **Preview**: a read-only card for a reference's target, described under "Reference previews" below.

| Surface | Shape | Placement |
|---|---|---|
| Find or create: pages, blocks and explicit page creation; `>` finds commands | Picker, one line per hit with the page path in meta size; Tab drills into children | Below the global search trigger, 560 px |
| Dedicated command palette | Picker, with action sections and shortcuts | Top centre, 560 px |
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

Resting the mouse on a `[[reference]]` for 350 ms opens a preview card, in the outline, the active editor and every other surface that renders references. Moving to another reference while a card is open takes a third of the delay, and a 200 ms grace period covers the gap between a reference and its card. A page card shows its breadcrumb, title, types, source or task state, and its first ten visible blocks; a block card shows its path, its parent in `--faint`, the block on the accent tint and its first descendants. The body clips at `--preview-body-height` and fades only when it overflows. The footer counts backlinks and offers Beside and Open (Go to block for blocks). References inside a card open stacked cards; leaving closes every card above the one under the pointer. ⌘ pins the topmost card, which then stays open and scrolls. ⌥Space opens the card for the reference at the editor caret or the focused reference; Enter opens it, Shift+Enter opens it beside, Escape closes it without leaving the editor, and any other key closes it and types. A deleted target shows a one-line notice. The card never takes focus, and touch input never opens one.

## Decisions

1. Font: IBM Plex Sans. Density: 28 px rows.
2. Handle and fold in a gutter outside the measure; bullets inside it, filled.
3. Shift is the one "open beside" modifier.
4. Fields, Settings, tables and views are panes, not dialogs.
5. Pills are hue-tinted at meta size; bullets stay neutral.
6. Tables divide rows, not columns; the title column is sticky.
7. A permanent global rail owns notebook-wide actions; pane headers own document actions.

## Open

- Type hue assignment: by a stable hash of the type title, or chosen per type and stored on the type page.
- Whether single-value field rows should also fold into the parent block's line.
- Column resizing and per-view column widths.
