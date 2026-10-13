# Perspectives and questions

A concept page holds several attributed perspectives. Questions and answers mark authored blocks, and a titled page can be a question. Tokens, shell and shared popup patterns are in [design](../design.md).

## Page projections

Titled pages share one document across Read, Outline and Compare. The pane header switches them in place; Commands offers Read, Outline and Compare perspectives. The choice is remembered for each page on this device. At the page level, switching creates no blocks or navigation entry.

A source with a snapshot reads as its book: Read opens the [reader](reader.md) in the same pane at the saved position, and ⇧ opens it beside. Back returns to the source page, which stays in Outline. A record source keeps the Read projection.

Question pages and pages holding active perspectives about themselves or their inline questions open in Read. Other pages keep their ordinary outline. Outline keeps its Plex editor, depth dial and Show bullets option; `[` and `]` change depth only there.

### Reading register

Read puts the title, Gloss and opening on one text edge. Piazzolla remains the prose voice while editing, so entering the editor never changes the measure or the rows below it. Links, completion and undo use the same editor as Outline. Structural edits return to Outline with the caret at the edited block.

Perspectives puts the perspective and holder counts, Compare and Add perspective on the section heading's line, in mono: the counts faint, the actions muted until hovered. A page without an authored heading above its perspectives gets a Perspectives heading. A pane narrower than 480 px moves them to their own line at the text edge. Each slip leads with the source siglum and holder in mono, then its standfirst as a Piazzolla headline at the gloss size and Work as one faint mono line that truncates. A standfirst that repeats the page's Gloss word for word is not printed again. Account has its own quiet label, followed by authored argument relations. Prose-role fields take the full measure; authored non-field prose opens in place. Attributes and citation fields open under Facts, except criteria asked about under Where they disagree. Neither disclosure writes to the notebook. Open perspective ends the slip's last line.

Slips sit in two columns when the pane is at least 620 px wide and stack otherwise, so a split unfolded Fold reads like a phone. A lone perspective takes the full measure. A stored Work that points at a highlight takes its source's siglum.

The counts line appears on question pages and pages with active perspectives about themselves or their inline questions. Other notes keep Add perspective in Commands. A person's perspectives held elsewhere have their own list; they do not make the page a reading subject.

Outside perspective slips, fields use the same presentation roles as Outline: standfirst sentences, an aligned attribute and citation bed, then full-width prose. A field whose values line up beside its label shows once, as in Outline. A source's catalog fields stay in its source card, so Read never repeats them as loose values.

Open perspective on each slip zooms into that perspective's dossier. Shift opens the perspective beside the page. The Gist and criterion answers stay editable in place; adding fields and filling template slots stay in Outline.

On coarse pointers, Compare, Add perspective, Prose, Facts and Open perspective have the shared pointer-target height, and the holder link's touch target extends above and below its line.

Where they disagree appears only when stored questions name criteria. Each criterion leads with its questions, which link the criterion, then each perspective's answer: its siglum (or holder name when it has none) and its value for that criterion, in the slips' columns. Questions that all name holders show only those holders' answers; otherwise every perspective answers. A perspective without a value reads Not stated. Questions without a criterion stay in their authored place. No differences between field values are turned into questions.

Compare switches the same pane to the existing perspective sheet and criteria matrix. With fewer than two perspectives, the register and Outline's counts line leave Compare out; the count already says why.

Compare shows the perspectives/holders count once in its header; Criteria's tool line gives criteria and question counts. Narrow panes keep Choose perspectives in one horizontally scrolling strip rather than wrapping holders above the perspectives. Criteria questions wrap within the visible matrix width and stay with the sticky criterion edge, including their scope and Open original action.

### Adding a perspective

Add perspective is in the register, the Outline header and Commands. Who holds this? lists People and Groups first, then other pages, then Create for a new name. Choosing appends an attributed perspective after the last perspective in its section, or at the page's end when there are none.

