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
| Text primary, secondary, tertiary | `--text` `--muted` `--faint` |
| Accent and focus ring | `--accent` |
| Warning, danger | `--warning` `--danger` |
| Type hues, pills only | `--type-1` to `--type-6` |
| Task states, stage 3 | `--status-*` |

Pills take a 12% tint of their hue with a 30% border. A selected row adds a 2 px accent bar at its left edge.

### Shape and elevation

Radius 4 px for controls, 8 px for popups and the workspace frame, full for pills. Popups have a 1 px `--line` border and `--popup-shadow`; dialogs `--dialog-shadow`. The workspace frame has a 1 px `--line` border and no shadow. Rows and tables cast none.

### Motion

Motion acknowledges an action without delaying it: 140 ms for popup entry and sidebar movement, 90 ms for popup exit and hover feedback, with a short ease-out and no bounce. Popups travel 4 px; clickable button icons scale subtly on hover, focus and press. Recent expands and collapses in place. Reduced motion sets durations and travel to zero and disables icon scaling.

## Shell

- **Global rail.** Permanent across one or two panes. The left holds the sidebar toggle and notebook-name menu (Fields, Settings); Vim is toggled only in Settings. The right groups Find or create and the Commands icon in one 320 px search-shaped control, followed by an icon-only Layout button. Find or create opens its picker beneath the search trigger; Commands opens the command palette. Layout opens the active view beside, switches panes, closes the active pane or toggles the sidebar. Global controls are never duplicated inside pane headers.
- **Sidebar**, 208 px. Today, Agenda and Review; Pinned, shown only when a page or saved table view is pinned; unpinned saved Views; and collapsible Recent. Saved table views have a pin control on hover or keyboard focus; pinning is stored per notebook alongside page pins. Task views and decks are selected in their own destinations. Rows are 28 px with one left edge: icons at 8 px, text and section headings at 32 px. The row for the active pane's target gets the 2 px accent bar. Destinations open in the active pane; Shift-click opens beside.
- **Workspace frame.** The panes share one inset canvas, with a 12 px outside gutter at the right and bottom and an 8 px corner radius. Collapsing the sidebar adds the same gutter on the left. The rail and sidebar use the same shell surface.
- **Panes.** Up to two, split equally. Each has a header: back and forward, breadcrumbs or the pane title, the page menu, save state, the Vim mode when on, and Close while split. Journal headers also hold their own previous-day, calendar and next-day controls; these always target the owning pane. Page errors stay under their owning header. Notebook recovery feedback appears once above both panes, so activating a pane cannot move a control between pointer-down and click. Non-page panes (table, fields, settings, agenda, review) share the workspace frame.
- **Narrow layouts.** Below 1048 px the sidebar becomes a toggleable overlay. Hidden navigation is inert immediately, including during its exit. Below 840 px working-pane tabs show one pane at a time. Below 600 px Find or create, Commands and Layout retain accessible labels on icon controls, and the workspace gutter shrinks to 4 px. The global rail remains visible in every layout.
- **Later destinations.** Library joins the sidebar when its workflow exists; the shell has no inactive placeholders. Reading will use a source pane beside authored notes, with document actions kept local to each pane.
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
- **Bullet** is a filled dot in `--muted`, 24 px target. Click to zoom, drag to move. The page title aligns with the bullet column.
- **Text** is the block body. References render inline in the accent with a soft underline; wrapped references align left.
- **Type pills** follow the text at meta size. Clicking a pill opens a menu: open the table, open the type page, remove a manual membership. A text membership says so instead of offering removal.
- **Field entries** are children rendered with a field icon and muted name. Values are ordinary child blocks.
- **Capability metadata** follows the source text without replacing it. Task glyphs open status choices; planning summaries show schedule, deadline, priority and repeat. Project and review controls open the attached capability. Controls wrap in narrow panes rather than shrinking authored text.
- **Headings** are block styles at the h1 to h3 tokens, semibold. `# ` at block start sets one.
- Rows highlight on hover with `--hover`; selection uses `--selection` plus the accent bar.

