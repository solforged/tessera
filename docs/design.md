# Design

How the browser client looks and behaves. Tokens live in `web/src/tokens.css`; components use tokens, never raw values. This carries over the system remcard settled on in its `design-language.md`, keeps what worked, and adds the surfaces tessera has that remcard did not: saved views, a Fields destination and settings as panes.

Status: decided; applied to the shell, the outline and the table. Later stages add their sections here before they are built.

## Principles

1. **The text is the interface.** Controls stay quiet until hover, focus or selection, and every action is also reachable from a visible control.
2. **Act where you are looking.** Controls attach to the block they affect. Popups open at the caret or at their trigger, never at a pane edge.
3. **One meaning, one form.** Structure is a neutral bullet. A type is a tinted pill with its name. Task state is a glyph. Colour never carries meaning alone, and type hues never reuse status hues.
4. **Work happens in panes.** Tables, views, fields, settings, search results and references open in a pane. Dialogs are for short controls and confirmations only.
5. **Summaries in the row, details on selection.** A block shows its state as compact trailing metadata; field rows appear as children under it.
6. **Calm dark.** Surfaces step up in lightness with elevation. One accent marks focus and primary actions. Only floating layers cast shadows.
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

Steps 2, 4, 8, 12, 16, 24, 32, 48 px. Row height 28 px; indent 24 px; measure 760 px; gutter 48 px left of the measure; sidebar 208 px. Pointer targets 24 px, touch targets 44 px. Icons 16 px, 14 px inline.

### Colour

| Role | Token |
|---|---|
| Shell: sidebar, table headers, banners | `--surface` |
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

Radius 4 px for controls, 8 px for popups, full for pills. Popups have a 1 px `--line` border and `--popup-shadow`; dialogs `--dialog-shadow`. Rows and tables cast none.

## Shell

- **Sidebar**, 208 px, collapsible to a compact toolbar. Only daily destinations: the notebook name as a menu (Commands, Fields, saved views, Settings, Vim); Search; Today with the journal stepper indented beneath it; Pinned, shown only when something is pinned; Recent; and New page pinned to the bottom. Rows are 28 px with one left edge: icons at 8 px, text and section headings at 32 px. The row for the active pane's target gets the 2 px accent bar. Agenda and Review join Today when tasks and cards exist. Destinations open in the active pane; Shift-click opens beside. One modifier everywhere: Shift means beside, in the sidebar, in tables and in menus.
- **Panes.** Up to two, split equally. Each has a header: back and forward, breadcrumbs or the pane title, the page menu, save state, the Vim mode when on, and Close on the side pane. Errors needing action sit under the header until resolved. Non-page panes (table, fields, settings) share page padding and background.
- **Measure.** Outline content is at most 760 px, centred, with a 48 px gutter to its left for row controls. Two panes split the width; text never shrinks to fit.

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
- **Trailing metadata** (stage 3: dates, repeat, reference count) sits at the right edge of the measure so it scans as a column.
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

## Tables and views

A table is a query shown as rows: a type's members or a saved view.

- **Header**: the type pill, the view name as a menu button (Save as view, Rename, Delete, Discard changes), and "Saved view" or "Unsaved changes" at the right.
- **Toolbar**: a 16 rem search field, then filter chips and the sort chip. A chip shows its field and operator and removes with its own ×; the trailing "+ Filter" and "Sort" buttons add more. Chips wrap on narrow panes.
- **Grid**: header row on `--surface`, meta size, sticky. The title column is sticky at the left with the page name under the text in `--faint`. Cells are 13 px, rows at least 28 px, divided by horizontal lines only. Numbers right-aligned and tabular. Multi-value cells show one pill per value. An unreadable value gets a dotted warning underline, never a rewrite.
- **Columns**: the type template's fields first, then fields present on members. The trailing `+` adds a column and sets a kind. Column menus offer sort, filter by this field, change kind, remove from template.
- **Footer**: "N of M rows", and the load error with Retry when a request failed.
- **Empty states** say what to do: no members yet for a type, no matches for a filter set, with a control that clears filters.
- Rows open the block in the active pane; Shift-click opens beside.

## Popups and feedback

Floating layers open below the element or caret that opened them, with a 4 px gap, start-aligned unless the anchor is in the pane's right half, flipping above only when below is too short, clamped to the viewport, never covering the anchor. Palettes centre near the top of the viewport instead. Escape closes the topmost one and returns focus.

Three shapes only, so every popup is recognisable at a glance:

- **Menu**: 28 px rows with an icon slot, label and shortcut at the right; sections as 12 px labels; danger last. The icon column is reserved whenever any item has one, so labels align.
- **Picker**: an input on top and 28 px rows below. Arrows move, Enter picks, typing filters, the mouse hovers to highlight. Chips before the input show steps already chosen. Used by the palette, reference completion, Add type, Add filter and the time zone.
- **Confirm**: 13 px body text and two buttons.

| Surface | Shape | Placement |
|---|---|---|
| Palette: text searches blocks, a leading `>` finds commands | Picker, one line per hit with the page path in meta size; Tab drills into children | Top centre, 560 px |
| `[[`, `#`, `Name::` completion and Add type | Picker | Below the caret or the block |
| Add filter | Picker in three steps: field, condition, value; Backspace on an empty query steps back | Below its trigger |
| Block menu | Menu in sections Block, Move, Select; navigation stays in the palette | Below the handle |
| Page, notebook, pill, column, view, sort and field kind menus | Menu | Below their trigger |
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

## Open

- Type hue assignment: by a stable hash of the type title, or chosen per type and stored on the type page.
- Whether field rows under a block collapse into a summary line when the block is not selected.
- Column resizing and per-view column widths.