The holder link, position capability and empty Gist slot are one undoable edit. The caret starts in the Gist value in filling mode, in Read and Outline. Typing keeps the same editor mounted while the blank value becomes a sentence; Tab moves to Work, then the subject's criteria. Creating a holder makes an ordinary page; undoing the perspective keeps that page.

### Section navigator

Long Read and Outline pages keep a quiet section line at the top of the scroller. Within a perspective it names the section and holder, such as Perspectives · Polybius. Its menu, Sections and perspectives, jumps to the opening, a section or a perspective. It has a reserved line, so appearing does not shift the text.


## Perspectives and holder rows

Make perspective, in the block menu, the palette and `/perspective`, turns a block such as `[[Plato]]` into a perspective; Remove perspective undoes it. Internally the capability is still called a position.

Its row names the holder at control weight. The holder link keeps the text color with a `--line` hairline underline; hover or focus turns both gilt. Attribute values that name pages, such as Work, read the same way, while links in prose stay gilt. Its source's siglum hangs in the margin; rows inside the perspective do not repeat it. A standfirst field drops its label and reads as the sentence under the holder, so the pair reads "Plato / A line of decline". At the Perspectives depth each perspective closes to its holder and standfirst.

Clicking the holder link opens the holder's page beside, like any reference, in Read and Outline. Change holder and File under are in the block menu, palette and slash menu. Its picker lists People and Groups, including their refined types, before other pages. File under lists page and inline questions and concepts first. The pickers write ordinary link tokens and preserve the prose.

Use place, in the same menus, returns to the nearest ancestor question or the page. It removes the subject only when that link is a standalone token immediately after the holder. Otherwise the action shows why the author must edit the prose. Each change has one undo step; the palette names the selected perspective.

### Holder and subject pages

A holder's page opens into its perspectives grouped by subject, with a Compare action when that subject has two or more perspectives. Each row leads with the source siglum and the Gist in Piazzolla, then Work as a faint mono line; the holder's own name does not repeat. The register follows the opening, before the first heading, or leads when the holder has no rows. It replaces Perspectives held.

Clicking a perspective opens it zoomed on its source page. Shift-click opens it beside. A subject's page still lists Perspectives filed elsewhere above its backlinks; neither list repeats under Backlinks.

Incoming relations appear beneath each listed perspective, naming the source's holder when it is a perspective. A holder's page can therefore show which perspectives dispute, support, qualify or answer that holder's perspectives without a text search.

### Saved perspective presentations

A Perspectives view can use Register or Matrix without copying its perspectives. Register groups by subject or holder and shows standfirst sentences, Work and the other fields in an editable bed. Its filling keys and original-page undo match Read. Open perspective enters the perspective dossier; the subject link opens its page or inline question.

Matrix groups every subject into its own sheet. Holders occupy rows and the subject's explicit or derived criteria occupy columns. The common six-holder, three-criterion sheet stays compact. It reuses Compare's cell editor and exact-repeat marks. A phone stacks each holder's labeled criterion cells without document overflow. Both presentations stay live after save and reload.


## Compare perspectives

### Perspective sheet

Compare perspectives, in the page menu and the palette once a page has two perspectives filed under it, opens a perspective sheet under a Perspective sheet eyebrow. Its toolbar names the subject in Piazzolla with a mono count, such as `8 perspectives by 7 holders`. Perspectives and Criteria share the same selection, initially all perspectives. Choose perspectives adds or removes columns while retaining at least one.

Each column shows, in order:

- An unboxed source siglum.
- An 18 px holder name, with its authored Shape glyph alongside.
- The Work reference.
- A quiet Account line, under its small-caps label, when present.
- A 17 px gist and 16 px authored prose.

Shape is not its own cell. Other fields stay in the source outline, reached through the holder or Open perspective (Shift beside), rather than becoming a universal questionnaire. No prose is generated from field values and differing strings are not treated as evidence of disagreement.

Relation blocks and their reasoning stay out of perspective prose. Each perspective card shows its outgoing relations on a quiet line, with the kind and linked target, so the argument remains visible without turning its apparatus into another paragraph.

