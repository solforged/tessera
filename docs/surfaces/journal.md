# Journal and today

Journal days present spoken dates and writable outlines. Today adds Agenda, Review and Reading tiles; Add to today captures without leaving what is open.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Add to today

Add to today (⌘E) opens the shared creation slip centered near the top, 560 px wide. On the cover it rises from the bottom edge above the keyboard; New in the center of the bottom nav opens the same Note-into-Today sheet. Commands finds Add to today through capture, quick note, inbox or journal. A mono rubric names the action in gilt and its destination in `--faint`.

The Kind row offers Note, Question, Task, Card and Source; More offers Project and the workshop's page kinds. Arrow keys select a kind. Until a kind is chosen explicitly, a trailing `?` infers Question, `[] ` or a planning `@date` infers Task, complete card syntax infers Card, and a whole URL, ISBN, DOI or arXiv identifier infers Source. The draft carries across kind switches.

Into offers Today, New page (notes and questions), and Page…. Notes, tasks and cards default to Today; questions default to New page. An explicit destination stays selected while the kind changes. ⌘N starts Note into New page. Index, ledger and table buttons lock their kind and hide both controls.

Page drafts show kind-specific field rows beneath the gist: Parent question, Revisit, Recurrent and First perspective for questions; Deadline for projects; and up to four template fields for typed pages. A project's gist sets its outcome rather than repeating it in its body. Fields use the page's label/value voice and the table's editors, stay full-width on the cover, and save in the creation batch. Filing an existing title keeps already-filled fields read-only.

### Line kind and completions

- A note, question or task line appends at the end of Today or the chosen page, reusing a trailing empty block. A question adds its question state in the same batch.
- `[] ` and `[ ] ` task prefixes disappear on save. The Kind row replaces the old ⌘Enter note/task toggle.
- `[[` completes pages (with Create page) and `#` pages used as types (with Create type), matching titles and aliases in a picker under the line. Type results never include matching note bodies. A hand-typed `[[Title]]` links as it would on leaving a block.
- An `@date` plans a task, with the [same preview as Add a task](tasks-agenda.md#add-a-task). A plain-word date suffix plans only a task.

### Adding and saving

| Input | Behavior |
|---|---|
| Enter in a line | Adds and closes |
| Shift+Enter in a line | Adds another, keeps the slip open and shows `N added` |
| Enter in a page draft | Creates and opens with the body caret |
| Shift+Enter in a page draft | Creates and opens beside |
| ⌘Enter | Submits from any field |
| Shift+⌘Enter | Submits and keeps the same kind ready for another |
| Escape | Closes an open completion first and then the slip |
| Cover sheet | Hides keyboard hints and Cancel; the sheet's Close dismisses it |

Line drafts clear once accepted by the local outbox; cards keep their draft until acknowledgement. Reload resumes every accepted capture, including its destination, question state, task plan and chosen references. If local storage fails, the line keeps its text. Line, card and source creation in the slip never navigate: a shell notice confirms Added to today, Added to the chosen page, Card added or Added to library, with Open. For queued imports, Open shows the source when ready or the Library inbox while the job is pending. Lines and cards also offer Undo, deleting the inserted row or restoring a reused empty row. The notice uses the same eight-second, hover-and-focus-paused surface as page-deletion Undo.

### macOS capture

The macOS app's File › Add to Today (⌘E) and Dock › Add to Today open the same slip. ⌘⇧E anywhere on the Mac opens it as a floating panel over the current app, or the slip when Tessera is in front. The Send to Tessera text Service opens the floating panel and replaces its draft from the `tessera-quick-capture` event's parsed kind and text before focusing it.

The panel stays 600 px wide, fits its contents before showing, and grows downward from a fixed top edge for kind fields, previews, errors and completions, up to 560 px. It shrinks when those rows disappear and keeps an unsaved draft when it loses focus. Line, card and source saves or Escape return to the previous app; a page-kind creation uses the native open bridge to show the page and its body caret in the main window instead.

### Android capture

The launcher's New note, New task, New question and Add to library shortcuts open the slip over the current page with the corresponding creation kind. Text shared to Tessera opens a note request with the shared text as its line; the slip can infer a source or question from that text.

The resizable Tessera home-screen widget starts at 4×1 and offers Note, Task and Question. Its preview description is Capture to Tessera. The Tessera note Quick Settings tile closes the shade and opens a note request. Each tap opens the slip again, including while the app is already running.

Each request opens the creation slip on its kind: Note and Task into Today, Question as a new page, Add to library as Source. File sharing and Open with accept EPUB, not PDF: the library import inbox only supports EPUB.

## Journal dates

Journal days present a spoken date such as Tuesday, October 13 beneath a short mono period trail: `2026 · Oct · W42`. Agenda's date heading and journal backlink groups speak dates the same way (`Tuesday, October 13, 2026`). One module forms these dates, so their shape can become a setting.

The latest navigation request wins in its pane. Previous and next step from a pending journal date, and a superseded lookup does not create a missing journal. Before a new journal root is committed, missing reference reads show quiet zero counts rather than unavailable sections; successful reads still show real backlinks, and related sections refresh when the root becomes committed.

Quiet dotted underlines make the segments clickable, brightening to gilt on hover; the open segment has a 2 px gilt rule instead. Each segment toggles one inline ledger beneath the heading. Tapping it again or Escape closes it.

The trail names the period being inspected. Opening a week from a month, or a month from a year or quarter, moves the trail's labels to that period, and closing the ledger returns them to the displayed day. The quarter has no segment of its own; `Q4` joins the trail only while the quarter ledger is open (from This quarter in the palette). The week ledger is headed like a month, `Week 42 October 12–18`. Opening a finer period from inside a ledger scrolls just enough to bring that ledger into view.

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

## Making a project

Make project on a journal block makes it a [project page](tasks-agenda.md#projects) and leaves the block as its link, with its children moved onto the page. The day keeps the record of where the project started, and the page collects tasks from later days.

## Today tiles

Today alone leads with Agenda, Review and Reading tiles above the Journal rule and writable outline.

Journal days' own sections, Journal and From your highlights, head as H2s: the name in Piazzolla at `--text-h2` (18 / 26) in `--text`, then the hairline rule and any mono state and chevron. Both are `h2` elements.

Desktop and unfolded Today tiles are at least 120 px tall, enough for the tallest loaded Reading content including the book map, and grow with their content. Their placeholders keep the same height. The three desktop tiles reserve their loaded height while requests show quiet placeholders.

A journal narrower than 640 px uses one ruled list of compact Agenda, Review and Reading rows, with the book map below the Reading row.

### Agenda tile

Agenda counts the items in the [Agenda pane's Today section](tasks-agenda.md#groups) separately from Overdue and shows the next timed or untimed item. A task without authored text reads `Empty task`, as in Agenda rows. Its chevron folds today's tasks open beneath the tiles, open by default and remembered per device.

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

Below the outline, From your highlights shows one resurfaced highlight at a time with an `N of M` counter and previous/next controls, preserving Open, Keep, Mute and the device's collapse preference. Keep reserves its checkmark's room, so the actions do not reflow when checked. No reading-session duration, pace or finish estimate is shown.

## Research to revisit

Today lists due notes and questions beside From your highlights, earliest first, with their title, kind or question state and revisit date. Open in Review selects that item in the Questions and notes queue. The section stays hidden when nothing is due.
