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

- **Sidebar**, 208 px, collapsible to a compact toolbar. Order: notebook name; Search, Commands, Today with shortcuts; journal date with previous and next; Pinned; Views; Recent; New page; at the bottom Settings and the Vim toggle. Fields sits with the navigation group. Destinations open in the active pane; Shift-click opens beside. One modifier everywhere: Shift means beside, in the sidebar, in tables and in menus.
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

Floating layers open below the element or caret that opened them, with a 4 px gap, start-aligned unless the anchor is in the pane's right half, flipping above only when below is too short, clamped to the viewport, never covering the anchor. Escape closes the topmost one and returns focus.

| Surface | Placement |
|---|---|
| `[[`, `#`, `Name::` completion | Below the caret |
| Block, pill, column and view menus | Below their trigger; shortcuts shown |
| Search and Commands palettes | Top centre, 560 px wide |
| Undo toast | Bottom centre, one at a time |
| Save state | Pane header, never a toolbar |

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
