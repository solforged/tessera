# Journal and today

Journal days present spoken dates and writable outlines. Today adds Agenda, Review and Reading tiles and lays its journal out in the sections of the workshop's [Today template](#today-template); Add to today captures into one of those sections without leaving what is open.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Add to today

Add to today (⌘E) opens the shared creation slip centered near the top, 560 px wide. On the cover it rises from the bottom edge above the keyboard, and the capture button in the bottom nav opens the same sheet into the capture section. Commands finds Add to today through capture, quick atom, inbox or journal. A mono rubric names the action and its destination, as `Capture → Today › Inbox` or `Capture → Today › Reading › Meditations`: Capture in gilt, the destination in `--faint`. The current day and time sit at the rubric's right in `--faint`.

The line leads with a kind chip: Note, Question, Task, Card, Link or Source, each with its glyph from the [Inbox](#inbox). Until a kind is chosen explicitly, a trailing `?` infers Question, `[] ` infers Task, complete card syntax infers Card, a whole URL infers Link, and an ISBN, DOI or arXiv identifier infers Source. Clicking the chip, or Shift+Tab from the line and then Enter, opens the kind menu. Arrow keys move through it, and More offers Project and the workshop's page kinds. Typing or choosing a tag never changes the kind or destination; typed pages are chosen in More. The draft carries across kind switches.

A Link shows the page's title in Piazzolla and its site in `--faint` beneath the line once the service has read them, and saves as a titled link. Also add to the Library, off by default, files it as a source as well and links the line to that source. When Settings › Today makes a pasted link a source, the URL infers Source instead, as before.

Into, a row of [mode tabs](../design.md#color), offers the template's written sections (Inbox, Reading, Notes and any added), then New atom and Atom…. Notes, links, tasks and cards default to the capture section that Settings › Today chooses, Inbox unless changed; questions default to New atom and sources to the Library. Choosing Reading adds an Under row, described under [Reading](#reading). An explicit destination stays selected while the kind changes. ⌘N starts Atom into New atom. Index, ledger and table buttons lock their kind and hide the chip menu and Into.

Below Into, Captured today lists the last three lines captured into today's sections, newest first, each with its mono creation time; choosing one opens it in Today. The footer gives the slip's keys in `--faint` and ends in a gilt button naming the destination, such as Add to Inbox or Add under Meditations.

Page drafts show kind-specific field rows beneath the gist: Parent question, Revisit, Recurrent and First perspective for questions; Deadline for projects; and up to four template fields for typed pages. A project's gist sets its outcome rather than repeating it in its body. Fields use the page's label/value voice and the table's editors, stay full-width on the cover, and save in the creation batch. Filing an existing title keeps already-filled fields read-only.

### Line kind and completions

- A note, link, question or task line appends as the last child of its section on Today, or at the end of the chosen page, reusing a trailing empty block. A missing section heading is written in the same batch, as [Today template](#today-template) describes. A question adds its question state in the same batch.
- `[] ` and `[ ] ` task prefixes disappear on save. The kind chip replaces the old ⌘Enter note/task toggle.
- `[[` completes pages (with Create atom) and `#` pages used as types (with Create tag), matching titles and aliases in a picker under the line. Type results never include matching note bodies. Chosen tags show readable names in the input and glyph-and-name pills below it, retaining canonical identities in the draft until their names are edited. A hand-typed `[[Title]]` links as it would on leaving a block.
- An `@date` plans a task, with the [same preview as Add a task](tasks-agenda.md#add-a-task). A plain-word date suffix plans only a task.

### Adding and saving

| Input | Behavior |
|---|---|
| Enter in a line | Adds and closes |
| Shift+Enter in a line | Adds another, keeps the slip open and shows `N added` |
| Enter in a page draft | Creates and opens with the body caret |
| Shift+Enter in a page draft | Creates and opens beside |
| Tab in a line | Moves to Into, except while date suggestions are open, where it flips Scheduled and Deadline |
| ⌘Enter | Submits from any field |
| Shift+⌘Enter | Submits and keeps the same kind ready for another |
| Escape | Closes an open completion first and then the slip |
| Cover sheet | Hides keyboard hints and Cancel; the sheet's Close dismisses it |

Line drafts clear once accepted by the local outbox; cards keep their draft until acknowledgment. Reload resumes every accepted capture, including its destination, question state, task plan and chosen references. If local storage fails, the line keeps its text. Line, card and source creation in the slip never navigate: a shell notice names where the line went, such as Added to Inbox, Added under Meditations or Added to the chosen page, or says Card added or Added to library, with Open. For queued imports, Open shows the source when ready or the Library inbox while the job is pending. Lines and cards also offer Undo, deleting the inserted row or restoring a reused empty row. The notice uses the same eight-second, hover-and-focus-paused surface as page-deletion Undo.

### macOS capture

The macOS app's File › Add to Today (⌘E) and Dock › Add to Today open the same slip. ⌘⇧E anywhere on the Mac opens it as a floating panel over the current app, or the slip when Tessera is in front. The Send to Tessera text Service opens the floating panel and replaces its draft from the `tessera-quick-capture` event's parsed kind and text before focusing it.

The panel stays 600 px wide, fits its contents before showing, and grows downward from a fixed top edge for kind fields, previews, errors and completions, up to 560 px. It shrinks when those rows disappear and keeps an unsaved draft when it loses focus. Line, card and source saves or Escape return to the previous app; a page-kind creation uses the native open bridge to show the page and its body caret in the main window instead.

### Android capture

The launcher's New atom, New task, New question and Add to library shortcuts open the slip over the current page with the corresponding creation kind. Text shared to Tessera opens a note request with the shared text as its line; the slip can infer a source or question from that text.

The resizable Tessera home-screen widget starts at 4×1 and offers Atom, Task and Question. Its preview description is Capture to Tessera. The Tessera atom Quick Settings tile closes the shade and opens a note request. Each tap opens the slip again, including while the app is already running.

Each request opens the creation slip on its kind: Atom and Task into the capture section, Question as a new page, Add to library as Source. File sharing and Open with accept EPUB, not PDF: the library import inbox only supports EPUB.

## Journal dates

Journal days present a spoken date such as Tuesday, October 13 beneath a short mono period trail that runs from week to year: `Week 42 · October · 2026`. On today's journal the trail leads with `Today` in gilt, which is not a control. A bordered group of Previous day, calendar and Next day buttons sits at the title's right edge; the calendar button toggles the month ledger. Agenda's Day heading speaks dates the same way (`Tuesday, October 13, 2026`). Backlink rubrics and compact dates use the shared `relativeDate` civil-date rule: `today`, `tomorrow` and `yesterday`, weekday and day only within the current Monday–Sunday week, and ISO otherwise.

The latest navigation request wins in its pane. Previous and next step from a pending journal date, and a superseded lookup does not create a missing journal. Before a new journal root is committed, missing reference reads show quiet zero counts rather than unavailable sections; successful reads still show real backlinks, and related sections refresh when the root becomes committed.

Segments rest in `--faint` without underlines. Hover or keyboard focus brightens one to gilt with a hairline underline; the open segment has a 2 px gilt rule instead. Each segment toggles one inline ledger beneath the heading. Tapping it again or Escape closes it.

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

## Today

Today alone leads with Agenda, Review and Reading tiles, then lays its journal out in the sections of the workshop's Today template. Other journal days show the written sections they hold, under the same heads, and none of the generated ones.

### Today template

Settings › Today edits one template per workshop. A section is written or generated:

- **Written** sections are headings in the day's outline that hold what you write or capture there. Each is a capture target.
- **Generated** sections are live lists Today draws. Nothing about them is written into the journal.

| Section | Kind | New workshop | Content |
|---|---|---|---|
| [Plan](#plan) | Generated | On | Today's tasks from Agenda |
| [Inbox](#inbox) | Written | On; the ⌘E default | Captures in the order they arrived |
| [Reading](#reading) | Written | On | Notes grouped under the sources they are about |
| [Notes](#notes) | Written | Always on | The rest of the outline |
| [Research to revisit](#research-to-revisit) | Generated | On | Due notes and questions |
| [From your highlights](#from-your-highlights) | Generated | Off | One resurfaced highlight at a time |

The template lists sections in order with a drag handle, the name in Piazzolla, a one-line role in `--faint` and a workshop switch. Dragging or Alt+Up and Alt+Down reorders them. Every section can be renamed and keeps its behavior under the new name. Add a section names a new written section. Beneath the list:

| Control | Choices |
|---|---|
| ⌘E captures into | Any written section; Inbox by default |
| A pasted link becomes | A link in the capture section (default), or a source in the Library |
| Top of Today shows | The Agenda, Review and Reading tiles, each switchable |

### Written sections

A written section is a heading row, a direct child of the journal root, whose text is the section's name; Today matches it with the workshop's name folding. A day's missing section heading is written the first time something lands in it, by capture or by typing into its placeholder, at its template position among the section headings already there and in the same batch as the content. Until then Today draws the section head and one faint placeholder row, such as `Write in Inbox…`, that writes nothing when left empty.

Template changes never rewrite earlier days. A renamed section matches its new name from today on; earlier days keep and show their old headings as ordinary headings. Section headings are ordinary outline headings in every other respect: they move, fold, link and export like any other.

### Section heads

Every section uses the shared [section head](../design.md#color), written and generated alike. A written section's heading row is its head: the name edits as heading text, and the rule, count and action are drawn beside it. Folding a written section folds its heading in the outline; a generated section's fold is remembered per device. The same heads appear on other days for the written sections they hold.

| Section | Count | Action |
|---|---|---|
| Plan | `4 today` | Open agenda › |
| Inbox | `6 · 4 to file` | File all… |
| Reading | `2 sources` | + Note on… |
| Notes | None | None |
| Research to revisit | `3 due` | None; each item has Open in Review |
| From your highlights | `N of M` | None; the slip keeps its own controls |

### Plan

Plan lists today's tasks in [Day rows](tasks-agenda.md#rows), with their time gutter, completion, [rescheduling keys and now rule](tasks-agenda.md#rescheduling). It includes tasks written in today's journal, whose provenance names their section (`Inbox · today`), so nothing is counted twice or left out.

Carried work, which Agenda's Day lists as Overdue, collapses to one band above the rows. It has the pill recipe in `--danger` at 2 px radius, and reads `2 carried over` in `--danger`, the carried titles in `--muted` truncated to one line, then Move to today and Review…. Move to today moves them all, with the [same Undo line](tasks-agenda.md#groups). Review… expands the carried rows in place, between the band and today's rows.

When nothing is planned or carried, Plan folds to its head, which reads `Nothing planned` in place of its count.

### Inbox

Inbox holds what you capture, in the order it arrived. On desktop, an inline capture field sits under its head, indented to the text column: the text-field shape at 40 px, a plus, the placeholder `Capture to Inbox: a thought, a link, [] a task, a question?` and a faint `⌘E from anywhere` at its end. It is Add to today's line, with the same kind inference, completions and date preview, fixed to Inbox. Enter adds and keeps focus; Escape leaves the field. On the cover the field is hidden and the bottom nav's capture button opens the slip.

Inbox rows are outline rows behind a 52 px mono gutter in `--faint`, which gives each top-level row's creation time as `HH:MM` in the workshop's time zone. Children have no time, and the time is never written into the text. The bullet shows the row's kind:

| Kind | Bullet | Text |
|---|---|---|
| Note | Neutral bullet | Plex |
| Link | Link glyph | The page title in Piazzolla, then its site in `--faint` |
| Task | Status glyph | Plex, with its planning facts trailing |
| Question | Question glyph | Plex |
| Source | Source glyph | The short title by the citation-chip rule |

The hovered or focused row shows Plan, File to… and More as small bordered buttons at its right edge; on touch they are in Atom actions. Plan makes a note a task and opens its field bed on `scheduled`. File to… is [Integrate](#integrating-a-thought): the row moves, and Inbox keeps its live reference in place.

The head counts top-level rows and, after a middle dot, the rows still to file: those that are neither Integrate references nor finished tasks. File all… walks the rows still to file in order with the destination picker; Skip leaves a row and Escape stops.

### Reading

Reading keeps notes under the source they are about. Each source appears once per day as a top-level row linking to it, with its source glyph, the short title in Piazzolla, and its creators and position in `--faint` (`Marcus Aurelius · Book IV`). The row carries the creation time of the first note in the gutter, and the notes are its children. The position is the reader's chapter when the row was written and never changes later.

Choosing Reading in Add to today adds an Under row of sources, each with its cover, short title and a `--faint` reason:

1. The source most recently open in the reader.
2. Sources already under today's Reading.
3. Other sources in the Library's Reading state.
4. Another source or link…, which searches all sources.

A source not yet under today's Reading gets its row in the same batch as the note. The head's `+ Note on…` opens the slip into Reading. Writing under a source row in the outline works like any other child.

### Notes

Notes holds the root-level atoms outside the other written sections, in outline order. Its head is drawn by Today and never written as a heading; text typed in the journal outside a section lands here. On other days, the Notes head shows only when the day also has section headings, so a day without them reads as one outline.

### Today tiles

Each tile is one bordered button that opens its destination; no tile folds content open beneath it. Desktop and unfolded Today tiles share one height, enough for the tallest loaded Reading content including the book map, and grow with their content. Their placeholders keep the same height. The three desktop tiles reserve their loaded height while requests show quiet placeholders.

Each tile has its label in mono `--faint`, a figure at 24 px with a word in `--muted`, and one detail line at 12.5 px. A journal narrower than 640 px keeps the three tiles in one row: label, figure or short title, and the detail line; the Reading tile drops its cover and book map there.

#### Agenda tile

Agenda counts the items in the [Agenda pane's Today section](tasks-agenda.md#groups) separately from Overdue, as `4 today · 2 carried`, the carried count in `--danger`. Its detail line names the next timed item with its mono clock in `--calendar-scheduled`, or else the next untimed item; with nothing planned it reads Nothing planned today. The tile and sidebar use the shared `agendaDaySummary`. The sidebar badge sums planned and overdue work, with a tooltip such as `6 to do: 4 today · 2 overdue`. A task without authored text reads `Empty task`, as in Agenda rows. The tile opens Agenda's Day on today.

#### Review tile

Review shows the due count and names the decks the due cards come from. It uses the sidebar's same due-card query and starts the due queue in one tap. If no cards are due, it opens the [caught-up landing](cards-review.md#landing-and-decks). Sidebar and palette Open review still open the landing.

#### Reading tile

Reading continues the most recently read EPUB still in Reading, with:

- Its cover.
- A short title using the [citation-chip rule](library.md#citation-chips).
- Resolved chapter time left, then the chapter's numeral and title on a second line.
- Segmented [BookMap](reader.md#book-map) with real highlight marks.

Front matter and unresolved contents use whole-book time left instead of inventing a chapter. A coarse pointer at 900 px or wider opens the book beside the journal.

## Touch outline

Touch journals keep only the bullet left of the text, with the heading and the right edge at the pane inset. Task status replaces the bullet rather than adding a second indent. Nested rows retain the same depth increment and atom actions no longer narrow the row when selected.

Visiting or returning to a journal on a coarse pointer selects its saved row without restoring the text caret or opening the keyboard. Desktop keeps caret restoration. An explicit create-and-edit request still opens the editor.

On touch, holding an outline row for half a second opens the same Atom actions sheet as its menu button. Moving to scroll cancels the hold. Rows at rest suppress the native text callout and selection flash; holding inside a row already being edited keeps native text selection.

On the cover, Atom actions omits Open beside. Touch menus leave every action at rest on opening, including the action beneath a lifted finger. Pressed actions and keyboard focus still show their active state.

On the cover, editing with the keyboard open shows Outdent, Indent and Done immediately above the keyboard. Indent and Outdent use the outline's structural commands without dismissing the keyboard. Done leaves the row selected and dismisses the keyboard. The bar follows the visual viewport and stays hidden on wider layouts. Opening or resizing the bar reveals the full caret line above it, with one line of clearance and extra scrolling room at the end of the outline.

All app entries limit text-focus zoom on iOS, including iPadOS with a desktop user agent, while preserving iOS pinch zoom. Android and desktop keep their original viewport settings so Android pinch zoom remains available.

## From your highlights

From your highlights, a generated section switched off in new workshops, shows one resurfaced highlight at a time with an `N of M` counter and previous/next controls, preserving Open, Keep, Mute and the device's collapse preference. Keep reserves its checkmark's room, so the actions do not reflow when checked. No reading-session duration, pace or finish estimate is shown.

## Research to revisit

Research to revisit, a generated section, lists due notes and questions earliest first, with their title, kind or question state and revisit date. Open in Review selects that item in the Revisits queue. The section stays hidden when nothing is due.
