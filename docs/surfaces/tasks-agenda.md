# Tasks and agenda

Tasks retain their canonical source blocks while planning controls and Agenda organize their work. Agenda has Day, Week and Tasks views.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Making tasks

Tasks are made as in Tana, Roam and Logseq:

- ⌘Enter makes a block a todo, then toggles it between todo and done; ⌥Enter is an alias.
- `[] ` or `[ ] ` at the start of a plain block makes it a todo.
- `/todo`, `/doing` and the other statuses set any status, as does the ⌘⇧Enter menu.
- Make task sits in block and page menus.

The block menu's Task section reads, in order:

1. Complete or Reopen task.
2. Set task status…
3. Plan task.
4. Work sessions.
5. Remove task.

Statuses are Todo, Doing, Waiting (an hourglass), Done and Canceled. Task state, dates, optional times, deadline warning, priority and repeat are anchored controls, not text prefixes.

### Planning slip

Plan task opens a compact slip headed by Planning and the task's authored text, or `Planning · done 2026-10-10` once done. Scheduled, Deadline, Priority, Project, Repeat and Work are labeled rows with their current values in mono or a faint None. Warning appears only with a deadline. Priority shows its bars beside its name.

Project opens a searchable, title-ordered picker; choosing a project replaces the task's explicit Project field in one undo step, and None removes it. A name that matches no project exactly adds `New project “Name”`, which makes a project page of that title (or makes an existing page of that title a project) and assigns the task to it.

Work reads `Running since 12:58` in `--status-doing` or a faint `Not running`, and opens Work sessions in the slip's place.

## Dates and times

### Date suggestions

Typing `@` after a space or at block start opens date suggestions under the `@`: Today, Tomorrow, the next five weekdays and Next week, with a parsed query first.

| Input | Interpretation |
|---|---|
| ISO labels, today/tomorrow/yesterday, weekdays | Accepted dates |
| `@in 2 weeks`, `@+2d` | Relative dates |
| `@oct 12`, `@12 october 2027` | Full or abbreviated month names in either order; `sept` also works |
| Month and day without a year | Next occurrence on or after the context date |
| Impossible dates such as `feb 30` | Errors |
| Bare weekday | Includes today when it matches |
| `next mon` | Monday in the following Monday-start week |
| `09:30`, `9:30`, `9am`, `3:30pm` | Time after any date, or alone for the context date |
| `12am`, `12pm` | Midnight and noon, respectively |
| Leading `by` or `due`, followed by a space or the token's end | Deadline; for example, `@by oct 12 3pm`, `@due fri` |

The picker's first, non-selectable row reads Scheduled or Deadline, with a mono Tab hint. Tab flips the field by inserting `by ` or removing `by `/`due ` while retaining the query. Other pickers keep Tab to pick.

Enter picks a date: a plain block becomes a todo, the task is scheduled or due, and the token and its leading space leave the text. Pick a date… opens the full picker with the typed query, without changing the block until a date is chosen. Canceling either picker keeps the token and the existing task unchanged.

A multi-word query that matches no date is prose (`@sam about the report`). The picker closes so Enter splits the block as usual, and reopens if the words become a date again. A recognized but impossible date such as `feb 30` instead keeps the picker open with an error and preserves the token.

### Date picker

