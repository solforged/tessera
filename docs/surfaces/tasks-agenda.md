# Tasks and agenda

Tasks retain their canonical source blocks while planning controls and Agenda organize their work. Agenda has Day, Week and Tasks views.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Making tasks

Tasks are made as in Tana, Roam and Logseq:

- ⌘Enter makes a block a todo, then toggles it between todo and done; ⌥Enter is an alias.
- `[] ` or `[ ] ` at the start of a plain block makes it a todo. Text that arrives in one burst, such as typing right after Enter, converts the same way and keeps the caret after the rest, so an `@fri` typed with it still offers its date.
- `/todo`, `/doing` and the other statuses set any status, as does the ⌘⇧Enter menu.
- Make task sits in block and page menus.

The block menu's Task section reads, in order:

1. Complete or Reopen task.
2. Set task status…
3. Plan task.
4. Work sessions.
5. Remove task.

Statuses are Todo, Doing, Waiting (an hourglass), Done and Canceled. Task state, dates, optional times, deadline warning, priority and repeat are anchored controls, not text prefixes.

### Task field bed

A task keeps its checkbox and compact planning facts at rest. Focus reveals one field bed, in Task template order, with `status`, `scheduled`, `deadline`, `priority`, `repeat` and `project` beside user fields and `+ Field`. Plan task opens this bed; status, planning shortcuts and clicks on facts open the corresponding field editor. Tab moves through the fields and Escape returns to the compact row. There is no separate planning slip.

`status` opens its menu; choosing Done uses completion, so repeats advance and Undo restores the occurrence. `scheduled` and `deadline` use the date picker with optional time, and the deadline editor owns the warning lead. `priority` uses its choice menu and `repeat` uses the repeat editor. Its Mode and Unit menus carry chevrons. Removing an optional template slot leaves any existing value visible and does not change Agenda.

`project` opens a searchable, title-ordered picker; choosing a project replaces the task's explicit `project` field in one undo step, and None removes it. A name that matches no project exactly adds `New project “Name”`, which makes a project page of that title (or makes an existing page of that title a project) and assigns the task to it.

An appointment shows `scheduled` plus fields the person adds. Make task adds todo and the task template around the same atom without changing its date or parent. Work sessions stay in their own control.

On a narrow touch screen, the field bed is one bottom sheet headed Task fields and the atom's title. Labels stack over values with fingertip-sized targets. Dates edit inline; a richer picker replaces the contents and Back to fields returns to the same field. The footer offers Add field and reads Each change saves to this atom.

## Dates and times

Planning facts use the shared `relativeDate` civil-date rule: `today`, `tomorrow` and `yesterday`, then the weekday within six days either side (`Thu`), then the month and day (`Nov 2`), adding the year outside today's (`Nov 2, 2025`). ISO appears only where a date is typed or edited. Missed schedules prefix the date with `since`; deadlines prefix it with `due`. A plan is late only when it precedes both the displayed date and civil today. A deadline inside its inclusive warning window uses `--warning`; late facts keep `--danger`. The tooltip and accessible label spell the full date out (`Scheduled Tuesday, October 6, 2026 at 19:00`).

### Date suggestions

Typing `@` after a space or at block start opens date suggestions under the `@`: Today, Tomorrow, the next five weekdays and Next week, with a parsed query first.

| Input | Interpretation |
|---|---|
| ISO labels, today/tomorrow/yesterday, weekdays | Accepted dates |
| `@in 2 weeks`, `@+2d` | Relative dates |
| `@oct 12`, `@12 october 2027` | Full or abbreviated month names in either order; `sept` also works |
| Month and day without a year | Next occurrence on or after today |
| Impossible dates such as `feb 30` | Errors |
| Bare weekday | Includes today when it matches |
| `next mon` | Monday in the following Monday-start week |
| `09:30`, `9:30`, `9am`, `3:30pm` | Time after any date, or alone for today |
| `12am`, `12pm` | Midnight and noon, respectively |
| Leading `by` or `due`, followed by a space or the token's end | Deadline; for example, `@by oct 12 3pm`, `@due fri` |

