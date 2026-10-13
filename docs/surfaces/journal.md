# Journal and today

Journal days present spoken dates and writable outlines. Today adds Agenda, Review and Reading tiles; Add to today captures without leaving what is open.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Add to today

Add to today is Tana-style quick capture: one line becomes one block at the end of today's journal, reusing a trailing empty block, without leaving what is open. ⌘E (the palette's Add to today) opens it as a slip centered near the top, 560 px. On the cover it rises from the bottom edge above the keyboard.

A mono rubric line reads `Add to today` in gilt and `Sun 11 · end of journal` in `--faint`. The line itself is in the writing voice, its kind glyph in the bullet slot.

### Line kind and completions

- ⌘Enter or the glyph switches between a note and a task.
- `[] ` or `[ ] ` at the start of the line also makes it a task and disappears, as in the outline. Backspace on an empty task line returns to a note; a pasted or restored prefix saves as a task too.
- Card syntax shows the index-card mark in the glyph slot unless the line is a task.
- `[[` completes pages (with Create page) and `#` pages used as types (with Create type), matching titles and aliases in a picker under the line. Type results never include matching note bodies. A hand-typed `[[Title]]` links as it would on leaving a block.
- An `@date` plans the line and so makes it a task, with the [same preview as Add a task](tasks-agenda.md#add-a-task). A plain-word date suffix plans only a task.

### Adding and saving

| Input | Behavior |
|---|---|
| Enter | Adds and closes |
| Shift+Enter | Adds and keeps the line for the next item, with `N added to today` in place of the key hints |
| Escape | Closes an open completion first and then the slip |
| Touch screens | Replace keyboard hints with Cancel and Add; the empty line reads `Add a note or task` |

The line clears once the whole capture is in the local outbox and saves in order, so a fast second line is never dropped. Reload resumes every accepted capture, including its task plan and chosen references. If local storage fails, the line keeps its text.

### macOS capture

The macOS app's File › New Capture (⌘E) opens the same slip. ⌘⇧E anywhere on the Mac opens it as a floating panel over the current app, or the slip when Tessera is in front.

The panel stays 600 px wide, fits its contents before showing, and grows downward from a fixed top edge for previews, errors and completions, up to 340 px. It shrinks when those rows disappear, keeps an unsaved draft when it loses focus, and Enter or Escape returns to the previous app.

### Android capture

The launcher's New note and New task shortcuts and text shared to Tessera open the slip over the current page, the shared text as its line.

## Journal dates

Journal days present a spoken date such as Saturday 10 October beneath a mono period trail: `2026 · Q4 · October · Week 41`.

The latest navigation request wins in its pane. Previous and next step from a pending journal date, and a superseded lookup does not create a missing journal. Before a new journal root is committed, missing reference reads show quiet zero counts rather than unavailable sections; successful reads still show real backlinks, and related sections refresh when the root becomes committed.

Quiet dotted underlines make the segments clickable, brightening to gilt on hover; the open segment has a 2 px gilt rule instead. Each segment toggles one inline ledger beneath the heading. Tapping it again or Escape closes it.

The trail names the period being inspected. Opening a week from a month, or a month from a year or quarter, moves the trail's labels to that period, and closing the ledger returns them to the displayed day. The week ledger is headed like a month, `Week 41 5–11 October`. Opening a finer period from inside a ledger scrolls just enough to bring that ledger into view.

The period trail keeps even visible gaps around its separators. Touch hit areas extend to at least 40 px without widening the labels.

### Period ledgers

| Period | Ledger |
|---|---|
| Week | Monday through Sunday |
| Month | ISO week numbers at the left open the corresponding week, including the neighboring ISO week-year at New Year |
| Quarter | Its three months; a narrow quarter stacks its months |
| Year | Twelve months in four columns, two on the cover |

On touch, mini months are whole-month buttons with non-interactive day overviews. Choosing one opens the full month with day targets at least 40 px square. Touch mini-month overviews reserve six calendar rows and align at the top so neighboring months share their title and weekday baselines. Fine-pointer mini months retain direct day buttons.

### Written-day marks

Only journals with non-empty visible text get muted filled day marks, independently of visiting or selecting the day. Today is ringed in gilt and the displayed journal day has a gilt rule. The bounded written-day read refreshes after committed text changes, keeping the previous marks visible until the refreshed data arrives.

Day buttons speak the full civil date and open through the existing journal path. The root text remains ISO and other pages retain their own titles.

## Integrating a thought

Integrate, in a journal block's menu, palette and slash menu, opens the destination picker. Pages come first; typing also searches blocks. Choosing a destination moves the block with all its children to the end of that page or block. The journal keeps a live reference in its old place, so the moved text stays readable there.

The move and reference are one transaction. Undo restores the original place and removes the reference. The change notice offers Undo, and the outline's Undo command uses it while the notice is present. Outside journal days, Integrate is not offered.

## Today tiles

Today alone leads with Agenda, Review and Reading tiles above the Journal rule and writable outline.

Desktop and unfolded Today tiles are at least 120 px tall, enough for the tallest loaded Reading content including the book map, and grow with their content. Their placeholders keep the same height. The three desktop tiles reserve their loaded height while requests show quiet placeholders.

A journal narrower than 640 px uses one ruled list of compact Agenda, Review and Reading rows, with the book map below the Reading row.

### Agenda tile

Agenda counts the items in the [Agenda pane's Today section](tasks-agenda.md#groups) separately from Overdue and shows the next timed or untimed item. Its chevron folds today's tasks open beneath the tiles, open by default and remembered per device.

That ledger uses the [Day rows](tasks-agenda.md#rows), with their time gutter, completion, [rescheduling keys and now rule](tasks-agenda.md#rescheduling), and ends in `Open agenda ›`. Tasks written in this journal are left out, since the outline below already shows them with their plan: a muted `N more in the journal below` follows the rows, or `N planned in the journal below` replaces Nothing planned today. Carried work collapses to one `N carried over` line in `--danger` that expands in place, with Move to today at its end and the [same Undo line](tasks-agenda.md#groups).

When no tasks are planned, the Agenda tile says Nothing planned today once; the open ledger keeps only Open agenda, without a duplicate empty message or reserved empty-row height.

### Review tile

Review uses the sidebar's same due-card query and opens the [review landing](cards-review.md#landing-and-decks).

### Reading tile

Reading continues the most recently read EPUB still in Reading, with:

- Its cover.
- A short title using the [citation-chip rule](library.md#citation-chips).
- Resolved chapter time left, then the chapter's numeral and title on a second line; narrow journal rows keep that chapter context and grow to fit it.
- Segmented [BookMap](reader.md#book-map) with real highlight marks.

Front matter and unresolved contents use whole-book time left instead of inventing a chapter. A coarse pointer at 900 px or wider opens the book beside the journal.

## Touch outline

Touch journals keep only the bullet left of the text, with the heading and the right edge at the pane inset. Task status replaces the bullet rather than adding a second indent. Nested rows retain the same depth increment and block actions no longer narrow the row when selected.

## From your highlights

Below the outline, From your highlights shows one resurfaced highlight at a time with an `N of M` counter and previous/next controls, preserving Open, Keep, Mute and the device's collapse preference. No reading-session duration, pace or finish estimate is shown.

## Research to revisit

Today lists due notes and questions beside From your highlights, earliest first, with their title, kind or question state and revisit date. Open in Review selects that item in the Questions and notes queue. The section stays hidden when nothing is due.