Date pickers pair the text field with a Monday-start month grid shared with the [journal calendar](journal.md#period-ledgers). A picker that fits neither above nor below its trigger sits over it, inside the window.

| Calendar mark | Appearance and meaning |
|---|---|
| Today | Ringed |
| Chosen day | Filled with the accent; follows what the field parses (`fri` previews Friday) |
| Scheduled work | Solid dot |
| Deadlines | Outlined square |

Planning marks count open tasks only, with accessible labels such as `3 scheduled · 1 deadline`. The task's other planning date keeps a separate related-date line. Planning counts load and cache per visible month, and refresh after notebook commits without moving the grid.

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

Work sessions open from the row's running clock, the block menu, the palette and the planning slip's Work row; `Space w` and `/clock` start or stop the clock without opening them. The popup is headed `Work` and the task's text. Its clock leads: a large mono `h:mm:ss` (the running session's elapsed time in `--status-doing`, otherwise the task's total), what it counts (`Since 12:58 · 0:21:14 in total`, `3 sessions in total`, `No work logged yet`), then one bordered action: Start, Start again or Stop.

A running session's note is a one-line field under the clock; past sessions follow newest first on hairlines, each `today 12:58–13:19`, its duration and its note. Notes belong to the session record, not the outline, and save on Enter, when focus leaves them, and with Stop. Stop keeps focus in the note, so the note travels with it. The popup keeps its place when its trigger disappears, as when Stop removes the row's clock.

## Projects

Project controls edit outcome, deadline and status, each saving as it is chosen; the outcome saves on Enter or when focus leaves it and is focused when the popup opens on a new project. Show actions opens an outline-ordered task query over descendants and explicit Project field members. The project page summarizes status, deadline, outcome, completed count and the first unfinished task in outline order. Linked tasks below the outline shows explicit field members written elsewhere, ordered by plan. The page header's Table (⌘⇧T) opens a Tasks table filtered to `Project is` the project, with the same membership as its task query; a task's Project lists its own project first, then any project enclosing it. Task rows elsewhere show their project as a trailing fact. Completing a project does not complete its tasks.

On a journal day, Make project (`/project`, `Space o`, the block menu) makes the block a project page instead, so it is filed under Projects and collects tasks from later days. The block's text names the page, or an existing page of that title becomes the project. The block's children move to the end of the page, and the block becomes the page's link. It is one transaction with `Made project page Name.` and Undo. A block with no text asks for a name first. Outside journal days the block itself becomes the project.

The task API's optional `project_via: "field"` filter restricts results to explicit field assignments before the result limit. Its default, `both`, also includes ancestry members. Linked tasks uses the field-only read and excludes the project page's own descendants. Counts and Next are computed before limiting rows; the task API's 2,000-row cap remains unchanged.

## Agenda destination

The Agenda destination has an Agenda kicker and spoken date heading with Previous / Today / Next alongside it. Day / Week / Tasks sit beneath on the shared ruled tab baseline. The date heading opens the journal's calendar: picking a day moves there, and its Today returns to today.

The seven-day strip has no boxes:

- Each column carries a small mono weekday, serif numeral and faint mono open-task count, deduplicating a task whose schedule and deadline coincide.
- The selected day has a 2 px gilt rule on the strip's hairline; today's numeral is gilt.
- Tapping a day changes the list without shifting the strip.
- The strip and Day lookahead reuse the existing scheduled/deadline task queries.

### Add a task

On Day, Add a task sits directly under the strip, so it stays in place however many tasks are overdue. It is [Add to today](journal.md#add-to-today) in its task form: it captures into today's journal, scheduled for the displayed day unless a complete plain-word suffix such as `mon 9am`, a trailing `@date`, or `by`/`due` names another plan.

On the cover the field stays fixed above bottom navigation and moves down when the keyboard hides navigation. A live mono preview beneath the field shows the plan as a planning fact (`tomorrow 15:00`, `due Fri 16`) in `--calendar-scheduled`. An unmatched explicit `@` token warns in `--warning` that it stays in the text.

The preview shows exactly the first date suggestion that submission will use, including preset prefixes such as `@t` for Today. Protected references and code remain authored text.

After acknowledgement, the list refreshes, scrolls the new task row into view and outlines it once in gilt for 1.5 seconds. The capture stays inline and keeps keyboard focus for another task.

## Tasks query

Tasks has one mono query line on a hairline. Focus edits plain text; Enter or blur applies it. Outside editing each term is a chip with its own remove control. Invalid terms keep their text, carry a `--danger` underline and explain the error beneath; the last valid query stays applied.

A faint mono count sits under the line. Terms combine before the result limit, and double quotes group words or multi-word date expressions.

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
| Source | Type and text |
| Fields | The notebook's definitions |

Choosing a condition replaces the picker with its editor at the same trigger. Changing a syntax-backed condition rewrites the query line. Field predicates stay outside the syntax as editable, removable chips in the condition row, with the task count at the trailing edge. Editing a field predicate preserves its place and the other predicates.

Named task views store the `TaskQuery`, never the line's spelling, and preserve its date context. Pane history restores the query across Agenda, Week, Tasks and reload; relative dates become absolute dates when applied.

## Day

### Rows

Day rows have a fixed left mono time gutter, blank for untimed work, then the status glyph and source text, with muted page provenance at the right. Journal provenance reads Journal rather than repeating the stored ISO date; the full page title remains in its tooltip and accessible name.

Planning facts sit below the task text, omit dates implied by a day group and a project the row already names as its provenance, and show a carried schedule only as `since Tue 6`, not also an ISO date. Task-query and [journal](journal.md#today-tiles) rows retain their compact status, source and trailing planning layout.

On touch, Agenda task rows and their completion/source controls are at least 44 px high; the cover's content insets are equal. The whole row takes the hover fill and long task text clamps at two lines. Planning uses the same facts as outline rows, with carried or missed dates in `--danger`.

The glyph completes on the displayed agenda date, including from lookahead, or reopens a finished task in Tasks. Right-click or ⌘⇧Enter on a focused row opens the shared status menu. The priority bars open the same priority choices as the Planning slip, including None; Tab reaches both controls and P opens priority from a focused row. Completed history shows a static check and never edits the live task.

Completing, reopening or triaging a row uses its source page's undo history. ⌘Z or Ctrl+Z reverses that edit, including its saved occurrence and previous plan; Shift repeats the chord to redo. The keyboard stays on an Agenda row, or on the pane when none remain.

### Rescheduling

Planned rows reschedule without dragging:

- On hover or focus, quiet mono Today and Tomorrow and a calendar button take the provenance's place, each omitted when it would change nothing. In a pane under 560 px only the calendar button fits there, so only it shows.
- On touch only the calendar button shows, beside the planning facts.

| Focused-row key | Action |
|---|---|
| j and k, or the arrows | Move between rows across sections |
| t | Schedule today |
| m | Schedule tomorrow |
| s | Open the date picker |
| x | Complete |
| Alt+Left, Alt+Right | Move the schedule a day |

Date-only moves keep the time, deadline and repeat, and keep the keyboard on the next row when the task leaves the list. The picker also edits time, including a same-day change; clearing its time makes the task all-day. An inline date/time updates the time field, and editing that field normalizes the date to avoid competing clocks.

On today, timed rows stay chronological regardless of status, with every elapsed clock above a gilt rule that starts from a gilt dot at the present. Past work recedes to `--muted`; work in progress keeps its status appearance. Untimed work stays below the rule.

### Groups

Day groups canonical tasks in this order:

| Group | Content and appearance |
|---|---|
| Overdue | Carried schedules and missed deadlines, in `--danger` |
| Today, or Planned on other days | The displayed day's plans and work in progress |
| Next 7 days | On desktop and unfolded screens; the seven civil days after the displayed date |

Headings read label, hairline, count. Today always has a ruled heading and count; when empty it shows one muted Nothing planned line.

The Overdue heading ends in All to today and All to tomorrow. Each moves every unfinished task in one command, keeping times and deadlines, and leaves a `Moved 6 to today · Undo` line until the next move. A missed deadline already scheduled today cannot move to today, so that action hides when nothing would move.

In an Agenda pane narrower than 560 px the two moves sit on their own line beneath the heading, aligned with Overdue, so the rule and count keep their room.

Next 7 days groups compact rows by their earliest future schedule or deadline, and excludes tasks already listed as overdue or planned. A live task appears only once across these sections, even when both planning dates contribute to the strip. Collapsed Unplanned and Done groups retain undated work and completion history; a completed occurrence never suppresses its source's live task.

Opening a row still opens its source. ⌘-click opens it beside (Ctrl-click off Mac). Completion and planning never insert copies into the journal.

## Week

Week shows the displayed date's Monday-start week. Previous week, Next week and Today use the same single date control. Week drops the week strip, since its day headings already name the days.

The heading, shared tabs, drag hint and drop feedback keep the same 760 px measure and alignment across Day, Week and Tasks even when the week grid is wider.

The all-day strip holds untimed scheduled tasks and deadlines labeled Due. Each card leads with its status glyph in the status color, then the time or Due in mono. Timed scheduled tasks sit in an hourly grid, initially scrolled to 08:00 or the earliest earlier task. Overlapping times use separate lanes.

At an Agenda container width below 600 px, Week becomes a seven-day ledger on one scroll axis, including narrow desktop splits. Mono weekdays, serif numerals, hairlines and faint open counts head Day's canonical task rows. Today's numeral and now rule are gilt. Timed rows stay chronological regardless of status, with every elapsed clock above the rule and untimed work below it. Empty days take one line. Days before today fold to a done count and any open count, and expand on tap.

The ledger replaces the drag hint with a mono week range, open-task count and due count. A task with both dates on the same day appears once. It has no drag: each open row offers Day's calendar button and keyboard planning behavior, and completion uses that row's day.

At 600 px and wider the grid remains. Intermediate-width panes, including the unfolded Fold, fit all seven columns and subdivide overlapping lanes inside each day without sideways scrolling. Wider desktop grids retain their existing column measure.

### Dragging and keyboard moves

Dragging a task into the grid sets its scheduled date and time, snapped to 15 minutes. Dropping in the all-day strip sets its date and clears the time. Each drop or keyboard move is one undoable notebook command. Rapid moves compose from the latest pending plan and save in order. When a keyboard move takes a card outside the displayed week, the calendar keeps keyboard ownership of that task so the next planning key still applies. The position changes immediately and rolls back if the commit fails. After a drop, keyboard focus follows the card; ⌘Z or Ctrl+Z restores the previous plan even while it is saving, and Shift repeats the chord to redo.

| Focused-task key | Action |
|---|---|
| Alt+Left, Alt+Right | Move one day |
| Alt+Up, Alt+Down | Move 15 minutes |
| Alt+Home | Clear the time |

Clicking opens the source. ⌘-click opens it beside (Ctrl-click off Mac).