Actual question blocks on the subject page appear below the sheet. Clicking a question focuses it; Open original opens its block. Columns have a readable minimum width and scroll horizontally on narrow panes.

The perspective sheet's heading uses the shared centered page measure and page-title tokens. Its holder choices use the mono tab strip, with gilt rules and no pressed fill.

### Compare tabs

Compare has Perspectives and Criteria tabs under the subject title, in the same mono strip. Criteria opens first when the subject has criteria, and the pane remembers the choice.

### Question focus

A focused question stays pinned above either sheet. Only perspectives held by the holders linked in that question remain; a question without named holders keeps all perspectives. Criteria marks the question's linked criterion. Clicking the pinned question, Show all perspectives or Escape restores the sheet. The focus survives reload and switching tabs without changing the perspective selection. Open original question remains a separate action.

Escape clears question focus anywhere in the active Compare projection, including immediately after reload. An open editor or popup keeps its own Escape action first.

At phone width the focused perspective sheet stacks its perspectives and the focused matrix fits its columns within the pane. Question text and scope wrap.

## Criteria matrix

### Layout and values

The criteria matrix leaves the heading on the measure and widens to the pane. A mono line counts perspectives, holders, criteria and questions beside Choose perspectives and Edit criteria.

Each column heads with the siglum in mono, the holder in 18 px Piazzolla and the Work title in mono. Each row starts with the criterion's name in Piazzolla in a sticky first column. Columns keep a readable minimum width and the matrix scrolls sideways in a split pane.

Cells are the perspectives' own values. Enter or a click edits one in place, an empty cell offers Add on hover or focus, and both are undoable edits of the perspective's page.

Choice and Instance cells use the field bed's option and page pickers, writing references to the chosen targets. Readable and empty Date cells open the calendar; unreadable dates stay editable as written. Checkbox cells toggle with a click or Space.

Span and other text cells use the outline's CodeMirror block editor, including paired references, completion, Unicode and composition. Spans keep their written historical notation. Enter commits, Shift-Enter adds a newline and Escape cancels. Saving resolves hand-typed `[[Title]]` references by title or alias, retaining the authored spelling, as in the outline. Shared names stay unlinked rather than choosing a page.

A whole-cell `((` choice captures the same frozen quote as the outline, with `((ID))` text and dated Quote attribution. Inline `((` inserts a live reference. Quote text, snapshot and any missing field structure commit together; undo and redo preserve the snapshot.

Draft undo and redo remain inside the open cell until commit. A committed edit belongs to the perspective's shared page history, so sheet undo and page undo operate on the same change. The sheet routes undo to the last edited page, not a private edit stack.

Enter and Escape return focus to the same criterion cell. Reloading the joined perspective data keeps that cell's identity, so an immediate undo chord works without refocusing the sheet. Leaving by clicking another control keeps focus on that control.

Two or more cells in a row with exactly the same authored text get a numbered `≡ 1 · exact repeat` mark and a footnote naming the sigla; nothing else is marked. References in the footnote show their current labels. The comparison still uses the stored text and target identity.

### Questions and criteria editing

A question that names a criterion follows that row with a `?`, its text in Piazzolla and a mono scope, `Shape · all 6` or `Shape · POL ↔ MAC only`. Other questions stay below.

Edit criteria lists the criteria with Move up, Move down and Remove and adds fields through the field picker. While the set is derived it says so, and saving stores it.

Derived criteria exclude Gist, Work and Account. Work attributes the primary work. Account names a secondary account. Neither is a comparison criterion. Evidence remains the passages cited beneath each perspective. Pinned perspective slips show Work and Account as separate lines too.

## Perspective dossier

Zooming into a perspective replaces the concept's title with holder · Gist, then Work and an `on Subject` link. Only backlinks to that block and its incoming relations appear; page-level backlinks, unlinked mentions and the apparatus stay out of the dossier.

Read in a perspective dossier opens its titled subject page without the zoom, brings the perspective into view and briefly marks its slip. A perspective filed elsewhere opens its subject's Perspectives filed elsewhere section instead. The mark leaves the row's size and location unchanged. The resulting Read projection and location survive reload. Header and Commands use the same action.

