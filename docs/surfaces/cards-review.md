# Cards and review

Cards are authored in ordinary blocks and reviewed in a pane on the outline measure. Tokens, shell and shared popup patterns are in [design](../design.md).

## Card syntax and editor markers

The syntax rules are also defined in [Cards in the domain model](../domain-model.md#cards). Author `front >> back`, `front << back`, `front <> back`, or numbered clozes such as `{{c1::answer::hint}}` in ordinary blocks. `::` remains field shorthand. Explicit malformed syntax shows diagnostics instead of guessed cards. Each numbered cloze and each direction has its own stable progress.

| Syntax | Card behaviour | Editor marker |
| --- | --- | --- |
| Trailing `>>>` | A multi-line card whose answer is the block's child outline | `↓` in `--faint` |
| Trailing `>>1.` | A list card whose children are revealed one at a time | `↓1.` in `--faint` |
| `Function ;; makes ATP` beneath `Mitochondria` | A descriptor that asks `Mitochondria › Function` | `›` |

Descriptor card is under `/` and under Space c as `d`. Its review source line leaves out the parent the front already names. Under an empty parent the row says “A descriptor needs a parent with text.”

## Review pane

### Landing and decks

Review is a pane on the outline measure, like [Library](library.md). Its mono register sits over the deck's Piazzolla title and picker; Open reviews and Deck actions stay at its right.

The landing's Due, New and All tabs share the tab-strip baseline, with a 2 px gilt rule under the whole selected tab. The selected queue leads with its bounded batch size and Review N cards (Space). Today's paced due/new counts and fourteen-day forecast stay secondary; All includes deferred introductions.

The forecast's first bar is gilt. Every forecast bar has a two-letter weekday label; today's accessible name is “today”. Retention over thirty local days, this week's review count, the streak and total cards follow, then a deck ledger with Due, New and Cards.

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

A cited card's mono source line shows siglum, title, chapter and paragraph. Open in the book opens that citation (Shift beside), while Edit card opens its canonical block. An uncited card keeps its source path. Reset progress is in Card actions and requires a revealed answer and confirmation.

Prompt and answer use 24 px Piazzolla with a 38 px line height; a rule separates ordinary sides. Multi-line answers keep their child outline, lists reveal one item at a time and grading waits for the last. Clozes reveal in place with a gilt underline, so the sentence appears once.

Once revealed, a cited card shows the following sentence from its snapshot's real passages.

### Responsive behaviour

| Layout | Behaviour |
| --- | --- |
| Unfolded touch screen at least 900 px wide | The card sits left and its passage sits right with the citation highlighted. The passage waits for reveal so it cannot give the answer away. |
| Cover | The bottom nav steps aside during a live session. Tapping non-control card space reveals. Interval-bearing grades form a two-by-two block at the bottom. |
| Larger layouts | Review history stays available. |

Good has the gilt default rule and Space or Enter selects it after reveal; 1–4 remain available.

## Grading and progress

### Keys and intervals

Space reveals the answer. The grading keys are:

| Key | Grade |
| --- | --- |
| 1 | Again |
| 2 | Hard |
| 3 | Good |
| 4 | Easy |

Scheduling is FSRS-6 at 90% retention in whole days. Buttons show the next interval in days, then months and years. When two neighbouring grades have different intervals that round to the same label, both show one decimal (`1.4 mo`), then whole days if they still match. Equal intervals, such as Again and Hard on a new card, read the same.

### Changed cards and reset

A source or schedule change invalidates the shown snapshot and requires Review current card before grading. Changed wording retains identity and progress. The card shows the last reviewed text beside its current text, with Keep progress and Start over choices. Reset progress requires confirmation and keeps review history.

### Finish, abandon and undo

Finish review and Abandon review open anchored confirmations. Cancel keeps the review open; either confirmed action keeps committed grades.

Undo last grade stays visible during a session and on Done, with ⌘Z or Ctrl+Z outside editable controls. It restores the card and its schedule; undoing the final grade reopens the finished session.

If that restored card is later held or removed, an explicit unavailable state offers Next rather than silently replacing it. A transport failure remains an error, not an unavailable-card state.

## Type cards tab

A type's Cards tab, after Fields in the same strip, lists its card templates. A mono line counts members, ready members and those waiting, the last in warning ink with the field they lack.

Each template is a numbered section with:

- Its Piazzolla name and Enabled or `Draft · not in review`.
- Front and Back patterns whose field references show as mono chips; typing `{` opens the field picker.
- `Uses 2 of 5 fields` and a New per day input.
- Beside them, a preview of the first ready member: the front in large Piazzolla over a hairline and the back.

Enable… opens the Apply view, in this order:

1. The cards it will create and the members waiting in large mono numerals.
2. The introduction schedule (`398 / 10 = 39.8 → 40 days`).
3. A fourteen-day chart of existing reviews in muted bars with the added new cards in scheduled blue above them and two-letter weekday labels.
4. The first waiting members with Show all, which opens the [type table](fields-tables.md) filtered to the missing field.
5. Cancel and `Apply · 398 cards`.

Disable pauses a template's cards and keeps their progress. In Review and the outline's cards popup a template card shows plain front and back text under a mono `from #Vocab · Recognition`.

## Done summary and deck forms

The Done summary returns to the shared page insets and responsive title scale, with section gaps between its grade strip, counts, forecast and missed cards. Its header no longer says in progress.

Deck forms retain the popup's viewport gutters on the cover, so fields and actions stay inside both edges.

## Pending grades and session persistence

The current card stays until a grade is acknowledged. Pending commands survive offline reload with their original request bytes. Rejection preserves the command for copying and requires a fresh card snapshot. Unrelated local page edits do not invalidate the shown card.

Exhausting a confirmed queue shows Finishing review… until the finish is acknowledged, then Done and normal deck actions. Finishing early, abandoning or switching an open review is explicit; committed grades and their shown-text evidence remain. Pane history and reload preserve the deck, queue selection and session.

A notebook with no cards offers Create a card, a front/back draft saved in [Today](journal.md). An empty deck or held-only inventory keeps its distinct explanation.
