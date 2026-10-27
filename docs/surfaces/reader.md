# Reader

The reader displays a source in a pane, with reading progress, chapter navigation and passage highlights.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Layout

The pane header reads Library / source title, followed by the source page's Read, Outline and Compare tabs with Read selected. The title opens the source page. Outline and Compare return to it, through the pane's history when the book was opened from that page.

One toolbar line sits at the reading measure and spans the spread in [Pages](#pages). Its controls appear in this order:

1. Contents, labeled with the current section as a running head: its numeral in mono `--faint`, its title in Piazzolla italic.
2. Highlights, with its count.
3. Find in source.
4. `Aa`, for reader settings.
5. Full screen.
6. An actions menu: Open source, then reader shortcuts with their keys, including the five highlight colors and page-turn keys in Pages. Commands that need a selection say so.

On the touch cover screen, the toolbar splits into two glass surfaces using the shell's glass tokens. The top navigation bar has a circular Back button, the book title centered and ellipsized, then circular `Aa` and actions buttons. Back returns through the pane's history to the Library when opened there. A bottom capsule above the home indicator holds Contents with the current section, Highlights with its count and Find in source. The book map and foot line lift above that capsule while the controls show, without moving the reading text. With reduced transparency, the glass surfaces use `--raised`.

Progress sits at the foot, under the text. The [book map](#book-map) sits above one mono line: the chapter's numeral and italic title, its time left, and `N% · time left in the book` at the right. The last item opens the [progress card](#progress-card). The chapter name is absent in front matter. In a foot narrower than 460 px, a shortened chapter label remains in a two-line folio rather than disappearing. In Pages, the foot spans the spread as the toolbar does.

The text fades over 24 px under the toolbar and 48 px above the foot, so no line is cut through its letters.

### Title page

The book opens with a title page read from the source page like the Library row. Renaming the book or editing its creators shows there at once; the file's own title stands in only until the page loads.

The title page has:

- A 112 px cover, or 76 px on the cover screen, beside the imprint in the apparatus: siglum, publisher, year, the siglum and year in mono.
- The title in Piazzolla at 2.25 times the reading size, with any subtitle in italic beneath it. The subtitle follows a colon or comes from the source's Subtitle.
- The author in Piazzolla italic.
- A gilt rubric rule.
- The chapter count, using the shared chapter entries regardless of their language or numbering, and reading time in mono.
- A gilt Begin at link to the first opening: `Begin at Preface`, `Begin at chapter I`.

The file's own cover image at the start is not drawn again. A split title, parenthetical edition and recorded creator byline immediately repeating the title page are not drawn again either. Contents sections named Cover, Title page, Title or Half title are not drawn, since the title page replaces them; an illustration in one that is not the cover stays, with the caption text that follows it. Before the first chapter, a line made mostly of words from the title, subtitle, creators (in either order) and publisher, with at most two other words, is not drawn, as `A Farewell To Arms Hemingway, Ernest`. Copyright, dedication and epigraph text stays. Highlights keep their passages visible.

Creator names join with ` · `, matching Library and source headers.

## Chapters

Chapters are the outermost contents level with two or more entries, as in a printed book. A part whose own text before its first entry is under 2,000 characters, such as a title page or an epigraph, instead holds chapters: the part opens on a page of its own and each chapter in it is a chapter. A chapter with a page or more of its own before its sections keeps them inside it.

The reader's pages, the foot, the running head, the book map, the progress card, the source page, the [Library's reading cards](library.md) and the [journal's reading tile](journal.md) all count chapters this way.

### Front matter

Front matter is a stretch of the map but never named as the chapter. It includes cover, title page, copyright, contents, illustrations, abbreviations, dedication, epigraph, maps, family trees, cast lists, lists of figures and tables, praise, and the author's other books.

Older inferred contents entries that name a lone paragraph by a truncated excerpt are not chapter titles. Once their source passages load, the reader leaves them as prose instead of giving them an opening, a Begin at link or a chapter name. Longer prose-chapter destinations stay in Contents.

### Chapter openings

Chapter openings come from the contents, not the file's heading markup, so every book opens its chapters the same way. Each chapter, except front matter and entries that only repeat the book's title, opens four lines down from the passage before, with:

- A rubric label in tracked capitals: `CHAPTER I`, `BOOK ONE`, `INTRODUCTION`; none for an unnumbered section or an entry that is only a numbered label, whose whole entry is the title (`Book Three`, `Chapter 5`).
- The title in Piazzolla at 2.1 times the reading size.
- A gilt rubric rule.

The first line of text takes small capitals. A chapter that starts at the same passage as its part has the part above it in `--faint` tracked capitals, as `PART ONE · AN EXCESS OF GOOD FORTUNE`.

Numerals are recognized as `Chapter 3`, `Book One`, `Part II`, or a bare upper-case Roman numeral or number before `.` or `:`. A title such as `I Remember` stays a title. Decorations around a title, such as `~Book One~`, are dropped.

### Title case

A contents title shows in one form wherever the reader, Find, Review or the palette names a section; the stored entry never changes. A title set entirely in capitals takes title case, with minor words (a, an, and, as, at, but, by, for, in, nor, of, on, or, the, to, up, via, with) lowercase except first and last: `THE FIRST BOOK` reads `The First Book`. Roman numerals stay capitals. A mixed-case title keeps its authored case, except that its first letter is capitalized and a word of five or more capitals inside it takes title case, so `concerning HIMSELF:` reads `Concerning Himself` while `NATO` stays. Trailing colons, semicolons, commas and a word's final period are dropped.

### Heading suppression

Heading lines that only restate the entry, its label, its numeral in any style or the book's title are not drawn, from the entry's first passage up to the next opening. Anything else, such as an epigraph, a highlight endpoint or an image, ends the run. A highlight crossing an opening does not reveal its suppressed headings. A selection crossing hidden source text asks the reader to highlight each side separately, rather than silently adding the hidden text to its citation. Find still searches the suppressed lines.

Contents entries that only repeat the book's title, running heads the file marked as navigation, leave the Contents menu, the margin and the book map. Their running-head passages are not drawn.

## Reader settings

Reader settings are a device preference shared by every reader pane. Saved choices are preserved. Changing a setting keeps the first visible passage in place. Switching from Pages to Scroll keeps the first visible character, including within a long passage.

On touch, settings open as a bottom sheet. Width shows only where Narrow is narrower than the text's room, so a phone, where all three widths fill the screen, leaves it out. Short landscape screens put the setting groups in one horizontally scrolling row so the reading page remains visible above them.

| Setting | Choices | Default |
| --- | --- | --- |
| Layout | Scroll; Pages | Scroll |
| Typeface | Sans (Plex); Serif (Piazzolla) | Serif |
| Size | 15 to 22 px | 17 px |
| Width | Narrow 28em; Medium 34em; Wide at the outline measure | Medium |
| Line spacing | 1.5; 1.65; 1.8 | 1.65 |

### Text and media

- Headings scale from the reader size.
- A jump from Contents, the book map, the progress card, Highlights or Find leaves Back to the section it left (or the passage, before the first section) in the line under the map, in place of the chapter's time left. It returns to the exact place, page included, while reading stays in the section the jump landed in; a further jump keeps the first place, and reading on out of the landed section drops it.
- Footnote references stay live inside highlights. They open the note in a popover with Open footnote to reach its annotatable passage. Back to footnote reference returns to the reading place. On touch screens the superscript keeps its printed size with a 44 px hit area. Imports recognize explicit note markup, numeric superscript links and numeric references whose targets begin with a backlink.
- Images keep their natural size up to the measure and 70% of the viewport height. On the dark canvas they are dimmed to 85% brightness until hovered.
- Code sits on `--surface` in a horizontally scrolling block.
- Quotations take a 2 px `--line` rule at an indent. When quotes outnumber plain paragraphs among the loaded passages, they read as plain paragraphs instead: some EPUBs wrap the whole text in blockquotes.
- Each highlight has one keyboard target, named by its full quotation, even when its ink crosses formatting or passage boundaries. Enter and Space open its actions. Inline links retain their own keyboard targets.
- Articles authored with repeated line breaks keep those paragraph boundaries, giving progress and saved positions a passage to follow. A single line break remains inside its paragraph.

[Pages](#pages) has its own image-height limit.

## Contents, highlights and find

Contents opens on the current section, marked with a check, when no persistent margin is visible. With the margin visible, Contents focuses its current entry (or the first entry before reading begins) instead of opening a duplicate floating list. The Highlights picker lists each highlight's color, quote and section. Choosing a highlight reveals its marked words, including when its paragraph spans page breaks. In Scroll, citation jumps leave the marked line below the top fade. Find marks matches, counts passages and labels each result with its passage number and section.

The Highlights picker's section column stays 12ch wide beside the quote. Clicking a highlight already in the text keeps the reader's scroll position. Highlight bands remain visible on chapter-opening first lines.

On the touch cover, Contents, Highlights and Find open from the bottom capsule as bottom sheets. Contents and Highlights leave the query field unfocused so they do not open the keyboard; Find focuses its query. Contents keeps the current entry in view. Reader picker choices and progress chapter rows are at least 44 px high on touch. On narrow screens, highlight locations sit below their quotes rather than sharing a line.

Contents falls back to the EPUB guide and fills in lazily when the navigation document is empty. Inferred spine entries leave out isolated epigraph quotations rather than turning their prose into chapter titles. A passage's tooltip names its number and section: `Passage 37 · Chapter 1`.

### Contents margin

Wherever the pane has room for `--apparatus-width` and a 48 px gap left of the text, the contents stay open as a margin beside it. This includes a single pane on a laptop, or full screen beside a two-column spread.

- Every entry uses control text, indented 12 px per level, in `--muted`.
- The current section is gilt with a 2 px gilt rule at its left edge, kept in view as reading moves on.
- Clicking an entry jumps there as Contents does.
- The margin scrolls on its own.
- Narrower panes, split panes and phones keep only the Contents menu.

Choosing a section in the margin, Contents, the book map or the progress card is a peek, like opening a citation: the saved reading position stays where it was until reading goes on from there, by a page turn or a screen's scroll. Begin at on the title page starts reading at once and saves there.

### Find in source

Find in source loads forty matching passages at a time with Load more. Appending preserves the selected result and popup scroll; the final count removes the action. Replacing the query, closing the picker or changing source discards late results from the previous search.

Search matches arrive as structured text parts. Literal source brackets, including footnote references, stay intact and are not mistaken for match markers.

## Progress

Progress anywhere, in library rows, the source header or the reader, is one number: the share of the text before the first passage on screen, rounded down, `<1%` once started. At the end of the book, the reader reports 100% and Finished instead of time remaining.

Until the saved position is restored, the text, the foot line and the Contents label are not drawn and the running head stays quiet, so the start of the book does not flash before the jump. The reading position saves while scrolling. Leaving or hiding the reader saves the latest eligible position without waiting for the scrolling pause. Opening from a citation scrolls to its marked words and flashes them without counting as reading.

### Book map

The book map is the same as on the source page and the [Library's reading cards](library.md):

- Chapters are segments sized by length.
- The map is gilt to the reading point, with a `--text` tick there.
- Highlights are dots in their colors above it.
- A book whose contents have no placed entries keeps a 2 px rule that fills to the reading position.

### Progress card

`N% · time left` at the foot opens the progress card: above it on a pointer screen, and as a sheet rising from the bottom edge on the cover screen.

The card shows, in order:

1. `N% of the book`, with the number in Piazzolla; the chapter by name, `4 · Deus Vult!, 43% through`, with nothing in front matter; and Added in the apparatus at the right, its date in mono. Added uses the shared civil-date rule: `today`, `tomorrow` and `yesterday`, the weekday within six days either side, then the month and day, with the year outside today's.
2. The map at double height, with Start, the highlight count and End beneath it.
3. Left in chapter and Left in book, with their numbers in Piazzolla.
4. The current chapter and the next five as rows. Each has its numeral and title as the toolbar names it and its length in minutes. The current one has a gilt edge and reads `N min left`.

Choosing a row reads on from that chapter, as Contents does. An apparatus note says the times assume about 250 words a minute. The card leaves out the day's reading and a finish estimate, because Tessera does not record reading sessions.

## Pages

Pages lays the text out in columns the height of the pane and turns them a page at a time. A page holds two columns when the pane fits two of at least 22em, and one otherwise. No column is wider than the reading measure. Two columns are 48 px apart, with a 1 px `--line` rule down the middle as the spine.

### Running heads and openings

A running head in centered `--faint` sits over each column, in the foot's vocabulary: a numeral in mono, the title in Piazzolla italic.

| Page | Running head |
| --- | --- |
| Two columns | The book's title over the left; the chapter, `I · The Violent Tenor of Life`, over the right |
| One column | The chapter alone |
| Front matter in two columns | Nothing over the right |
| Title page or a chapter's opening page | No running head |

A chapter's opening sinks 18% of the usable page height, as a printed chapter starts low on its recto. Below 320 px of usable height, the opening reduces its drop, title size and lower spacing to keep the label, title and rule together. Each chapter, [counted as above](#chapters), starts on a fresh page. A long chapter splits every 150 passages.

The foot line adds `p. N of M` within the chapter after the chapter's time left. Time left counts the characters after the first passage on screen at 1,500 a minute and reads `<1 min`, `N min`, `H h` or `H h M min`.

### Turning pages

| Input | Behavior |
| --- | --- |
| Mouse | Previous and next arrows in `--faint` sit at the page edges, 8 px outside the text and gilt on hover, hidden at the first and last page of the book. The mouse wheel turns pages. |
| Keyboard | Left/Right arrows, Page Up and Down, Space and Shift+Space back turn pages when focus is outside an interactive control. Up/Down retain their normal scrolling behavior in Scroll layout. |
| Touch drag | A finger carries the page sideways and the next one follows it in. A drag past a quarter of the page or a flick turns it; a shorter one springs back. At the book's first or last page the page only gives a little. |
| Touch tap | A tap in the outer sixth of the page turns it, unless it lands on a highlight, link or button. The edge arrows are left out. |

Past the last page of a chapter, the next one opens at its first page. Turning back opens the previous chapter at its last.

Headings stay with what follows. Images and code blocks are not split, and images fit within half the viewport height.

Folding, unfolding, resizing the pane and changing a setting keep the first character on the page in view, so a long passage spanning pages does not jump back to its start. Returning to the earlier size returns to the same page.

## Full screen

Full screen, the corner-arrows button after `Aa` or `F`, turns the whole app window into the reader. The rail, sidebar, pane tabs, pane header and the other pane step aside. The reader's own toolbar stays for contents, highlights, find, settings and the way out.

### Fading controls

| Screen | Fade and return | Layout while faded |
| --- | --- | --- |
| Mouse | The toolbar and book map at the foot fade 2.5 s after the pointer rests and return when it moves. The line under the map stays. | Everything keeps its room, so the text never moves. |
| Touch, in full screen or on the cover screen | A tap in the middle of the page, not on a highlight, link or button, fades or returns the controls and book map with the cover screen's navigation bar and pane tabs. | The controls overlay the reading text without reflowing it. On the cover screen, the glass navigation bar sits at the top and the reading-tools capsule at the bottom; the foot line lifts above the capsule while shown and returns to the screen's foot when hidden. On wider touch screens, the toolbar stays at the top with the text fading into its full-width band. |

On Android the status and navigation bars leave and return with the active reader's controls, and a swipe from the screen's edge shows them for a moment. Inactive readers never hide the system bars or working-pane tabs. The native app keeps that bar mode through folding and keyboard changes. Closing a note after folding returns both bars to the reader's current mode. Full screen on a touch screen 600 px or wider also gives the page the status bar's room, and the toolbar returns below the bar. The cover screen keeps that room for its camera.

Entering or leaving full screen morphs the page between its two sizes instead of snapping. The selection toolbar stays for one exit fade after the selection clears, showing the selection it last had.

On touch the controls also fade on their own when the book has opened, a page turns, a jump lands or the page is scrolled, so they never cover what is read next.

- A tap that closes a popup or clears a selection does only that.
- The controls stay while a popup is open, text is selected or keyboard focus is in the toolbar.
- A click that left focus on a toolbar button does not hold them.

### Window and exit

In the macOS app, an empty strip the rail's height stays on the canvas as the title bar, holding the window buttons and moving the window. Reader full screen does not ask the operating system for full screen; on the desktop, the window menu's Full Screen does that separately.

The same button, `F`, `Esc` after any selection is cleared, Back on Android and the browser's back button leave reader full screen. It also ends when the pane opens something other than the reader. It is not saved, so a reload starts in the normal layout without leaving a full-screen history marker behind.

## Selection and highlights

Selecting text shows a small toolbar beside an endpoint's visible line, above or below it without covering the selected words when space permits. It leaves when the reader becomes inactive or hidden. Scrolling with a mouse clears both the toolbar and the selection. [Touch selection](#touch-selection) docks it in thumb reach instead.

Reader popups and sheets suspend the standalone selection toolbar without clearing the selection. The toolbar returns on dismissal if reader text remains selected.

| Action | Key | Result |
| --- | --- | --- |
| Highlight | `H` | Appends a block quoting the selection to the source page |
| Highlight and annotate | `N` | Appends the quoting block, starts an empty child and opens the highlight beside the reader with the caret there |
| Five colors | `1`–`5` | The five color choices |

An empty note does not mark the highlight processed. On touch, Highlight and annotate opens the [note sheet](#highlight-and-annotate-sheet) instead.

`S` selects the sentence at the reading cursor. On a continuation page without a cursor, it selects the sentence at the first visible character rather than returning to the paragraph's beginning. A leading paragraph number, such as `XXIV.`, goes with the opening prose sentence; the number is not a sentence of its own.

### Highlight ink and interaction

Highlights are ink, not boxes. A band of their color sits under the lower half of each line, from 55% to 92% of the line box, and is cloned onto every line. On the midnight canvas the band is that hue at lightness 0.54 with its chroma raised by a quarter, so the color can be named; on vellum it is the same hue at lightness 0.90. Without a color, a neutral 26% `--text` band is used. Capitals and ascenders keep the canvas and neighboring lines stay apart.

Hovering a highlight deepens the band of every range it covers to lightness 0.60 by night and 0.84 by day, or to 40% without a color. One with notes ends in a small note icon in `--faint` that opens them. Clicking a highlight opens its menu. ⌘-click opens its block beside the reader (Ctrl-click off Mac).

Add atom and Open atom activate the child editor from the local document immediately. Saving and catalog metadata do not delay typing. On a touch screen, Add atom on a highlight without a written note opens the [annotate sheet](#highlight-and-annotate-sheet) instead, as Highlight and annotate does; Open atom still opens the highlight's page beside the reader.

Removing a highlight offers Undo in a notice for eight seconds, held while hovered or focused. Undo last edit remains in Reader actions after the notice leaves.
On the touch cover, the existing-highlight menu opens as a bottom sheet with 44 px color buttons and action rows.

### Overlapping highlights

Highlighting a selection that overlaps existing highlights extends the earliest one on the source page to cover the union instead of stacking a new mark.

An explicit color choice colors the resulting union. Highlight and Highlight and annotate keep the surviving mark's color.

Merge overlapping highlights, in the reader's actions menu, does the same for every overlapping group and reports `Merged N highlights` or `No overlapping highlights`. Highlights cited from other pages are kept and still count toward the union, with `; N cited elsewhere kept` added to the report.

## Touch and the cover screen

The cover screen is a touch screen under 600 px. Its shell rules are in [design](../design.md).

An open book reads edge to edge without the pane header or the nav. A back arrow and the book's name head the page above the reader toolbar. Full screen is left out because nothing remains to hide.

The back arrow returns through the pane's history, or opens the source page when the reader was the first entry. The reader holds a browser history entry, so the system Back gesture on Android closes an open sheet first and then leaves the book the same way, instead of leaving the app. Unfolding brings the usual shell back around the same page.

Entering the cover reader changes the workspace gutters at once, before restoring and revealing the page. The shell's margin animation never changes the reading width during that reveal.

### Touch selection

The selection toolbar docks across the foot of the page in thumb reach, clear of the system's own text menu beside the selection. It is no wider than the rendered reading measure, with 44 px buttons sharing the width and no key hints. It moves to the head only when the selection runs down there. Scrolling keeps the toolbar while text remains selected and updates its placement.

### Highlight and annotate sheet

On a touch screen, Highlight and annotate, and Add atom on a highlight without a written note, keep the passage in view instead of opening the source page. A sheet covers the shell, showing in order:

1. The book's title and byline.
2. The reading rule.
3. The section in the apparatus and the position in mono.
4. The sentence leading into the quotation in `--muted`.
5. The quotation itself, larger on a highlight tint with a gilt rule.
6. The sentence after it.

The quotation and its surrounding sentences describe the resulting highlight, including the whole union after an overlap is merged. A punctuation-only tail is skipped in favor of the next textual sentence.

Below, on `--surface`, sit "A thought on this passage" with one way back beside it, the note field and the save state in `--muted`.

The note is the highlight's child block and saves as it is typed. The button reads Back to reading while the note is empty and becomes a gilt Keep annotation once there is text; Escape, Android Back after the keyboard closes, and browser Back do the same. Back closes the sheet before leaving reader full screen. Leaving with nothing typed removes the empty note; the highlight stays. Returning waits only until the change is saved or queued locally, not for a service acknowledgment, so offline notes stay kept without blocking reading.

The sheet contains keyboard focus and makes the reader behind it inert. Tab and Shift+Tab cycle between the note field and its button. Closing restores focus to the initiating control, or the reader if that control has gone.

When the keyboard takes room, the passage scrolls so the whole quotation and as much of the lead-in as fits stay visible, and the byline goes.

### Popups, targets and Android

On a touch screen, Contents and Highlights open without raising the keyboard; their search field takes a tap. Without hover, Reader actions keep only Open source page, Merge overlapping highlights and Undo last edit (and Full screen off the cover screen): the keyboard commands have the selection bar, swipes and taps instead. `Aa` rises as a sheet from the bottom edge, its rows kept to a column, so the text it changes stays in sight above.

The reader toolbar, the settings and the note sheet's buttons are 44 px touch targets (`--touch-target`). The note mark after a highlight and the progress at the foot reach as far without growing. In Pages, the note mark's target still reaches into the gutter outside the clipped page and takes priority over an edge page turn.

On Android the shell and the note sheet sit below the status bar. The app reports its height itself because the WebView leaves it out of the safe-area insets, and the bar's icons follow the app's theme.
