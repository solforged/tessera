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

### Questions and notes

The queue tabs switch between Cards and Questions and notes. Both sit on the cards landing's measure, and Questions and notes repeats its Review eyebrow and page title position, so switching keeps one column edge. Questions and notes shows its due count and lists notes and non-parked page or inline questions whose revisit date is today or earlier, earliest first. The sidebar badge combines cards and revisits; its accessible name and tooltip give each count separately.

An empty Questions and notes queue explains that Set Revisit on a note or question brings it here when its revisit date arrives.

Each item opens its ordinary outline inside Review; inline questions open zoomed. Sources, links and backlinks remain available. Revisited shows the proposed next date before confirmation, with the shared revisit picker to change or clear it. Later moves the date without an event. Resolve clears the date and resolves a note, or allows a question to resolve without accepting an assessment. Keep recurrent marks a question recurrent and records a revisit.

After an action the next item opens. Undo revisit restores the prior date and state and removes the event from effective history. The control then offers Redo revisit. This history belongs to the queue action, not the next page's outline undo stack. There are no grades or streaks for this queue.

### Landing and decks

Review is a pane on the outline measure, like [Library](library.md). Its mono register sits over the deck's Piazzolla title and picker; Open reviews and Deck actions stay at its right.

The landing's Due, New and All tabs share the tab-strip baseline, with a 2 px gilt rule under the whole selected tab. The landing is a ruled register rather than a dashboard: one hairline opens the overview, with no boxes. The selected queue leads with its total as a Piazzolla figure at `--text-figure`; Due says due now, while New and All say cards in this queue.

One apparatus line follows: how many come due later today (after due now, on New and All), and, when nothing is due now, the next card's time in the notebook's time zone (`next at 10:59`, or its date and time when it is not today). Review N cards (Space) starts the bounded batch and is a gilt hairline button, as are Review's other start actions. The fourteen-day forecast stays secondary at the right, square bars on a baseline rule; All includes deferred introductions.

The forecast's first bar is gilt. Every forecast bar has a two-letter weekday label; today's accessible name is “today”. Retention over thirty local days, this week's review count, the streak and total cards follow as one mono ledger line between rules, then a deck ledger with Due, New and Cards. The session summary uses the same stats line.

Counts come from active visible cards and committed review events, never sample data. No time estimate appears because reviews do not record per-card duration. Decks save source predicates, not copied collections. Start takes focus on a mouse-and-keyboard device, but touch leaves it alone and the pane has no focus ring.

### Session progress

A session replaces the queue preview with one segment per card. Its grades survive reload.

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

The card reads as a quiet sheet on the page rather than a boxed panel. On a fine-pointer device it is headed by the same rubric mark as popups. Its top rule turns gilt only on fine-pointer keyboard focus; touch shows neither this rule nor the rubric, leaving the progress strip alone.

One mono line heads every card: the source at the left, then the kind in faint capitals (`FORWARD`, `REVERSE`, `CLOZE`, `MULTI-LINE`, `LIST`, `DESCRIPTOR`, `OCCLUSION`) and Card actions at the right. A cloze or occlusion card is numbered (`CLOZE 2`, `OCCLUSION 2`) only when its block makes several. A cited card's source shows siglum, title, chapter and paragraph and opens that citation. ⌘-click opens it beside (Ctrl-click off Mac). An uncited card's source path opens its block. Card actions holds the same open action, Edit card, which opens the canonical block, and Reset progress, which requires a revealed answer and confirmation. On an occlusion card, Edit card also opens the mask editor.

Cards beneath a highlight inherit the nearest ancestor citation when they have none of their own. Their source line identifies the book and location, not the ancestor quotation. The cited passage and following sentence wait for reveal.

Both sides of a card share one size. When both are 40 characters or fewer on one line, and the answer is not an outline, they are set at 24 px with a 30 px line; otherwise both read at 24 px with a 38 px line. A rule separates ordinary sides. Multi-line answers keep their child outline with faint bullets, and list answers number their items in rubric; both markers sit on the text's baseline. An image block in the answer shows its figure above its caption, at most 40% of the viewport's height. Lists reveal one item at a time, with an `N of M` mono count, and grading waits for the last. Clozes reveal in place with a gilt underline, so the sentence appears once; until then a gap reads `[…]`, or `[hint]`, in muted italic.

An occlusion card shows its image, cropped to the group's area when it has one, at most 70% of the viewport's height so the grades stay on screen on a phone. The tested masks are filled gilt with the hint centered in them. In Hide all, the other groups' masks are filled with the canvas and outlined with a hairline. Revealing removes the tested masks and rings each uncovered shape with a 2 px gilt stroke, the way a cloze reveals in place, and the answer follows below.

Once revealed, a cited card shows prose following its quotation from the snapshot's real passages. It skips punctuation-only remainders and keeps the beginning of long sentences, like the reader's note sheet.

### Responsive behavior