### Row mechanics

Settled by the 2026-10-02 audit; each rule has a document-layer test in `web/src/document/outline-*.test.ts`.

- **Enter** at the end of a block with children inserts its first child; at the end of a leaf, a sibling after it; at the start, an empty block above with the caret staying in the text; mid-text, the right part moves to a new block and the original id stays on the left. Enter inside a `[[reference]]` or `#tag` does nothing.
- **Backspace** at the start merges into the previous visible row (a sibling's last unfolded descendant, never a folded hidden row), the merged block's children follow it. A first child with no previous sibling outdents instead. Deleting into a reference removes the whole token; undo restores the original caret.
- **Delete** at the end joins the next sibling, appending its children in order.
- **Arrows** at a row boundary cross to the neighbouring row keeping the visual column; Escape keeps the caret offset so the next Enter or `i` resumes there.
- **Indent, outdent and move** act on the selection's roots with their subtrees, never leave the zoomed subtree, and are silent no-ops without a history entry at a boundary (no previous sibling, top level, first or last sibling). Outdent leaves the following siblings under their original parent. A multi-row selection survives the command.
- **Delete** of a subtree selects the previous visible survivor; folding a descendant selects the folded parent; zooming out selects the block being left.
- **Capability identity** stays on the original block through moves, end splits, undo and restoration. Merging away retained task, project or review history is refused. An interior split cannot divide active card syntax; moving reviewed syntax onto a new source identity is also refused.

## Fields

The notebook menu opens a searchable index with Name, Kind, Used by and Templates columns. Names open the definition in its source outline; template names open their type table. Used by opens the distinct owning blocks, including entries with no values. Shift opens any of these beside the index. Controls remain visible on narrow panes.

Changing kind preserves value text and supports undo and redo from the index. Edit definitions opens the Fields page, where names and choice options remain ordinary blocks. Filtering the index does not change definitions; an empty result offers Clear filter.

## Tables and views

A table is a query shown as rows: a type's members or a saved view.

- **Header**: the type pill, the view name as a menu button (Save as view, Rename, Delete, Discard changes), and "Saved view" or "Unsaved changes" at the right.
- **Toolbar**: a 16 rem search field, then filter chips and the sort chip. A chip shows its field and operator and removes with its own ×; the trailing "+ Filter" and "Sort" buttons add more. Chips wrap on narrow panes.
- **Grid**: header row on `--surface`, meta size, sticky. The title column is sticky at the left with the page name under the text in `--faint`. Cells are 13 px, rows at least 28 px, divided by horizontal lines only. Numbers right-aligned and tabular. Multi-value cells retain every value; choice and instance values use pills. An unreadable value gets a dotted warning underline, never a rewrite.
- **Editing**: Enter or double-click edits a single plain text, number or date value inline. Multiple values, references, choices, instances and checkboxes open the field's source outline beside the table. Clearing a value preserves its block and child notes; refilling reuses a blank value block. Inline editors do not replace structured text with a rendered label.
- **Columns**: the type template's fields first, then fields present on members. Fields used by filters remain visible even when every value is empty. The trailing `+` adds a column and sets a kind. Column menus offer sort, filter by this field, change kind, remove from template.
- **Footer**: "N of M rows", and the load error with Retry when a request failed.
- **Empty states** say what to do: no members yet for a type, no matches for a filter set, with a control that clears filters.
- Rows open the block in the active pane; Shift-click or Shift-Enter opens beside.

## Tasks, projects and agenda

Make task is available from block and page menus. Alt-Enter toggles a task; Alt-S opens its schedule picker. Task state, dates, optional times, deadline warning, priority and repeat are anchored controls, not text prefixes. A trailing quick-date token such as `@friday` on a task is accepted with Enter; the rest of the source text stays intact. Ordinary field shorthand still takes precedence.

Completion uses the displayed journal or agenda date. Repeating tasks retain their source identity and advance their plan; history on an earlier day shows that occurrence's plan, not the next repeat. A running work session requires an explicit stop, with Stop and complete offered as one atomic action. Work-session notes and prior sessions remain accessible from the block menu.

Project controls edit outcome, deadline and status. Show actions opens a task query over canonical descendants. Completing a project does not complete its tasks.

The Agenda destination switches between the displayed day's agenda and a composable Tasks query. Status, priority, project, independent scheduled/deadline ranges, source type, text and fields combine before the result limit. Named task views preserve that query and its date context. Journal agendas use the same canonical rows; clicking opens the source and Shift-click opens it beside. Completion and planning never insert copies into the journal.

## Cards and review

Author `front >> back`, `front << back`, `front <> back`, or numbered clozes such as `{{c1::answer::hint}}` in ordinary blocks. `::` remains field shorthand. Explicit malformed syntax shows diagnostics instead of guessed cards. Each numbered cloze and each direction has its own stable progress.

Review selects a saved deck or all cards, with Due, New and All queues. Decks compose source type, text and field predicates. Their editor saves a query, never a copied card collection.

Space reveals the answer; 1–4 select Again, Hard, Good and Easy. Buttons show the corresponding next interval. Source opens the canonical block; Shift opens it beside review. A source or schedule change invalidates the shown snapshot and requires Review current card before grading. Changed wording retains identity and progress; the card shows the last reviewed text beside its current text, with Keep progress and Start over choices. Reset progress requires confirmation and keeps review history.

The current card stays until a grade is acknowledged. Pending commands survive offline reload with their original request bytes; rejection preserves the command for copying and requires a fresh card snapshot. Unrelated local page edits do not invalidate the shown card. Finishing, abandoning or switching an open review is explicit; committed grades and their shown-text evidence remain. Pane history and reload preserve the deck, queue selection and session.

## Popups and feedback

Floating layers open below the element or caret that opened them, with a 4 px gap, start-aligned unless the anchor is in the viewport's right half, flipping above only when below is too short, clamped to the viewport, never covering the anchor. Find or create opens beneath the global search trigger; the dedicated command palette centres near the top of the viewport. Escape closes the topmost one and returns focus. Closing retires input handlers immediately; only an inert, accessibility-hidden visual remains for the brief exit animation. It has no IDs and cannot steal focus from a successor popup. Reduced motion removes it immediately.

Three shapes only, so every popup is recognisable at a glance:

- **Menu**: 28 px rows with an icon slot, label and shortcut at the right; sections as 12 px labels; danger last. The icon column is reserved whenever any item has one, so labels align.
- **Picker**: an input on top and 28 px rows below. Arrows move, Enter picks, typing filters, the mouse hovers to highlight. Chips before the input show steps already chosen. Used by the palette, reference completion, Add type, Add filter and the time zone.
- **Confirm**: 13 px body text and two buttons.

| Surface | Shape | Placement |
|---|---|---|
| Find or create: pages, blocks and explicit page creation; `>` finds commands | Picker, one line per hit with the page path in meta size; Tab drills into children | Below the global search trigger, 560 px |
| Dedicated command palette | Picker, with action sections and shortcuts | Top centre, 560 px |
| `[[`, `#`, `Name::` completion and Add type | Picker | Below the caret or the block |
| Add filter | Picker in three steps: field, condition, value; Backspace on an empty query steps back | Below its trigger |
| Block menu | Menu in sections Block, Move, Select; navigation stays in the palette | Below the handle |
| Page, notebook, layout, pill, column, view, sort and field kind menus | Menu | Below their trigger |
| New page, Delete page | Confirm | Below their trigger |
| Undo toast | Bottom centre, one at a time |
| Save state | Pane header, never a toolbar |

Native `<select>` is never used; a bordered menu button or a picker replaces it.

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
- Whether field rows under a block collapse into a summary line when the block is not selected.
- Column resizing and per-view column widths.