Typed dates count from the workshop's today, also on another day's journal page or Agenda day, so `@today` on last Tuesday's page schedules today. Agenda's New task still schedules a dateless task on the shown day.

The picker's first, non-selectable row reads Scheduled or Deadline, with a mono Tab hint. Tab flips the field by inserting `by ` or removing `by `/`due ` while retaining the query. Other pickers keep Tab to pick.

Enter picks a date: a plain atom becomes an appointment with no status or checkbox, an existing task keeps its status, and only the date token and its leading space leave the text. A tag normalized while the picker is open keeps its full identity; the date choice, Tab field flip and full date picker follow the rewritten token boundaries. `#task`, `/Todo` or ⌘Enter adds a checkbox. Pick a date… opens the full picker with the typed query, without changing the atom until a date is chosen. Canceling either picker keeps the token and the existing schedule unchanged.

A multi-word query that matches no date is prose (`@sam about the report`). The picker closes so Enter splits the block as usual, and reopens if the words become a date again. A recognized but impossible date such as `feb 30` instead keeps the picker open with an error and preserves the token.

### Date picker

Date pickers pair the text field with a Monday-start month grid shared with the [journal calendar](journal.md#period-ledgers). A picker that fits neither above nor below its trigger sits over it, inside the window. On touch it stays inside the pane above bottom navigation, with 44 px calendar cells.

| Calendar mark | Appearance and meaning |
|---|---|
| Today | Ringed |
| Chosen day | Filled with the accent; follows what the field parses (`fri` previews Friday) |
| Scheduled work | Solid dot |
| Deadlines | Outlined square |

Planning marks count open tasks only, with accessible labels such as `3 scheduled · 1 deadline`. The task's other planning date keeps a separate related-date line. Planning counts load and cache per visible month, and refresh after workshop commits without moving the grid.

Clicking a day applies it. Arrows move by day and week, Page Up and Page Down by month. The optional time, Clear and Apply stay in a fixed footer; only the calendar body scrolls when the viewport is short.

## Completion and repeats

Completion uses the displayed [journal](journal.md) or agenda date. A repeat counts from a date:

- Setting one on an undated task schedules it for the context day, and the Repeat popup says so before Apply.
- Clearing the last date clears the repeat.
- Each repeat mode explains itself under the mode choice.
- Repeating tasks retain their source identity and advance their plan. The advanced facts glow once and announce the next date.
- Completion history shows that occurrence's plan, not the next repeat. It stays separate from the live task: the next occurrence remains in lookahead, and Doing work remains in the day's open work.

A running work session requires an explicit stop, with Stop and complete offered as one atomic action.

### Work sessions

Work sessions open from the row's running clock or `h:mm logged` chip, the atom menu and the palette; `Space w` and `/clock` start or stop the clock without opening them. The logged chip counts stopped, unreversed sessions only. The popup is headed `Work` and the task's text. Its clock leads: a large mono `h:mm:ss` (the running session's elapsed time in `--status-doing`, otherwise the task's total), what it counts (`Since 12:58 · 0:21:14 in total`, `3 sessions in total`, `No work logged yet`), then one bordered action: Start, Start again or Stop.

A running session's note is a one-line field under the clock; past sessions follow newest first on hairlines, each `today 12:58–13:19`, its duration and its note. Notes belong to the session record, not the outline, and save on Enter, when focus leaves them, and with Stop. Stop keeps focus in the note, so the note travels with it. The popup keeps its place when its trigger disappears, as when Stop removes the row's clock.

## Projects

Project controls edit outcome, deadline and status, each saving as it is chosen; the outcome saves on Enter or when focus leaves it and is focused when the popup opens on a new project. Show actions opens an outline-ordered task query over descendants and explicit Project field members. The project page summarizes status, deadline, outcome, completed count and the first unfinished task in outline order. Linked tasks below the outline shows explicit field members written elsewhere, ordered by plan. The page header's Table (⌘⇧T) opens a Tasks table filtered to `Project is` the project, with the same membership as its task query; a task's Project lists its own project first, then any project enclosing it. Task rows elsewhere show their project as a trailing fact. Completing a project does not complete its tasks.

On a journal day, Make project (`/project`, `Space o`, the block menu) makes the block a project page instead, so it is filed under Projects and collects tasks from later days. The block's text names the page, or an existing page of that title becomes the project. The block's children move to the end of the page, and the block becomes the page's link. It is one transaction with `Made project Name.` and Undo. A block with no text asks for a name first. Outside journal days the block itself becomes the project.

The task API's optional `project_via: "field"` filter restricts results to explicit field assignments before the result limit. Its default, `both`, also includes ancestry members. Linked tasks uses the field-only read and excludes the project page's own descendants. Counts and Next are computed before limiting rows; the task API's 2,000-row cap remains unchanged.

## Agenda destination

The Agenda destination keeps a mono Agenda eyebrow above its title, followed by `· Today` in gilt when the displayed day or week contains today. Day has a spoken date heading, `Sunday, October 25`, never a relative word such as today. Previous day, Today and Next day form one bordered group at the title's right edge, with Today in `--faint` while today is shown. Week uses a week number and month-and-day range (`Week 43 · Oct 19 – Oct 25`, with the year only outside today's) with Previous week / Today / Next week. Both date headings open the journal's calendar; picking a day moves there, and its Today returns to today. Tasks has a plain Tasks title with no date navigation.

