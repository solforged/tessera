# Cards and review

Cards are authored in ordinary blocks and reviewed in a pane on the outline measure. Tokens, shell and shared popup patterns are in [design](../design.md).

## Card syntax and editor markers

The syntax rules are also defined in [Cards in the domain model](../domain-model.md#cards). Author `front >> back`, `front << back`, `front <> back`, or numbered clozes such as `{{c1::answer::hint}}` in ordinary blocks. `::` remains field shorthand. Explicit malformed syntax shows diagnostics instead of guessed cards. Each numbered cloze and each direction has its own stable progress.

| Syntax | Card behavior | Editor marker |
| --- | --- | --- |
| Trailing `>>>` | A multi-line card whose answer is the block's child outline | `↓` in `--faint` |
| Trailing `>>1.` | A list card whose children are revealed one at a time | `↓1.` in `--faint` |
| `Function ;; makes ATP` beneath `Mitochondria` | A descriptor that asks `Mitochondria › Function` | `›` |

Descriptor card is under `/` and under Space c as `d`. Its review source line leaves out the parent the front already names. Under an empty parent the row says “A descriptor needs a parent with text.”

## Review pane

### Revisits

Revisits is its own pane, directly below Agenda in the sidebar and available through Open revisits in Commands. It keeps its selected atom and scroll position through back, forward and reload. Its heading shows the due count without a Review eyebrow. Notes and non-parked page or inline questions whose revisit date is today or earlier appear in dated groups, earliest first. Each group has an ISO date in mono, a section rule and a faint count at the right. The sidebar counts cards under Review and due revisits under Revisits separately. Today and Agenda's research section opens the selected atom in Revisits.

An empty Revisits queue says `Nothing to revisit. Set a Revisit date on a note or question and it appears here.` Open Questions opens the Questions ledger.

On the cover layout, the title, empty-state text, Open Questions and queue text share `--pane-inset` with Index and Library. The pane owns that inset; its body does not add the shared empty-state margin or button padding.

Each item opens its ordinary outline inside Review; inline questions open zoomed. Sources, links and backlinks remain available. Revisited shows the proposed next date before confirmation, with the shared revisit picker to change or clear it. Later moves the date without an event. Resolve clears the date and resolves a note, or allows a question to resolve without accepting an assessment. Keep recurrent marks a question recurrent and records a revisit.

After an action the next item opens. Undo revisit restores the prior date and state and removes the event from effective history. The control then offers Redo revisit. This history belongs to the queue action, not the next page's outline undo stack. There are no grades or streaks for this queue.

When a row leaves the queue, the queue glides to its new height and the action bar and outline ride with it. The next note's outline loads out of sight beside the one it replaces, which leaves once the new one has rows, and a confirmation leaves with its row. Controls stay focusable while a revisit is written.

### Landing and decks

Review is a pane on the outline measure, like [Library](library.md). Its mono register sits over the deck's static Piazzolla title. Open reviews stays at its right; Deck actions appears only for a saved deck and contains Edit deck and Delete deck. Both actions explain that an open review must end first when unavailable. The deck ledger is the only deck chooser.

The landing's Due, New and All tabs head the overview's left column, sharing the tab-strip baseline with a 2 px gilt rule under the whole selected tab. There is no landing toolbar row. The landing is a ruled register rather than a dashboard: one hairline opens the overview, with no boxes. The selected queue follows its tabs with its total as a Piazzolla figure at `--text-figure`; Due says due now, while New and All say cards in this queue.

One apparatus line follows: how many come due later today, after due now on New and All. Review N cards (Space) starts the bounded batch and is a gilt hairline button, as are Review's other start actions. An empty queue instead says All caught up, or Nothing new yet for New, in the display voice.

When another card is scheduled, one mono line reads `Next card <date> · HH:mm` in the workshop's time zone. The date uses the shared civil-date rule: `today`, `tomorrow` and `yesterday`, the weekday within six days either side, then the month and day, with the year outside today's. Due dates in the card list follow it too. There is no disabled start button or repeated empty sentence; paused cards keep their explanation.

The fourteen-day forecast stays secondary at the right, square bars on a baseline rule; All includes deferred introductions. Below it, a finished deck's empty due list reads `No cards due · Show all N cards`; Show all switches to All.

Forecast bars are buttons. Focus or click selects a date and updates the caption to its date under the shared civil-date rule and its due count. The selected bar is gilt. The first day is labeled with its day number; later bars use two-letter weekdays. A divider separates the two weeks. Every bar keeps that date and its due count in its tooltip and accessible name. Zero days retain a hairline in `--line`; there is no separate count row. Retention over thirty local days, Last 7 days, the streak and total cards follow as one mono ledger line between rules, then a deck ledger with Due, New and Cards. Last 7 days counts from local midnight six days before the selected date through that date's end, not from Monday. The session summary uses the same stats line.

When All cards is the ledger's only row, a muted sans sentence beneath the Decks head reads `Tag a card to make a deck. Save a deck for other filters.` The sentence disappears once another deck exists. New card and New deck remain in the header.

Counts come from active visible cards and committed review events, never sample data. No time estimate appears because reviews do not record per-card duration.

Decks save source predicates, not copied collections. A tag on a card's own block appears in the same ledger without saving a deck. The row uses the tag's title, not its plural, and reviewing it studies the cards on blocks with that tag. The ledger says to tag a card to make a deck, and to save a deck for other filters. Removing the tag from those cards removes the row. A saved deck that filters only on that type replaces the tag row. New deck remains for a queue a tag cannot express, such as a field filter or more than one condition.

Cards follows the deck ledger with a mono section head, rule and total. It lists the first fifty cards in the selected deck and Due, New or All queue, refreshing with the landing. Each full-width button shows the front's first line without markup, its kind in faint capitals, a truncated source title and a mono due label. Unscheduled cards say new; scheduled cards show an ISO date in the workshop's time zone, rubric when past due. Opening a row opens its source atom; ⌘-click opens beside (Ctrl-click off Mac). A faint mono N more closes a longer queue.

Start takes focus on a mouse-and-keyboard device, but touch leaves it alone and the pane has no focus ring. Today's Review tile starts the due queue directly, or lands on the caught-up state when empty. That request is consumed once; sidebar and palette navigation keep the landing.

On the cover layout, the Review tab opens the deck overview rather than implicitly resuming a saved open session. Due counts remain in the deck ledger and Start begins the selected queue. Open reviews explicitly resumes an unfinished session; reload and pane history still preserve an explicitly selected session. Larger layouts keep their automatic recovery of an open review.

### Session progress

A session replaces the landing with one segment per card in the progress toolbar. Its grades survive reload. The deck title keeps its landing size and stays static; deck actions and Open reviews leave the session.

During a live cover session, the shell pane header steps aside for the session's glass top bar. Close finishes the session and returns directly to the selected deck's overview, preserving every committed grade. The bar names the deck and the current card, such as `1 of 9`; its Session actions menu offers Undo last grade and End review. The segmented progress strip remains below the bar.

| Card state or grade | Segment appearance |
| --- | --- |
| Good/Easy | Sage |
| Again | Rubric |
| Hard | Warning |
| Current card | Gilt |
| Waiting cards | Neutral |

A completed or explicitly closed session with at least one review keeps its count, elapsed duration, grade breakdown, tomorrow's load, streak, forecast and missed cards. A closed session with no reviews returns straight to the landing. Review missed starts another real session restricted to those Again cards.

## Card sheet

### Appearance and source

The card reads as a quiet sheet on the page rather than a boxed panel. Its column is capped at the page measure with 48 px of breathing room above it, placing its prompt in the upper third. It has no rubric mark. Its top rule turns gilt only on fine-pointer keyboard focus; touch hides this rule, leaving the progress strip alone.

One mono line heads every card: the source at the left, then the kind in faint capitals (`FORWARD`, `REVERSE`, `CLOZE`, `MULTI-LINE`, `LIST`, `DESCRIPTOR`, `OCCLUSION`) and Card actions at the right. The cover layout keeps these kind labels in sentence case instead. A cloze or occlusion card is numbered (`CLOZE 2`, `OCCLUSION 2`) only when its block makes more than one. A cited card's source shows siglum, title, chapter and paragraph and opens that citation. ⌘-click opens it beside (Ctrl-click off Mac). An uncited card's source path opens its block. Card actions holds the same open action, Edit card, which opens the canonical block, and Reset progress, which requires a revealed answer and confirmation. On an occlusion card, Edit card also opens the mask editor.

Cards beneath a highlight inherit the nearest ancestor citation when they have none of their own. Their source line identifies the book and location, not the ancestor quotation. The cited passage and following sentence wait for reveal.

Both sides of a card share `--text-title`, 32 px. When both are 40 characters or fewer on one line, and the answer is not an outline, they use the 38 px title line; otherwise both add 8 px of leading. Clicking non-control space on the front reveals on pointer and touch, alongside the button and Space shortcut. A rule separates ordinary sides. Multi-line answers keep their child outline with faint bullets, and list answers number their items in rubric; both markers sit on the text's baseline. An image block in the answer shows its figure above its caption, at most 40% of the viewport's height. Lists reveal one item at a time, with an `N of M` mono count, and grading waits for the last. Clozes reveal in place with a gilt underline, so the sentence appears once; until then a gap reads `[…]`, or `[hint]`, in muted italic.

An occlusion card shows its image, cropped to the group's area when it has one, at most 70% of the viewport's height so the grades stay on screen on a phone. The tested masks are filled gilt with the hint centered in them. In Hide all, the other groups' masks are filled with the canvas and outlined with a hairline. Revealing removes the tested masks and rings each uncovered shape with a 2 px gilt stroke, the way a cloze reveals in place, and the answer follows below.

Once revealed, a cited card shows prose following its quotation from the snapshot's real passages. It skips punctuation-only remainders and keeps the beginning of long sentences, like the reader's note sheet.

### Responsive behavior

| Layout | Behavior |
| --- | --- |
| Unfolded touch screen at least 900 px wide | The card sits left and its passage sits right with the citation highlighted. The passage waits for reveal so it cannot give the answer away. |
| Cover | The bottom nav, shell pane header and session footer step aside during a live session. Its glass bar offers Close back to the overview, deck name, progress and Session actions. Tapping non-control card space reveals. Interval-bearing grades form the sole bottom bar in a two-by-two block. Undo last grade and End review remain in Card actions as well. The footer and bottom nav return on Done. |
| Larger layouts | Review history stays available. |

Good is ringed in gilt as the default, and Space or Enter selects it after reveal; 1–4 remain available. Again's label is rubric.

Review history shows each event as a mono toggle line: local ISO date and 24-hour time, grade and interval change, such as `2026-10-17 07:40 · Again · new → 1 day`. Toggling the line expands its shown front and back beneath it, without a nested disclosure.

## Grading and progress

### Keys and intervals

Space reveals the answer. The grading keys are:

| Key | Grade |
| --- | --- |
| 1 | Again |
| 2 | Hard |
| 3 | Good |
| 4 | Easy |

Scheduling is FSRS-6 at 90% retention in whole days. Buttons show the next interval in days, then months and years. When two neighboring grades have different intervals that round to the same label, both show one decimal (`1.4 mo`), then whole days if they still match. Equal intervals, such as Again and Hard on a new card, read the same.

### Changed cards and reset

A source or schedule change invalidates the shown snapshot and requires Review current card before grading. Changed wording retains identity and progress. The card shows the last reviewed text beside its current text and offers Keep progress or Start over. An occlusion card changes when its masks, area, hint, answer, mode or image change, and in Hide all also when another group's masks do; its comparison shows the last reviewed and current images side by side. Reset progress requires confirmation and keeps review history.

### End and undo

On larger layouts the session footer offers plain Undo last grade at the left and End review at the right. Card actions also offers both controls, with Undo last grade disabled whenever the footer's action is disabled. End review opens the same confirmation at its trigger, including the Card actions button: `End this review? Graded cards keep their grades.` with Keep going and End review. Switching away from an open review uses the same choice; ending records a finished session and keeps committed grades.

Undo last grade stays available during a session and in the footer on Done, with ⌘Z or Ctrl+Z outside editable controls. It restores the card and its schedule; undoing the final grade reopens the finished session.

While a grade or undo is saved, the grade buttons and other session controls are held shut without being disabled, so they neither dim nor lose focus and a click during the write is refused. A card that replaces another eases from the previous card's height and fades in, so the page below it glides. The last graded card stays on screen until the Done summary replaces it, in the same frame. Undoing from the Done summary keeps the summary on screen until the restored card has loaded. A second pane on the same session follows an undo made in the first: it shows the restored card too.

If that restored card is later held or removed, an explicit unavailable state offers Next rather than silently replacing it. A transport failure remains an error, not an unavailable-card state.

## Tag recipes

The tag page’s Cards section, below Template, and the Cards tab share one component. Each recipe has an editable display name, Front and Back pickers offering Atom text, the tag’s fields and Pattern… for free patterns. `{@text}` references the atom itself; `{Field name}` in the editor resolves to the field’s stable ID.

A real member previews beside each recipe: `Preview · il lavello`, the front in large display type and the answer below a hairline. Details holds an optional hint, ordered after-answer fields and New per day. Enable and Disable preserve existing progress. The footer offers + Add recipe and the live card total with its tag deck.

Atoms with syntax receive no additional recipe cards. Use fields for these N atoms opens an in-pane conversion preview with Atom text, the chosen back field and Cards columns, plus atoms/cards-kept/new/reset counts. Choose an existing text field or name a new one. Simple `<>`, `>>` and `<<` convert; other syntax is listed and left alone. The formerly absent direction stays paused. Not now dismisses. Convert is one change, with one Undo/Redo step preserving identities, schedules and review history.

Recipe review keeps the source line, provenance and grading strip. The front has a mono source label and serif tested text. Show hint reveals only the configured hint field. The answer unfolds below a hairline with its source label, then ordered details: prose fields in sans text and other fields in a mono label/value apparatus. Syntax cards keep their existing presentation.

Creating an atom tagged with applied recipes shows every template field and a live Cards preview. On touch, field labels stack over values. New atoms go into today; the atom, field entries and derived cards save together.

## Cards popup

The outline badge reads `1 card · #arabic`, or `1 card · untagged` when the atom has no tags. Several tags share one separator: `1 card · #arabic #vocabulary`. Text tags and manual memberships both count. Each tag opens Review scoped to that tag's deck; the count still opens Cards.

An atom’s card count opens its cards. Each row puts the direction in the same faint capitals in a fixed column, so every card’s text starts at one edge, then the front, the answer in `--muted` and the due state. Clozes show their gaps and gilt answers as Review does. Multi-line and list answers show as their outline, at most five items, then `N more`. An occlusion card shows a thumbnail of its tested area and its answer, or `Mask A` when it has none. A recipe card reads `RECIPE` with its `#Vocab · Recognition` provenance under the text.

The popup's Review, Shift-click on the count and the block menu's Review cards start a review of that block's active cards, due or not, titled by the block's subject. ⌘-click on Review opens it beside (Ctrl-click off Mac). An open review shows the same End review prompt as switching decks before the block review starts; asking again for the block already under review returns to it. Review is disabled when every card is paused.

The block request is consumed once; later session snapshots and reloads resume that session without starting or re-requesting its source review.

## Done summary and deck forms

The Done summary returns to the shared page insets and responsive title scale, with section gaps between its sentence heading, counts, forecast and missed cards. The deck title remains above it; no duplicate deck-and-Done eyebrow or completed grade strip appears. The Hard count, when present, and the summary actions stay. Its header no longer says in progress.

Deck forms retain the popup's viewport gutters on the cover, so fields and actions stay inside both edges.

Typed filters and names survive a click outside the deck editor. Escape closes it and keeps the draft for its next opening, until it is saved or canceled.

## Pending grades and session persistence

The current card stays until a grade is acknowledged. Pending commands survive offline reload with their original request bytes. Rejection preserves the command for copying and requires a fresh card snapshot. Unrelated local page edits do not invalidate the shown card.

Exhausting a confirmed queue shows Finishing review… until the finish is acknowledged, then Done and normal deck actions. Ending early or switching an open review is explicit; committed grades and their shown-text evidence remain. Pane history and reload preserve the deck, queue selection and session.

A workshop with no cards hides the deck title and the Due, New and All tabs. It says `No cards yet.` and offers Create a card, a hairline button that opens the card composer under the button. The Revisits tab omits a zero count. A non-empty Review landing keeps New card beside New deck and opens the shared creation slip with Card selected. An empty deck or held-only inventory keeps its distinct explanation.

## Card composer

The composer is a 560 px slip laid out like Add to today and like the card it makes. Its front/back body also lives in the shared creation slip, whose Into row chooses Today or the end of an existing page. A mono rubric line names New card in gilt and, at the right in `--faint`, where the card goes: `Fri 16 · end of journal` from Review, or the source title and paragraph from a highlight. Front is set in the 18 px display voice of a review card and folds from Back on a hairline. Each side has a mono label that turns gilt while it holds the caret. Both fields grow with their text to a cap, then scroll; neither has a resize grip.

Enter in Front moves to Back and Shift-Enter breaks the line. ⌘↵ (Ctrl-Enter elsewhere) creates the card and closes; ⇧⌘↵ creates it and clears the draft for the next one, counting `2 cards added` in the standalone composer or `2 added` in the shared slip where the key hints were. Create stays disabled until both sides have text. Text that cannot make exactly one forward card, such as a second `>>`, shows the parser's message under the fields in `--danger` as you type. The shared slip preserves complete inferred card syntax until either side is edited. Its saves stay in Review and show Card added with Open and Undo; the empty-inventory standalone composer still opens Today on Create and stays in Review on Create another. On coarse pointers the composer is a bottom sheet without key hints or a duplicate Cancel.

Typed text survives a click outside the composer. Escape closes it and keeps the text for the next opening; Create and Cancel end the draft. Make card from a highlight keeps one draft per highlight, so reopening it for another highlight starts clean.
