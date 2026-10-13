# Perspectives and questions

A concept page holds several attributed readings. Questions and answers mark authored blocks, and a titled page can be a question. Tokens, shell and shared popup patterns are in [design](../design.md).

## Positions and holder rows

Make perspective, in the block menu, the palette and `/perspective`, turns a block such as `[[Plato]]` into a position; Remove perspective undoes it.

Its row names the holder in Piazzolla at control weight. The holder link is in `--text` with no underline; hover turns it gilt and underlines it. Its source's siglum hangs in the margin. A `Gist::` child drops its label and reads as the line under the holder, so the pair reads "Plato / A line of decline". At the Perspectives depth each position closes to its holder and gist.

Change holder and File under are in the block menu, palette and slash menu. Clicking the holder link in its outline attribution opens Change holder. Its picker lists People and Groups, including their refined types, before other pages. File under lists page and inline questions and concepts first. The pickers write ordinary link tokens and preserve the prose.

Use place, in the same menus, returns to the nearest ancestor question or the page. It removes the subject only when that link is a standalone token immediately after the holder. Otherwise the action shows why the author must edit the prose. Each change has one undo step; the palette names the selected reading.

### Holder and subject pages

A holder's page lists Perspectives held above its backlinks. A subject's page lists Perspectives filed elsewhere: positions about it that live on other pages, such as under a highlight. Neither repeats under Backlinks.

Clicking a listed perspective, including its holder name, opens the original position on its source page. Shift-click or Open beside opens that reading in another pane.

## Compare perspectives

### Reading sheet

Compare perspectives, in the page menu and the palette once a page has two positions filed under it, opens a reading sheet. Its toolbar names the subject in Piazzolla with a mono count. Selection starts with two readings, and the holder controls add or remove columns while retaining at least one.

Each column shows, in order:

- An unboxed source siglum.
- An 18 px holder name, with its authored Shape glyph alongside.
- The Work reference.
- A quiet "as discussed by" line for Account, when present.
- A 17 px gist and 16 px authored prose.

Shape is not its own cell. Other fields stay in the source outline, reached through the holder or Open reading (Shift beside), rather than becoming a universal questionnaire. No prose is generated from field values and differing strings are not treated as evidence of disagreement.

Actual question blocks on the subject page appear below the sheet and open their original blocks. Columns have a readable minimum width and scroll horizontally on narrow panes.

The reading sheet's heading uses the shared centered page measure and page-title tokens. Its holder choices use the mono tab strip, with gilt rules and no pressed fill.

### Compare tabs

Compare has Readings and Criteria tabs under the subject title, in the same mono strip. Criteria opens first when the subject has criteria, and the pane remembers the choice.

## Criteria matrix

### Layout and values

The criteria matrix leaves the heading on the measure and widens to the pane. A mono line counts holders, criteria and questions beside Choose holders and Edit criteria.

Each column heads with the siglum in mono, the holder in 18 px Piazzolla and the Work title in mono. Each row starts with the criterion's name in Piazzolla in a sticky first column. Columns keep a readable minimum width and the matrix scrolls sideways in a split pane.

Cells are the positions' own values. Enter or a click edits one in place, an empty cell offers Add on hover or focus, and both are undoable edits of the position's page.

Saving a cell resolves hand-typed `[[Title]]` references by title or alias, retaining the authored spelling, as in the outline. Shared names stay unlinked rather than choosing a page.

Two or more cells in a row with exactly the same text get a numbered `≡ 1 · exact repeat` mark and a footnote naming the sigla; nothing else is marked.

### Questions and criteria editing

A question that names a criterion follows that row with a `?`, its text in Piazzolla and a mono scope, `Shape · all 6` or `Shape · POL ↔ MAC only`. Other questions stay below.

Edit criteria lists the criteria with Move up, Move down and Remove and adds fields through the field picker. While the set is derived it says so, and saving stores it.

Derived criteria exclude Gist, Work and Account. Work attributes the primary work. Account names a secondary account. Neither is a comparison criterion. Evidence remains the passages cited beneath each position. Pinned perspective slips show Work and Account as separate lines too.

## Apparatus margin

### Placement

A titled page with three or more perspectives filed under it gains an apparatus margin whenever its pane fits both the measure and margin. The margin is `--apparatus-width` (240 px) wide, 48 px right of the measure. Both fit at a 1096 px content width, so a single pane on a laptop but not a split.

The column then shifts left so the pair stays centered, and the margin scrolls with the page. Zoomed views and narrower panes have no margin.

### Constellation and sources key

The margin holds the constellation, then a Sources key pairing each siglum used on the page with its source's title.

| Constellation element | Appearance |
| --- | --- |
| Page | A gilt hub |
| Its holders | On the inner ring, with blued-steel spokes and holder names in `--muted` |
| Up to twelve pages that link to it | Faint dots on an outer ring, with their titles on hover |

Every node and source opens its page; Shift opens it beside.

## Questions and answers

### Authoring

Make question and Make answer, in the block menu, the palette and `/question` or `/answer`, mark a block as a question or as an answer beneath one. A titled page can be a question from its page menu. A question reads in Piazzolla.

### Question states

The state control sits in the capability metadata with the question glyph and its state, then any review date.

| State | Color or token | Glyph |
| --- | --- | --- |
| Open | Gilt | Question glyph |
| Unsettled | `--agree` | Question glyph |
| Answered | `--status-done` | Settled glyph |
| Parked | `--faint` | Question glyph |

Clicking the state control opens the question menu: Park or Resume, Keep open or Let it settle, Set review date and Remove question.

### Answer labels and unavailable commands

An answer shows `Answer 2026-10-06`, or `Accepted` in gilt once its question accepts it, and `Aporia` when it records that no answer holds.
Remove answer removes the answer capability, not its text, and clears acceptance in the same undoable change. Undo restores both the dated answer and its acceptance.

Commands that cannot apply stay listed with their reason, such as "Resume the question before accepting an answer."
