# Journal and today

Journal days present spoken dates and writable outlines. Today adds Agenda, Review and Reading tiles; Add to today captures without leaving what is open.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Add to today

Add to today (⌘E) opens the shared creation slip centered near the top, 560 px wide. On the cover it rises from the bottom edge above the keyboard; New in the center of the bottom nav opens the same Atom-into-Today sheet. Commands finds Add to today through capture, quick atom, inbox or journal. A mono rubric names the action in gilt and its destination in `--faint`.

The Kind row offers Atom, Question, Task, Card and Source; More offers Project and the workshop's page kinds. Arrow keys select a kind. Until a kind is chosen explicitly, a trailing `?` infers Question, `[] ` infers Task, complete card syntax infers Card, and a whole URL, ISBN, DOI or arXiv identifier infers Source. Typing or choosing a tag never changes the kind or destination; typed pages are chosen in More. The draft carries across kind switches.

Into offers Today, New atom (notes and questions), and Atom…. Notes, tasks and cards default to Today; questions default to New atom. An explicit destination stays selected while the kind changes. ⌘N starts Atom into New atom. Index, ledger and table buttons lock their kind and hide both controls.

Page drafts show kind-specific field rows beneath the gist: Parent question, Revisit, Recurrent and First perspective for questions; Deadline for projects; and up to four template fields for typed pages. A project's gist sets its outcome rather than repeating it in its body. Fields use the page's label/value voice and the table's editors, stay full-width on the cover, and save in the creation batch. Filing an existing title keeps already-filled fields read-only.

### Line kind and completions

- A note, question or task line appends at the end of Today or the chosen page, reusing a trailing empty block. A question adds its question state in the same batch.
- `[] ` and `[ ] ` task prefixes disappear on save. The Kind row replaces the old ⌘Enter note/task toggle.
- `[[` completes pages (with Create atom) and `#` pages used as types (with Create tag), matching titles and aliases in a picker under the line. Type results never include matching note bodies. Chosen tags show readable names in the input and glyph-and-name pills below it, retaining canonical identities in the draft until their names are edited. A hand-typed `[[Title]]` links as it would on leaving a block.
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

The launcher's New atom, New task, New question and Add to library shortcuts open the slip over the current page with the corresponding creation kind. Text shared to Tessera opens a note request with the shared text as its line; the slip can infer a source or question from that text.

The resizable Tessera home-screen widget starts at 4×1 and offers Atom, Task and Question. Its preview description is Capture to Tessera. The Tessera atom Quick Settings tile closes the shade and opens a note request. Each tap opens the slip again, including while the app is already running.

Each request opens the creation slip on its kind: Atom and Task into Today, Question as a new page, Add to library as Source. File sharing and Open with accept EPUB, not PDF: the library import inbox only supports EPUB.

## Journal dates

Journal days present a spoken date such as Tuesday, October 13 beneath a short mono period trail: `2026 · Oct · W42`. Agenda's Day heading speaks dates the same way (`Tuesday, October 13, 2026`). Backlink rubrics and compact dates use the shared `relativeDate` civil-date rule: `today`, `tomorrow` and `yesterday`, weekday and day only within the current Monday–Sunday week, and ISO otherwise.

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

On touch, mini months are whole-month buttons with non-interactive day overviews. Choosing one opens the full month with 44 px day targets. Touch mini-month overviews reserve six calendar rows and align at the top so neighboring months share their title and weekday baselines. Fine-pointer mini months retain direct day buttons.

### Written-day marks

Only journals with non-empty visible text get muted filled day marks, independently of visiting or selecting the day. Today is ringed in gilt and the displayed journal day has a gilt rule. The bounded written-day read refreshes after committed text changes, keeping the previous marks visible until the refreshed data arrives.

Day buttons speak the full civil date and open through the existing journal path. The root text remains ISO and other pages retain their own titles.

## Cards

A card line is ordinary card syntax, such as `tahâfut >> incoherence`. A tag on that line files the card into a deck of the same name. `#arabic` is enough; Review lists arabic without creating a deck. The card count names those tags, as in `1 card · #arabic`, and the tag opens that deck. A tag on the journal day does not file the cards written under it. Put a filing tag on the page or a parent when it should not become a deck.

## Integrating a thought

Integrate, in a journal block's menu, palette and slash menu, opens the destination picker. Pages come first; typing also searches blocks. Choosing a destination moves the block with all its children to the end of that page or block. The journal keeps a live reference in its old place, so the moved text stays readable there.

The move and reference are one transaction. Undo restores the original place and removes the reference. The change notice offers Undo, and the outline's Undo command uses it while the notice is present. Outside journal days, Integrate is not offered.

## Making a project