On the cover, a date eyebrow and Agenda page title sit above the day or week stepper. The eyebrow opens the calendar; Tasks uses a Tasks eyebrow instead. Wider layouts keep their date-led heading.

Day / Week / Tasks sit beneath on the shared ruled tab baseline. On the wide Week grid, the hour-window toggle sits at the right end of this same row; it is absent from Day, Tasks and the narrow Week ledger.

Day's seven-day strip has no boxes:

- Each column carries a small mono weekday, a Plex numeral at 20 px and weight 500, and one 4 px dot per open task, deduplicating a task whose schedule and deadline coincide. Dots are `--faint`; today's overdue work is `--danger` and deadlines inside their warning window are `--warning`. A day with more than six shows six dots and a faint mono count. The accessible label reads `4 open · 2 overdue`.
- The selected day has a 2 px gilt rule on the strip's hairline and the `--hover` fill; today's numeral is gilt.
- Tapping a day changes the list without shifting the strip.
- The strip and Day lookahead reuse the existing scheduled/deadline task queries.

### Add a task

On Day, Add a task sits directly under the strip, so it stays in place however many tasks are overdue: 20 px below the strip and 28 px above the first section. It uses the text-field shape at 44 px with a gilt plus and the placeholder `Add a task for Sunday`, naming the displayed day. It is [Add to today](journal.md#add-to-today) in its task form: it captures into today's [capture section](journal.md#today-template), Inbox by default, scheduled for the displayed day unless a complete plain-word suffix such as `mon 9am`, a trailing `@date`, or `by`/`due` names another plan.

On the cover, the inline field is hidden and the glass top bar's New button opens a task creation slip preset to the displayed day. It still captures into today's capture section; typed dates override the preset. Elsewhere, a live preview at the field's right end shows the plan as a planning fact in Plex (`tomorrow 15:00`, `due Fri 16`), after a calendar glyph, in `--calendar-scheduled`, then a faint `↵ add`. An unmatched explicit `@` token replaces the preview with a `--warning` note that it stays in the text. One `--faint` line beneath the field reads `Try “mon 9am”, “by fri” or “in 2 weeks”`.

The preview shows exactly the first date suggestion that submission will use, including preset prefixes such as `@t` for Today. Protected references and code remain authored text.

After acknowledgment, the list refreshes, scrolls the new task row into view and outlines it once in gilt for 1.5 seconds. The capture stays inline and keeps keyboard focus for another task.

## Tasks query

Tasks has one mono query line on a hairline, beside its saved-view trigger. The line never wraps: its empty placeholder truncates with an ellipsis, and applied term chips scroll horizontally when they exceed the available width. Focus edits one line of plain text; Enter or blur applies it. Outside editing each term is a chip with its own remove control. Invalid terms keep their text, carry a `--danger` underline and explain the error beneath; the last valid query stays applied.

A faint mono count trails the condition-builder rail, which can wrap below the query when space runs out. Terms combine before the result limit, and double quotes group words or multi-word date expressions. Finished tasks, both Done and Canceled, follow all unfinished results while retaining the query's order within each group.

| Task query term | Means |
|---|---|
| `is:todo,doing` | Any of the named statuses: `todo`, `doing`, `waiting`, `done`, `cancelled` |
| `show:open` | Unfinished tasks only |
| `show:recent:7`, `show:recent` | Unfinished or completed in the last seven days; this is the default and omitted from the line |
| `show:all` | All tasks |
| `priority:high`, `priority:medium`, `priority:low` | Priority |
| `#Book`, `#[[Research notes]]` | Source type by an existing page title |
| `[[Finish thesis]]` | Tasks belonging to the project by ancestry or an explicit Project instance field |
| `sort:outline` | Descendants in project preorder, grouped by their nearest non-task ancestor below the project, then field members in plan order; the default remains plan order |
| `@fri`, `@today..+7d`, `@"next fri"..`, `@..2026-10-12` | Scheduled date or inclusive range; either endpoint may be open |
| `by:fri`, `due:fri` | Deadline date or range, with the same date syntax |
| `limit:50` | Result limit |
| Other words, `"read carefully"` | Source text search |

### Add condition

Add condition opens one searchable picker grouped into Task, Source and Fields:

| Group | Conditions |
|---|---|
| Task | Selection, status, priority, project, scheduled/deadline ranges and result limit |
| Source | Tag and text |
| Fields | The workshop's definitions |

Choosing a condition replaces the picker with its editor at the same trigger. Changing a syntax-backed condition rewrites the query line. Field predicates stay outside the syntax as editable, removable chips in the condition row, with the task count at the trailing edge. Editing a field predicate preserves its place and the other predicates.

Named task views store the `TaskQuery`, never the line's spelling, and preserve its date context. Pane history restores the query across Agenda, Week, Tasks and reload; relative dates become absolute dates when applied.

Saved task view project conditions show the resolved project title rather than its stored identity.

## Day

### Rows

Day rows are the one task row shared by Day, the Week ledger, Today's [Plan](journal.md#plan) and Tasks results. From the left, a row has:

- A 52 px mono time gutter, blank for untimed work and omitted when no row in the list has a time.
- The 24 px status glyph.
- The text column, described below.
- A reserved 96 px slot for [rescheduling](#rescheduling).

The text column holds two lines:

1. The title in Plex at 15 / 22, clamped after two lines.
2. The facts line in Plex at 12.5 / 18 in `--muted`: provenance first, then the planning facts, separated by middle dots in `--control-border`.

Only the clock is mono, and the facts line reads as a sentence. Provenance uses holder links in ink with a hairline underline and gilt hover. Journal provenance names the journal section and a relative day, `Inbox · today` or `Reading · yesterday`, or `Journal · Thu 22` outside a section, rather than the stored ISO title. The full page title remains in its tooltip and accessible name.

On the cover, a provenance tap opens the whole source page in Outline, scrolls to the task and briefly highlights it. It neither zooms into the task nor opens Task fields; a planning-field tap opens that sheet. Wider layouts keep their zoom-to-task provenance behavior.

Planning facts follow provenance on the facts line in a fixed order: the plan (`since Fri 23`, `due Tuesday`), priority, repeat (`↻ every 3 days`), the project when provenance does not already name it, and logged work. They omit dates implied by a day group and a project the row already names as its provenance, and show a carried schedule only as `since 2026-10-06`, not also a second date. Earlier work on a future displayed day has no `since` prefix unless it is also before civil today.

Below a 600 px pane width, Day, Week ledger and [Plan](journal.md#plan) rows drop the time gutter and the trailing slot. A timed row's clock leads its facts line in mono, and the calendar button sits at the right of the title line. One-line Plan and Day titles fit in a row under 72 px on touch. Calendar actions keep 44 px touch targets. Wider touch rows and their completion/source controls remain at least 44 px high. The cover's content insets are equal.

The whole row takes the hover fill and long task text clamps at two lines. Planning uses the same facts as outline rows, with late facts in `--danger` and deadline warnings in `--warning`.

The glyph completes on the displayed agenda date, including from lookahead, or reopens a finished task in Tasks. Right-click or ⌘⇧Enter on a focused row opens the shared status menu. The priority word opens the same priority choices as the Planning slip, including None. High is danger; medium and low stay faint. Tab reaches both controls and P opens priority from a focused row. Completed history shows a static check and never edits the live task.

Completing, reopening or triaging a row uses its source page's undo history. ⌘Z or Ctrl+Z reverses that edit, including its saved occurrence and previous plan; Shift repeats the chord to redo. The keyboard stays on an Agenda row, or on the pane when none remain.

### Rescheduling

Planned rows reschedule without dragging:

- On fine pointers, Today, Tomorrow and Pick a date appear in the row's reserved trailing slot only while the row is hovered or has keyboard focus. They are 28 × 24 px icon buttons (a sun, an arrow and a calendar) whose tooltips name the action and its key, and each is omitted when it would change nothing. They appear without a fade, and since the slot is reserved and provenance sits on the facts line, nothing moves or hides. Tab reaches the actions.
- On touch or in a pane under 600 px only the calendar button shows, always, at the right of the title line.

| Focused-row key | Action |
|---|---|
| j and k, or the arrows | Move between rows across sections |
| t | Schedule today |
| m | Schedule tomorrow |
| s | Open the date picker |
| x | Complete |
| Alt+Left, Alt+Right | Move the schedule a day |

Date-only moves keep the time, deadline and repeat, and keep the keyboard on the next row when the task leaves the list. The picker also edits time, including a same-day change; clearing its time makes the task all-day. An inline date/time updates the time field, and editing that field normalizes the date to avoid competing clocks.

Untimed work leads each day, followed by timed rows in chronological order regardless of status. On today, elapsed clocks sit above a gilt now rule that starts from a gilt dot; future clocks follow below it. Past work recedes to `--muted`; work in progress keeps its status appearance. The now rule belongs only to timed work and is omitted when there are no clocks.

### Groups

Day groups canonical tasks in this order:

| Group | Content and appearance |
|---|---|
| Overdue, or Before this day on a future date | Earlier schedules and deadlines; only facts before civil today use `--danger` and the `since` prefix |
| Today, or Planned on other days | The displayed day's plans and work in progress |
| Upcoming | On desktop and unfolded screens; the seven civil days after the displayed date |
| Unplanned, Done today | Folded by default |

Every group uses the shared [section head](../design.md#color). Overdue tints its name `--danger`; Today counts open and finished work (`4 · 1 done`); folded groups dim their names to `--muted`. Today always has a head and count; when empty it shows one muted Nothing planned line.

The Overdue head ends in one bordered Move all menu with To today and To tomorrow. Each moves every unfinished task in one command, keeping times and deadlines, and leaves a `Moved 6 to today · Undo` line until the next move. To today is disabled with an explanation when every task is already scheduled today, including tasks whose deadline is still overdue. The single menu keeps the rule and count in the heading on narrow panes.

Upcoming groups rows by their earliest future schedule or deadline, and excludes tasks already listed as overdue or planned. Each day is a sans subhead without a rule: the day's name at 13 px and weight 500 in `--muted` (Tomorrow, then weekdays), then its month and day in `--faint`, as `Tomorrow Oct 26`, `Tuesday Oct 27` and `Sunday Nov 1`, never ISO. A live task appears only once across these sections, even when both planning dates contribute to the strip. Collapsed Unplanned and Done groups retain undated work and completion history; a completed occurrence never suppresses its source's live task.

Opening a row still opens its source. ⌘-click opens it beside (Ctrl-click off Mac). Completion and planning never insert copies into the journal.

## Week

Week shows the displayed date's Monday-start week. Previous week, Next week and Today use the same single date control. Week drops the week strip, since its day headings already name the days.

The heading, shared tabs and drop feedback keep the same 760 px measure and alignment across Day, Week and Tasks.

The all-day strip holds untimed scheduled tasks and deadlines labeled Due. Each card leads with its status glyph in the status color, then the time or Due in mono. The strip sizes to its tallest day's content, capped at three rows; days with more cards scroll within the strip.

In the week containing today, unfinished tasks with a missed schedule or deadline before the week's first day also appear as Overdue cards in today's all-day lane. Overdue plans from earlier days of this same week keep their red card on their original day and are not repeated in today's lane. The narrow week ledger follows the same rule: those tasks list under today with their `since` facts, and its summary line adds `· N overdue`.

Timed scheduled tasks sit in an hourly grid, initially scrolled to 08:00 or the earliest earlier task. Column dates (`Thu 22`) and hour labels are mono. Timed cards may take two text lines. The default hour window is 06:00–22:00 and expands to include any task outside it. Show all hours at the right of the tab row opens 00:00–24:00; its pressed state and label change to Hide early and late hours. Toggling keeps the visible hour in place. A live gilt now line and dot cross today's timed column at the current time when it falls inside the shown window. Overlapping times use separate lanes.

At an Agenda container width below 600 px, Week becomes a seven-day ledger on one scroll axis, including narrow desktop splits. Mono weekdays, serif numerals, hairlines and faint open counts head Day's canonical task rows. Today's numeral and now rule are gilt. Untimed work leads each day, followed by chronological timed rows regardless of status; elapsed clocks sit above the now rule and future clocks below it. Empty days take one line. Days before today fold to a done count and any open count, and expand on tap.

Appointments, scheduled atoms without `#task`, appear on their exact date in both the grid and the narrow ledger, with or without a time and without a status glyph.

The ledger starts with a mono open-task count and due count (`7 open · 1 due`), without repeating the range already in the title. A task with both dates on the same day appears once. It has no drag: each open row offers Day's calendar button and keyboard planning behavior, and completion uses that row's day.

At 600 px and wider the grid remains. Intermediate-width panes, including the unfolded Fold, fit all seven columns and subdivide overlapping lanes inside each day without sideways scrolling. Wider desktop grids retain their existing column measure.

### Dragging and keyboard moves

Dragging a task into the grid sets its scheduled date and time, snapped to 15 minutes. Dropping in the all-day strip sets its date and clears the time. Each drop or keyboard move is one undoable workshop command. Rapid moves compose from the latest pending plan and save in order. When a keyboard move takes a card outside the displayed week, the calendar keeps keyboard ownership of that task so the next planning key still applies. The position changes immediately and rolls back if the commit fails. After a drop, keyboard focus follows the card; ⌘Z or Ctrl+Z restores the previous plan even while it is saving, and Shift repeats the chord to redo.

| Focused-task key | Action |
|---|---|
| Alt+Left, Alt+Right | Move one day |
| Alt+Up, Alt+Down | Move 15 minutes |
| Alt+Home | Clear the time |

Clicking opens the source. ⌘-click opens it beside (Ctrl-click off Mac).