| Layout | Behavior |
| --- | --- |
| Unfolded touch screen at least 900 px wide | The card sits left and its passage sits right with the citation highlighted. The passage waits for reveal so it cannot give the answer away. |
| Cover | The bottom nav steps aside during a live session. Tapping non-control card space reveals. Interval-bearing grades form a two-by-two block at the bottom. |
| Larger layouts | Review history stays available. |

Good is ringed in gilt as the default, and Space or Enter selects it after reveal; 1–4 remain available. Again's label is rubric.

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

### Finish, abandon and undo

Finish review and Abandon review open anchored confirmations. Cancel keeps the review open; either confirmed action keeps committed grades.

Undo last grade stays visible during a session and on Done, with ⌘Z or Ctrl+Z outside editable controls. It restores the card and its schedule; undoing the final grade reopens the finished session.

If that restored card is later held or removed, an explicit unavailable state offers Next rather than silently replacing it. A transport failure remains an error, not an unavailable-card state.

## Type cards tab

A type's Cards tab, after Fields in the same strip, lists its card templates. A mono line counts members, ready members and those waiting, the last in warning ink with the field they lack.

Each template is a numbered section with:

- Its Piazzolla name and Enabled or `Draft · not in review`.
- Front and Back patterns whose field references show as mono chips; typing `{` opens the field picker.
- `Uses 2 of 5 fields` and a New per day input. The total and Fields available to patterns use the same live field catalog as the pattern picker, not only the type's explicit template slots.
- Beside them, a preview of the first ready member: the front in large Piazzolla over a hairline and the back.

Enable… opens the Apply view, in this order:

1. The cards it will create and the members waiting in large mono numerals.
2. The introduction schedule (`398 / 10 = 39.8 → 40 days`).
3. A fourteen-day chart of existing reviews in muted bars with the added new cards in scheduled blue above them and two-letter weekday labels.
4. The first waiting members with Show all, which opens the [type table](fields-tables.md) filtered to the missing field.
5. Cancel and `Apply · 398 cards`.

Disable pauses a template's cards and keeps their progress. In Review a template card shows plain front and back text under a mono `from #Vocab · Recognition`.

## Cards popup

A block's card count opens its cards. Each row puts the kind in the same faint capitals in a fixed column, so every card's text starts at one edge, then the front, the answer in `--muted` and the due state. Clozes show their gaps and gilt answers as Review does. Multi-line and list answers show as their outline, at most five items, then `N more`. An occlusion card shows a thumbnail of its tested area and its answer, or `Mask A` when it has none. A template card reads `TEMPLATE` with its `#Vocab · Recognition` provenance under the text.

The popup's Review, Shift-click on the count and the block menu's Review cards start a review of that block's active cards, due or not, titled by the block's subject. ⌘-click on Review opens it beside (Ctrl-click off Mac). An open review shows the same Finish or abandon prompt as switching decks before the block review starts; asking again for the block already under review returns to it. Review is disabled when every card is paused.

The block request is consumed once; later session snapshots and reloads resume that session without starting or re-requesting its source review.

## Done summary and deck forms

The Done summary returns to the shared page insets and responsive title scale, with section gaps between its grade strip, counts, forecast and missed cards. Its header no longer says in progress.

Deck forms retain the popup's viewport gutters on the cover, so fields and actions stay inside both edges.

## Pending grades and session persistence

The current card stays until a grade is acknowledged. Pending commands survive offline reload with their original request bytes. Rejection preserves the command for copying and requires a fresh card snapshot. Unrelated local page edits do not invalidate the shown card.

Exhausting a confirmed queue shows Finishing review… until the finish is acknowledged, then Done and normal deck actions. Finishing early, abandoning or switching an open review is explicit; committed grades and their shown-text evidence remain. Pane history and reload preserve the deck, queue selection and session.

A notebook with no cards offers Create a card, which opens the card composer under the button. An empty deck or held-only inventory keeps its distinct explanation.

## Card composer

The composer is a 560 px slip laid out like Add to today and like the card it makes. A mono rubric line names New card in gilt and, at the right in `--faint`, where the card goes: `Fri 16 · end of journal` from Review, or the source title and paragraph from a highlight. Front is set in the 18 px display voice of a review card and folds from Back on a hairline. Each side has a mono label that turns gilt while it holds the caret. Both fields grow with their text to a cap, then scroll; neither has a resize grip.

Enter in Front moves to Back and Shift-Enter breaks the line. ⌘↵ (Ctrl-Enter elsewhere) creates the card and closes; ⇧⌘↵ creates it and clears the draft for the next one, counting `2 cards added` where the key hints were. Create stays disabled until both sides have text. Text that cannot make exactly one forward card, such as a second `>>`, shows the parser's message under the fields in `--danger` as you type. From Review, Create opens Today at the new block and Create another stays in Review. On coarse pointers the composer is a bottom sheet without key hints.