Make project on a journal block makes it a [project page](tasks-agenda.md#projects) and leaves the block as its link, with its children moved onto the page. The day keeps the record of where the project started, and the page collects tasks from later days.

## Today tiles

Today alone leads with Agenda, Review and Reading tiles above the Journal rule and writable outline.

Journal heads in Piazzolla at `--text-h2` (18 / 26) in `--text`, with the name alone. From your highlights uses the shared mono section head with its hairline rule, state and chevron. Both are `h2` elements.

Desktop and unfolded Today tiles are at least 120 px tall, enough for the tallest loaded Reading content including the book map, and grow with their content. Their placeholders keep the same height. The three desktop tiles reserve their loaded height while requests show quiet placeholders.

A journal narrower than 640 px uses one ruled list of compact Agenda, Review and Reading rows, with the book map below the Reading row.

### Agenda tile

Agenda counts the items in the [Agenda pane's Today section](tasks-agenda.md#groups) separately from Overdue and shows the next timed or untimed item. The tile and sidebar use the shared `agendaDaySummary`. The sidebar badge sums planned and overdue work, with a tooltip such as `6 to do: 4 today · 2 overdue`. A task without authored text reads `Empty task`, as in Agenda rows. Its chevron folds today's tasks open beneath the tiles, open by default and remembered per device.

That ledger uses the [Day rows](tasks-agenda.md#rows), with their time gutter, completion, [rescheduling keys and now rule](tasks-agenda.md#rescheduling), and ends in `Open agenda ›`. Tasks written in this journal are left out, since the outline below already shows them with their plan: a muted `N more in the journal below` follows the rows, or `N planned in the journal below` replaces Nothing planned today. Carried work collapses to one `N carried over` line in `--danger` with a closing hairline. It expands in place, with Move to today at its end and the [same Undo line](tasks-agenda.md#groups). When carried work precedes today's tasks, a mono Today heading separates the day's rows.

The ledger keeps provenance visible beside a reserved rescheduling slot, including on hover and keyboard focus. Provenance uses holder links in ink with a hairline underline and gilt hover. Today, Tomorrow and calendar actions stay quiet without opacity fades. Deadline facts inside the warning window use `--warning`; late facts keep `--danger`. Below a 600 px pane width, titles have the full first line after the status and optional clock gutter, with up to two text lines before truncation. Mono facts, provenance and the right-aligned calendar share the second line, indented to the task text. One-line titles keep rows under 72 px on touch. The ledger omits its clock gutter when none of its rows has a time.

When no tasks are planned, the Agenda tile says Nothing planned today once; the open ledger keeps only Open agenda, without a duplicate empty message or reserved empty-row height.

### Review tile

Review uses the sidebar's same due-card query and starts the due queue in one tap. If no cards are due, it opens the [caught-up landing](cards-review.md#landing-and-decks). Sidebar and palette Open review still open the landing.

### Reading tile

Reading continues the most recently read EPUB still in Reading, with:

- Its cover.
- A short title using the [citation-chip rule](library.md#citation-chips).
- Resolved chapter time left, then the chapter's numeral and title on a second line; narrow journal rows keep that chapter context and grow to fit it.
- Segmented [BookMap](reader.md#book-map) with real highlight marks.

Front matter and unresolved contents use whole-book time left instead of inventing a chapter. A coarse pointer at 900 px or wider opens the book beside the journal.

## Touch outline

Touch journals keep only the bullet left of the text, with the heading and the right edge at the pane inset. Task status replaces the bullet rather than adding a second indent. Nested rows retain the same depth increment and atom actions no longer narrow the row when selected.

Visiting or returning to a journal on a coarse pointer selects its saved row without restoring the text caret or opening the keyboard. Desktop keeps caret restoration. An explicit create-and-edit request still opens the editor.

On touch, holding an outline row for half a second opens the same Atom actions sheet as its menu button. Moving to scroll cancels the hold. Rows at rest suppress the native text callout and selection flash; holding inside a row already being edited keeps native text selection.

On the cover, editing with the keyboard open shows Outdent, Indent and Done immediately above the keyboard. Indent and Outdent use the outline's structural commands without dismissing the keyboard. Done leaves the row selected and dismisses the keyboard. The bar follows the visual viewport and stays hidden on wider layouts.

All app entries limit text-focus zoom on iOS, including iPadOS with a desktop user agent, while preserving iOS pinch zoom. Android and desktop keep their original viewport settings so Android pinch zoom remains available.

## From your highlights

Below the outline, From your highlights shows one resurfaced highlight at a time with an `N of M` counter and previous/next controls, preserving Open, Keep, Mute and the device's collapse preference. Keep reserves its checkmark's room, so the actions do not reflow when checked. No reading-session duration, pace or finish estimate is shown.

## Research to revisit

Today lists due notes and questions beside From your highlights, earliest first, with their title, kind or question state and revisit date. Open in Review selects that item in the Revisits queue. The section stays hidden when nothing is due.