Other block zooms show Read unavailable with a visible reason and a way back to the full page. A perspective whose subject is a journal explains that Read needs a titled subject, with File under as the way to choose one.

Other block zooms also show only their own incoming links, under Linked to this block. Perspective reference previews lead with Gist and authored argument rather than field scaffolding.

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

## Argument relations

Supports…, Disputes…, Qualifies… and Answers… in the block menu, Commands and slash completion mark the selected block as a relation. On an empty block, the action opens link completion for the target. Existing edges offer Change kind and Remove relation; removal keeps the text and children.

Add relation… on a perspective, assessment or question asks for the kind and target, then adds a last child edge as one undoable change. A question, perspective or assessment cannot itself become an edge; the unavailable action explains why.

An edge keeps its ordinary editable row. Its kind appears before the text as a quiet small-caps field label. A problem marker explains a missing or deleted target, or an Answers target that is not a question, without changing the text.

A target shows one quiet line beneath its row: Supported by, Disputed by, Qualified by or Answered by, followed by each source's holder name or source label. Each name opens that source. Labels and incoming lines wrap on narrow screens.

## Questions and answers

### Authoring

Question and Assessment in the block menu's Make… chooser, or Make question and Make assessment in Commands and slash completion, mark a block as a question or a dated assessment beneath one. They add to the note and keep its text; existing features move to their named managers. A titled page can be a question from its page menu. Write assessment on a question adds a dated child and places the caret in it as one undoable change. Add branch question adds a child question, whose parent comes from its place.

Set parent question… is available for a question block in its menu, the palette and slash commands, including a question page's root. The picker offers only questions, with their containing page as context, and leaves out the question and its branches. Choosing one is one undoable change.

A question's title area or inline row shows a quiet Part of line that opens its effective parent. An explicit parent offers Change parent… and Remove parent; a structural parent has no Remove action. Both the line and its actions wrap on a phone.

A question page opens with its direct Branches before its body in Read and Outline. Each opens the original question and shows state, perspective count, current assessment's first line and date, or No current answer, and its revisit date. Inline branches appear alongside question pages. Branches do not repeat in backlinks. The list wraps on a phone.

### Question states

The state control sits in the capability metadata with the question glyph and its state, then any review date.

| State | Color or token | Glyph |
| --- | --- | --- |
| Active | Gilt | Question glyph |
| Recurrent | `--agree` | Question glyph |
| Answered | `--status-done` | Settled glyph |
| Parked | `--faint` | Question glyph |

The Question… manager keeps Open in desk, Write assessment, Add branch question, Set revisit date… and Add relation… together, with Remove question last and separated. Question settings… contains Park or Resume, Make recurrent or Allow resolution, Withdraw current answer, Set parent question… and Remove parent when present. Drill-ins have a title and Back; coarse phones use one bottom sheet. Routine rows stay concise, while Commands and slash retain descriptions. Disabled choices explain prerequisites without hover.

### Decision journal

The question's Decision journal lists its assessments newest first. Each shows its assessment date, status, first line, linked perspectives and cited passages. Current answer is explicit; earlier entries say Superseded on or Withdrawn on with the decision date. An unaccepted assessment reads Not accepted alongside its date. Aporia stays a separate mark.

The journal appears only when the question has an assessment, including inline criterion questions. Empty questions keep Write assessment in their menu, Commands and slash completion. The journal's label stays on one line; its writing action wraps below it when space is short.

Accept current answer chooses one assessment. Accepting another keeps both and records the supersession date. Withdraw current answer keeps the assessment, text and citations. Each transition is one undoable change and survives a reload. Two assessments a month apart show what each cites, without an automatic diff.

The Assessment… manager offers Accept current answer and Record aporia or Clear aporia, with Add relation… when available. Remove assessment is last and separated; it removes the date and assessment state, not the text, and clears acceptance. Undo restores both. A parked question's unavailable Write assessment and acceptance actions say to resume it first.
