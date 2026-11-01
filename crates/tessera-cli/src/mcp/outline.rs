//! Markdown outlines from agents, parsed into note blocks.

use std::iter::Peekable;
use std::str::Lines;

use tessera_core::card_text::{CardParse, parse_card_text};
use tessera_core::{NoteBlock, TaskState, TaskStatus};

/// The deepest an outline may nest, headings and list levels together. The
/// service refuses a note nested much deeper as malformed JSON.
const MAX_DEPTH: usize = 50;

/// The markers that make a list item a task, as `tessera_read_page` writes
/// them.
const TASKS: [(&str, TaskStatus); 6] = [
    ("[ ]", TaskStatus::Todo),
    ("[x]", TaskStatus::Done),
    ("[X]", TaskStatus::Done),
    ("[doing]", TaskStatus::Doing),
    ("[waiting]", TaskStatus::Waiting),
    ("[cancelled]", TaskStatus::Cancelled),
];

/// Line breaks the editor's field shorthand refuses in a name or a value.
const BREAKS: [char; 4] = ['\n', '\r', '\u{2028}', '\u{2029}'];

/// Parse a Markdown outline into note blocks. Headings contain what follows
/// them until a heading of the same or a higher level; list items nest by
/// indentation, and so do the values under a `Name::` line; indented lines
/// under an item continue it, and every other line is a block of its own; a
/// fenced code block stays one block. The escapes `tessera_read_page` writes
/// read back as the text they stand for.
pub(super) fn outline(markdown: &str) -> anyhow::Result<Vec<NoteBlock>> {
    let markdown = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    let mut parser = Parser::default();
    let mut lines = markdown.lines().peekable();
    while let Some(line) = lines.next() {
        parser.line(line, &mut lines)?;
    }
    Ok(parser.blocks)
}

/// One block's text as `tessera_read_page` shows it, read back as stored:
/// the escapes on each line are undone, except inside a fenced code block,
/// where only `--\>` is.
pub(super) fn block_text(text: &str) -> String {
    if text.split('\n').next().and_then(fence).is_some() {
        return text.replace("--\\>", "-->");
    }
    text.split('\n')
        .map(|line| {
            let start = line.len() - line.trim_start().len();
            format!("{}{}", &line[..start], unescape(&line[start..]))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Default)]
struct Parser {
    blocks: Vec<NoteBlock>,
    /// Levels of the open headings as written, outermost first.
    headings: Vec<usize>,
    /// Columns of the open list levels below them, outermost first: an
    /// item's marker, or the start of a `Name::` line, whose values nest
    /// under it.
    levels: Vec<usize>,
    /// The content column of the last block while it is an item that lines
    /// indented that far continue.
    open: Option<usize>,
}

impl Parser {
    fn line(&mut self, line: &str, lines: &mut Peekable<Lines>) -> anyhow::Result<()> {
        let (indent, rest) = indentation(line);
        let text = rest.trim_end();
        if text.is_empty() {
            return Ok(());
        }
        let continued = self.open.filter(|column| indent >= *column);
        if let Some(fence) = fence(text) {
            match continued {
                Some(column) => {
                    let code = code(text, indent, fence, column, lines);
                    append(&mut self.blocks, &code);
                }
                None => {
                    let code = code(text, indent, fence, 0, lines);
                    self.push_text(indent, code)?;
                }
            }
            return Ok(());
        }
        if indent < 4
            && let Some((level, title)) = heading(text)
        {
            return self.push_heading(level, unescape(title));
        }
        if thematic_break(text) {
            // Inside an item it is text, as `tessera_read_page` shows it.
            if continued.is_some() {
                append(&mut self.blocks, &unescape(text));
            } else {
                self.levels.clear();
                self.open = None;
            }
            return Ok(());
        }
        if let Some(content) = item(text) {
            // `item` returns the end of `text`, which ends where `rest` does.
            let start = line.len() - rest.len() + text.len() - content.len();
            let column = column(line, start) + usize::from(content.is_empty());
            return self.push_item(indent, content, column, lines);
        }
        if shorthand_value(text).is_some() {
            // A field line opens a list level, so the values indented under
            // it nest under it.
            self.close(indent);
            self.levels.push(indent);
            let depth = depth(self.headings.len() + self.levels.len() - 1)?;
            push(&mut self.blocks, depth, text_block(unescape(text)));
            self.open = None;
            return Ok(());
        }
        if continued.is_some() {
            append(&mut self.blocks, &unescape(text));
            return Ok(());
        }
        self.close(indent);
        if indent < 4
            && self.levels.is_empty()
            && let Some(level) = lines
                .next_if(|next| setext(next).is_some())
                .and_then(setext)
        {
            return self.push_heading(level, unescape(text));
        }
        self.push_text(indent, unescape(text))
    }

    /// A heading, closing every open heading of its level or deeper. It
    /// nests by the level as written and keeps at most level 3.
    fn push_heading(&mut self, level: usize, title: String) -> anyhow::Result<()> {
        while self.headings.last().is_some_and(|open| *open >= level) {
            self.headings.pop();
        }
        let depth = depth(self.headings.len())?;
        push(
            &mut self.blocks,
            depth,
            NoteBlock {
                heading: Some(level.min(3) as u8),
                ..text_block(title)
            },
        );
        self.headings.push(level);
        self.levels.clear();
        self.open = None;
        Ok(())
    }

    /// A list item whose text starts at `column`. A text that opens a fence
    /// takes the code lines that follow, indented to `column`.
    fn push_item(
        &mut self,
        indent: usize,
        content: &str,
        column: usize,
        lines: &mut Peekable<Lines>,
    ) -> anyhow::Result<()> {
        self.close(indent);
        self.levels.push(indent);
        let depth = depth(self.headings.len() + self.levels.len() - 1)?;
        let (status, rest) = match task(content) {
            Some((status, rest)) => (Some(status), rest),
            None => (None, content),
        };
        let (heading, body) = match item_heading(rest) {
            Some((level, body)) => (Some(level.min(3) as u8), body),
            None => (None, rest),
        };
        let text = match fence(body) {
            Some(fence) => code(body, column, fence, column, lines),
            None => unescape(body),
        };
        push(
            &mut self.blocks,
            depth,
            NoteBlock {
                heading,
                task: status.map(|status| TaskState {
                    status: Some(status),
                    ..TaskState::default()
                }),
                ..text_block(text)
            },
        );
        self.open = Some(column);
        Ok(())
    }

    /// A block of plain text or code under the list levels it is indented
    /// into.
    fn push_text(&mut self, indent: usize, text: String) -> anyhow::Result<()> {
        self.close(indent);
        let depth = depth(self.headings.len() + self.levels.len())?;
        push(&mut self.blocks, depth, text_block(text));
        self.open = None;
        Ok(())
    }

    /// Close the list levels a line at `indent` is not indented into.
    fn close(&mut self, indent: usize) {
        while self.levels.last().is_some_and(|column| *column >= indent) {
            self.levels.pop();
        }
    }
}

fn depth(depth: usize) -> anyhow::Result<usize> {
    anyhow::ensure!(
        depth < MAX_DEPTH,
        "The outline nests more than {MAX_DEPTH} levels deep, more than a note can hold."
    );
    Ok(depth)
}

/// The value of `Name:: value` field shorthand, read as the core and the
/// editor's `matchFieldEntry` read it: a name of 1 to 60 UTF-16 units
/// without `\`, backticks, brackets, `#`, `:` or line breaks that is not
/// itself card syntax.
pub(super) fn shorthand_value(text: &str) -> Option<&str> {
    let (name, value) = text.split_once("::")?;
    if !(1..=60).contains(&name.encode_utf16().count())
        || name.trim().is_empty()
        || name.contains(['\\', '`', '[', ']', '#', ':'])
        || name.contains(BREAKS)
        || value.contains(BREAKS)
    {
        return None;
    }
    let card = parse_card_text(name.trim());
    if !card.cards.is_empty() || !card.problems.is_empty() {
        return None;
    }
    Some(value.strip_prefix(char::is_whitespace).unwrap_or(value))
}

/// The [`text_problems`] of every block in a note. Field shorthand is
/// checked by its value, the block that holds the card.
pub(super) fn note_problems(blocks: &[NoteBlock]) -> Vec<(String, String)> {
    let mut problems = Vec::new();
    for block in blocks {
        problems.extend(text_problems(&block.text));
        problems.extend(note_problems(&block.children));
    }
    problems
}

/// Problems in one block's text, each paired with the text it is about:
/// card syntax that made no card, and field shorthand on one line of a
/// longer block, which stays text since only a whole block is an entry.
pub(super) fn text_problems(text: &str) -> Vec<(String, String)> {
    let fenced = text.trim_start().starts_with(['`', '~']);
    let mut found: Vec<_> = text
        .lines()
        .map(str::trim)
        .filter(|line| text.contains('\n') && !fenced && shorthand_value(line).is_some())
        .map(|line| {
            (
                line.to_owned(),
                "A field entry must be a block of its own, so this line stayed text".to_owned(),
            )
        })
        .collect();
    let text = shorthand_value(text).unwrap_or(text);
    let CardParse { problems, .. } = parse_card_text(text);
    found.extend(
        problems
            .into_iter()
            .map(|problem| (text.to_owned(), problem.message)),
    );
    found
}

fn text_block(text: String) -> NoteBlock {
    NoteBlock {
        text,
        heading: None,
        task: None,
        children: Vec::new(),
    }
}

/// Add a block `depth` levels down the last branch, or as deep as it goes.
fn push(blocks: &mut Vec<NoteBlock>, depth: usize, block: NoteBlock) {
    match blocks.last_mut() {
        Some(last) if depth > 0 => push(&mut last.children, depth - 1, block),
        _ => blocks.push(block),
    }
}

/// Continue the most recently added block on a new line. An empty block
/// takes the line as its text.
fn append(blocks: &mut [NoteBlock], line: &str) {
    let mut last = blocks.last_mut().expect("a continuation follows a block");
    while let Some(child) = last.children.last_mut() {
        last = child;
    }
    if !last.text.is_empty() {
        last.text.push('\n');
    }
    last.text.push_str(line);
}

/// A line's indentation in columns, with tabs to the next multiple of 4,
/// and the rest of the line.
fn indentation(line: &str) -> (usize, &str) {
    let rest = line.trim_start_matches([' ', '\t']);
    (column(line, line.len() - rest.len()), rest)
}

/// The column at byte `end` of a line, with tabs to the next multiple of 4.
fn column(line: &str, end: usize) -> usize {
    line[..end].chars().fold(0, |column, ch| match ch {
        '\t' => column + 4 - column % 4,
        _ => column + 1,
    })
}

/// A line without its first `columns` columns of indentation.
fn dedent(line: &str, columns: usize) -> String {
    let mut column = 0;
    for (at, ch) in line.char_indices() {
        if column >= columns || !matches!(ch, ' ' | '\t') {
            return line[at..].to_owned();
        }
        column += if ch == '\t' { 4 - column % 4 } else { 1 };
        if column > columns {
            // A tab reaching past the cut keeps the columns beyond it.
            return format!("{}{}", " ".repeat(column - columns), &line[at + 1..]);
        }
    }
    String::new()
}

#[derive(Clone, Copy)]
struct Fence {
    mark: char,
    length: usize,
}

/// The fence a line opens: three or more backticks or tildes, where a
/// backtick fence's info string holds no backtick.
fn fence(line: &str) -> Option<Fence> {
    let mark = line.chars().next().filter(|ch| matches!(ch, '`' | '~'))?;
    let length = line.len() - line.trim_start_matches(mark).len();
    (length >= 3 && !(mark == '`' && line[length..].contains('`')))
        .then_some(Fence { mark, length })
}

/// A fenced code block's text: the opening line, then each following line
/// less its first `strip` columns, through a closing fence of the same mark
/// at least as long. Without one it runs to the end of the outline or, in
/// an item whose text starts at column `inside`, to the first line indented
/// less.
fn code(
    first: &str,
    strip: usize,
    fence: Fence,
    inside: usize,
    lines: &mut Peekable<Lines>,
) -> String {
    let mut code = vec![first.replace("--\\>", "-->")];
    let mut closed = false;
    while let Some(line) = lines.next_if(|line| {
        let (indent, rest) = indentation(line);
        rest.trim().is_empty() || indent >= inside
    }) {
        let line = dedent(line, strip);
        let (indent, rest) = indentation(&line);
        closed = indent < 4 && closes(rest, fence);
        code.push(line.replace("--\\>", "-->"));
        if closed {
            break;
        }
    }
    if !closed {
        while code.last().is_some_and(|line| line.trim().is_empty()) {
            code.pop();
        }
    }
    code.join("\n")
}

fn closes(line: &str, fence: Fence) -> bool {
    let rest = line.trim_start_matches(fence.mark);
    line.len() - rest.len() >= fence.length && rest.trim().is_empty()
}

/// `# Title` to `###### Title`: the level as written and the title without
/// a closing run of `#`. `#Tag` without a space is a tag, not a heading.
fn heading(line: &str) -> Option<(usize, &str)> {
    let (level, title) = item_heading(line)?;
    let title = title.trim_end();
    let open = title.trim_end_matches('#');
    if open.is_empty() || open.ends_with([' ', '\t']) {
        return Some((level, open.trim_end()));
    }
    Some((level, title))
}

/// A heading marker at the start of an item's text, `#` to `######` then a
/// space, a tab or nothing: its level and the text after it.
fn item_heading(text: &str) -> Option<(usize, &str)> {
    let rest = text.trim_start_matches('#');
    let level = text.len() - rest.len();
    ((1..=6).contains(&level) && marked(rest)).then(|| (level, rest.trim_start()))
}

/// A setext underline, `===` or `---` under a line of text: its level.
fn setext(line: &str) -> Option<usize> {
    let (indent, rest) = indentation(line);
    let rest = rest.trim_end();
    let mark = rest
        .chars()
        .next()
        .filter(|mark| matches!(mark, '=' | '-'))?;
    (indent < 4 && rest.chars().all(|ch| ch == mark)).then_some(if mark == '=' { 1 } else { 2 })
}

/// A task marker at the start of an item's text: its status and the text
/// after it. A marker alone is an empty task.
fn task(text: &str) -> Option<(TaskStatus, &str)> {
    TASKS.iter().find_map(|(marker, status)| {
        let rest = text.strip_prefix(marker).filter(|rest| marked(rest))?;
        Some((*status, rest.trim_start()))
    })
}

/// The text after a `-`, `*`, `+`, `1.` or `1)` list marker.
fn item(line: &str) -> Option<&str> {
    let rest = ordered(line).or_else(|| line.strip_prefix(['-', '*', '+']))?;
    marked(rest).then(|| rest.trim_start())
}

/// The text after the 1 to 9 digits and `.` or `)` of an ordered marker.
fn ordered(line: &str) -> Option<&str> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    (1..=9)
        .contains(&digits)
        .then(|| line[digits..].strip_prefix(['.', ')']))
        .flatten()
}

/// Whether the text after a marker leaves it a marker: empty, or starting
/// with a space or a tab.
fn marked(rest: &str) -> bool {
    rest.is_empty() || rest.starts_with([' ', '\t'])
}

fn thematic_break(line: &str) -> bool {
    let mut marks = line.chars().filter(|ch| !matches!(ch, ' ' | '\t'));
    let Some(mark) = marks.next().filter(|mark| matches!(mark, '-' | '*' | '_')) else {
        return false;
    };
    let mut count = 1;
    for ch in marks {
        if ch != mark {
            return false;
        }
        count += 1;
    }
    count >= 3
}

/// A line of block text as written, from where its indentation ends: the
/// backslash `tessera_read_page` puts before a line that would otherwise
/// read back as structure is dropped, and `--\>` is `-->` again.
fn unescape(line: &str) -> String {
    let line = line
        .strip_prefix('\\')
        .filter(|rest| escaped(rest))
        .unwrap_or(line);
    line.replace("--\\>", "-->")
}

/// Whether `tessera_read_page` escapes a line that starts this way: a
/// backslash, a heading marker, `>`, a fence, a list or task marker, a run
/// of `-`, `*` or `_` that reads as a thematic break, or text that reads as
/// field shorthand. `\#Tag` keeps its backslash.
fn escaped(line: &str) -> bool {
    const MARKS: [char; 3] = ['-', '*', '_'];
    line.starts_with(['\\', '>'])
        || item_heading(line).is_some()
        || line.starts_with("```")
        || line.starts_with("~~~")
        || line.strip_prefix(['-', '*', '+']).is_some_and(marked)
        || ordered(line).is_some_and(marked)
        || TASKS
            .iter()
            .any(|(marker, _)| line.strip_prefix(marker).is_some_and(marked))
        || (line
            .chars()
            .all(|ch| MARKS.contains(&ch) || matches!(ch, ' ' | '\t'))
            && line.chars().filter(|ch| MARKS.contains(ch)).count() >= 2)
        || line.split_once("::").is_some_and(|(name, _)| {
            !name.trim().is_empty() && !name.contains(['\\', '`', '[', ']', '#', ':'])
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(markdown: &str) -> Vec<NoteBlock> {
        outline(markdown).unwrap()
    }

    fn shape(blocks: &[NoteBlock]) -> Vec<String> {
        fn walk(blocks: &[NoteBlock], depth: usize, out: &mut Vec<String>) {
            for block in blocks {
                let heading = block.heading.map(|h| format!("h{h} ")).unwrap_or_default();
                let task = match block.task.as_ref().and_then(|task| task.status) {
                    Some(status) => format!("[{status:?}] "),
                    None => String::new(),
                };
                out.push(format!(
                    "{}{task}{heading}{}",
                    "  ".repeat(depth),
                    block.text
                ));
                walk(&block.children, depth + 1, out);
            }
        }
        let mut out = Vec::new();
        walk(blocks, 0, &mut out);
        out
    }

    #[test]
    fn headings_contain_following_content_until_a_peer_heading() {
        let blocks = parse(
            "# Book\nIntro line\n## Part one\n- a\n  - a1\n- b\n## Part two\n- c\n# Next\nend",
        );
        assert_eq!(
            shape(&blocks),
            [
                "h1 Book",
                "  Intro line",
                "  h2 Part one",
                "    a",
                "      a1",
                "    b",
                "  h2 Part two",
                "    c",
                "h1 Next",
                "  end",
            ]
        );
    }

    #[test]
    fn deeper_headings_nest_by_their_written_level_and_keep_level_three() {
        let blocks = parse("### Part\n#### Chapter\ntext\n###### Note\n### Next");
        assert_eq!(
            shape(&blocks),
            [
                "h3 Part",
                "  h3 Chapter",
                "    text",
                "    h3 Note",
                "h3 Next"
            ]
        );
    }

    #[test]
    fn items_nest_by_indentation_and_dedent_to_the_matching_level() {
        let blocks = parse("1. one\n   * deep\n      + deeper\n2. two\n\t- tabbed\n- three");
        assert_eq!(
            shape(&blocks),
            ["one", "  deep", "    deeper", "two", "  tabbed", "three"]
        );
    }

    #[test]
    fn tabs_indent_to_the_next_multiple_of_four() {
        let blocks =
            parse("- a\n\tcontinued with tab\n- one\n\t- two\n\t\t- three\n    - four\n  \t- five");
        assert_eq!(
            shape(&blocks),
            [
                "a\ncontinued with tab",
                "one",
                "  two",
                "    three",
                "  four",
                "  five"
            ]
        );
    }

    #[test]
    fn indented_lines_continue_an_item_and_every_other_line_is_a_block() {
        let blocks = parse("- item\n  more\n\n  after blank\nfirst\nsecond\n\nthird");
        assert_eq!(
            shape(&blocks),
            ["item\nmore\nafter blank", "first", "second", "third"]
        );
    }

    #[test]
    fn card_lines_under_a_heading_stay_separate_blocks() {
        let blocks = parse(
            "## Review\nWhat is 2 + 2? >> 4\nThe capital of France is {{c1::Paris}}.\n\
             What is 3 + 3? >> 6\n",
        );
        assert_eq!(
            shape(&blocks),
            [
                "h2 Review",
                "  What is 2 + 2? >> 4",
                "  The capital of France is {{c1::Paris}}.",
                "  What is 3 + 3? >> 6",
            ]
        );
        assert!(note_problems(&blocks).is_empty());
    }

    #[test]
    fn field_lines_are_blocks_of_their_own() {
        let blocks = parse(
            "Thomas Aquinas, ST I q.2 a.3\nSource:: Leonine text\nmore prose\n\n\
             - Latin segment\n  Language:: la\n  Source:: Leonine\n  a note\n- next",
        );
        assert_eq!(
            shape(&blocks),
            [
                "Thomas Aquinas, ST I q.2 a.3",
                "Source:: Leonine text",
                "more prose",
                "Latin segment",
                "  Language:: la",
                "  Source:: Leonine",
                "  a note",
                "next",
            ]
        );
    }

    #[test]
    fn a_field_line_takes_what_is_indented_under_it_as_its_values() {
        let blocks = parse(
            "author::\n  - [[Ada Lovelace]]\n  - Luigi Menabrea\n- Item\n  Colours::\n    \
             - red\n    - green\n  more\nGloss:: x\n  plain value",
        );
        assert_eq!(
            shape(&blocks),
            [
                "author::",
                "  [[Ada Lovelace]]",
                "  Luigi Menabrea",
                "Item",
                "  Colours::",
                "    red",
                "    green",
                "  more",
                "Gloss:: x",
                "  plain value",
            ]
        );
    }

    #[test]
    fn tags_are_not_headings_and_fences_stay_whole() {
        let blocks =
            parse("#Idea worth keeping\n```rust\n- not an item\n\n# nor a heading\n```\n---\n- x");
        assert_eq!(
            shape(&blocks),
            [
                "#Idea worth keeping",
                "```rust\n- not an item\n\n# nor a heading\n```",
                "x",
            ]
        );
    }

    #[test]
    fn a_fence_closes_only_on_its_own_mark_at_least_as_long() {
        let blocks = parse(
            "```js``` is how…\n- item one\n- item two\n# Heading\nlast\n\
             ````\n```\n~~~\n````\n~~~ js `x`\ncode\n~~~",
        );
        assert_eq!(
            shape(&blocks),
            [
                "```js``` is how…",
                "item one",
                "item two",
                "h1 Heading",
                "  last",
                "  ````\n```\n~~~\n````",
                "  ~~~ js `x`\ncode\n~~~",
            ]
        );
    }

    #[test]
    fn a_heading_or_a_fence_as_item_text_reads_back_as_a_heading_or_code() {
        let blocks = parse(
            "- ## Part\n  - ```js\n    let x = 1;\n\n    - not an item\n    Key:: not a field\n    \
             ```\n  - [ ] ### Plan\n  - #### Deep\n- ```\n  unclosed\n\n- next\n- item\n  ```\n  \
             - in code\n  ```\n  after",
        );
        assert_eq!(
            shape(&blocks),
            [
                "h2 Part",
                "  ```js\nlet x = 1;\n\n- not an item\nKey:: not a field\n```",
                "  [Todo] h3 Plan",
                "  h3 Deep",
                "```\nunclosed",
                "next",
                "item\n```\n- in code\n```\nafter",
            ]
        );
        assert!(note_problems(&blocks).is_empty());
    }

    #[test]
    fn every_status_marker_read_page_writes_reads_back_as_that_status() {
        let blocks = parse(
            "- [ ] a\n- [x] b\n- [doing] c\n- [waiting] d\n- [cancelled] e\n- [later] f\n- [X]\tg",
        );
        let statuses: Vec<_> = blocks
            .iter()
            .map(|block| {
                (
                    block.text.as_str(),
                    block.task.as_ref().and_then(|t| t.status),
                )
            })
            .collect();
        assert_eq!(
            statuses,
            [
                ("a", Some(TaskStatus::Todo)),
                ("b", Some(TaskStatus::Done)),
                ("c", Some(TaskStatus::Doing)),
                ("d", Some(TaskStatus::Waiting)),
                ("e", Some(TaskStatus::Cancelled)),
                ("[later] f", None),
                ("g", Some(TaskStatus::Done)),
            ]
        );
    }

    #[test]
    fn bare_markers_and_empty_items_take_the_text_that_continues_them() {
        let blocks = parse("- [ ]\n- [x]\n- \n  text under empty\n-\n- [ ]\n  later");
        assert_eq!(
            shape(&blocks),
            ["[Todo] ", "[Done] ", "text under empty", "", "[Todo] later"]
        );
    }

    #[test]
    fn closing_hashes_setext_underlines_and_a_byte_order_mark_follow_commonmark() {
        let blocks = parse(
            "\u{feff}# Título\n## Closing ##\n# C#\n### x #not closing\nTitle\n===\nbody\n\
             Sub\n---\nmore\n- item\n---\n- next",
        );
        assert_eq!(
            shape(&blocks),
            [
                "h1 Título",
                "  h2 Closing",
                "h1 C#",
                "  h3 x #not closing",
                "h1 Title",
                "  body",
                "  h2 Sub",
                "    more",
                "    item",
                "    next",
            ]
        );
    }

    #[test]
    fn an_outline_nested_too_deep_is_refused_with_its_limit() {
        let nested = |levels: usize| {
            (0..levels)
                .map(|level| format!("{}- {level}", "  ".repeat(level)))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(parse(&nested(MAX_DEPTH)).len(), 1);
        let error = outline(&nested(MAX_DEPTH + 1)).unwrap_err();
        assert_eq!(
            error.to_string(),
            "The outline nests more than 50 levels deep, more than a note can hold."
        );
        assert!(outline(&nested(1_000)).is_err());
    }

    #[test]
    fn escapes_read_page_writes_read_back_as_the_text_they_stand_for() {
        let blocks = parse(
            "- \\# not a heading\n\
             - \\[ ] not a task\n\
             - [ ] \\[x] a task whose text starts like one\n\
             - ## \\## heading text with hashes\n\
             - first line\n  \\- not a child\n  \\1. not a list\n  \\> not a quote\n  \
             \\``` not a fence\n  \\---\n  \\Key:: not a field\n  \\\\ one backslash\n  \
             a comment --\\> closer\n  ---\n\
             - \\---\n\
             - \\--\n\
             - \\frac{1}{2}\n\
             - \\#tag keeps its backslash\n\
             \\# a line of text",
        );
        assert_eq!(
            shape(&blocks),
            [
                "# not a heading",
                "[ ] not a task",
                "[Todo] [x] a task whose text starts like one",
                "h2 ## heading text with hashes",
                "first line\n- not a child\n1. not a list\n> not a quote\n``` not a fence\n\
                 ---\nKey:: not a field\n\\ one backslash\na comment --> closer\n---",
                "---",
                "--",
                "\\frac{1}{2}",
                "\\#tag keeps its backslash",
                "# a line of text",
            ]
        );
        assert_eq!(
            block_text("\\# one\n  \\- two --\\> three\n\\frac"),
            "# one\n  - two --> three\n\\frac"
        );
        assert_eq!(
            block_text("```\n\\# kept --\\> x\n```"),
            "```\n\\# kept --> x\n```"
        );
    }

    #[test]
    fn what_read_page_shows_reads_back_as_the_same_blocks() {
        use std::collections::HashMap;
        use tessera_core::{Actor, Batch, Notebook, Operation};
        use tessera_service::agent_render::{Clock, Fields, PageContext, render};

        // Text, heading and depth, in outline order.
        let rows: [(&str, Option<u8>, usize); 14] = [
            ("Cabinets and worktop", Some(2), 0),
            ("Deeper", Some(3), 1),
            ("# not a heading", None, 2),
            ("[ ] not a task", None, 1),
            ("#tag start", Some(1), 1),
            (
                "Line one\n- Fake child\n# Fake heading -->\n<!-- open comment",
                None,
                0,
            ),
            (
                "```js\nlet x = 1;\n\n- not item\nKey:: value inside code\n```",
                None,
                1,
            ),
            ("a --> b and \\frac{1}{2}", None, 0),
            ("---", None, 0),
            ("--", None, 0),
            (
                "Thomas Aquinas\nSource:: Leonine\n***\n1) one\n+ two",
                None,
                0,
            ),
            ("\\ starts with a backslash", None, 0),
            ("> quoted\n~~~ not code\n```", None, 1),
            ("[x] looks done", None, 0),
        ];
        let dir = tempfile::tempdir().unwrap();
        let mut nb = Notebook::open(dir.path()).unwrap();
        let id = |n: usize| format!("{n:026}");
        let root = id(100);
        let mut operations = vec![Operation::CreatePage {
            id: root.clone(),
            title: "Round trip".into(),
        }];
        let mut parents = vec![root.clone()];
        let mut last: HashMap<String, String> = HashMap::new();
        for (n, (text, heading, depth)) in rows.iter().enumerate() {
            parents.truncate(depth + 1);
            let parent = parents[*depth].clone();
            operations.push(Operation::Insert {
                id: id(n + 1),
                parent_id: parent.clone(),
                after: last.get(&parent).cloned(),
                text: (*text).into(),
                heading: *heading,
            });
            last.insert(parent, id(n + 1));
            parents.push(id(n + 1));
        }
        operations.push(Operation::SetTask {
            id: id(rows.len()),
            base_revision: 1,
            task: Some(TaskState {
                status: Some(TaskStatus::Todo),
                ..TaskState::default()
            }),
        });
        nb.apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations,
        })
        .unwrap();
        let fields = Fields::default();
        let clock = Clock::new(&nb.settings_view(0).unwrap()).unwrap();
        let context = PageContext {
            fields: &fields,
            cards: &[],
            clock: &clock,
        };
        let rendered = render(&nb.page(&root).unwrap(), &context, None).unwrap();
        // What an agent sends back: the rows without the header and comments.
        let markdown: Vec<_> = rendered
            .lines()
            .skip(1)
            .map(|line| match line.rfind(" <!-- ") {
                Some(at) if line.ends_with("-->") => &line[..at],
                _ => line,
            })
            .collect();
        let expected: Vec<_> = rows
            .iter()
            .enumerate()
            .map(|(n, (text, heading, depth))| {
                let task = if n + 1 == rows.len() { "[Todo] " } else { "" };
                let heading = heading.map(|h| format!("h{h} ")).unwrap_or_default();
                format!("{}{task}{heading}{text}", "  ".repeat(*depth))
            })
            .collect();
        assert_eq!(shape(&parse(&markdown.join("\n"))), expected, "{rendered}");
    }

    #[test]
    fn a_choice_value_read_page_shows_by_name_reads_back_as_its_option() {
        use tessera_core::{Actor, AgentEdit, AgentRequest, NoteTarget, Notebook};
        use tessera_service::agent_render::{Clock, Fields, PageContext, render};

        fn add(nb: &mut Notebook, title: &str, markdown: &str) -> String {
            nb.agent_edit(&AgentRequest {
                actor: Actor::Agent {
                    name: "test".into(),
                },
                reason: None,
                edit: AgentEdit::AddNote {
                    target: NoteTarget::Page {
                        title: title.into(),
                    },
                    blocks: parse(markdown),
                },
            })
            .unwrap()
            .page
            .unwrap()
            .id
        }
        let dir = tempfile::tempdir().unwrap();
        let mut nb = Notebook::open(dir.path()).unwrap();
        let original = add(&mut nb, "Attention", "- gloss:: A paper.\n- form:: paper");
        let fields = Fields::from(nb.fields().unwrap());
        let clock = Clock::new(&nb.settings_view(0).unwrap()).unwrap();
        let context = PageContext {
            fields: &fields,
            cards: &[],
            clock: &clock,
        };
        let rendered = render(&nb.page(&original).unwrap(), &context, None).unwrap();
        let markdown: Vec<_> = rendered
            .lines()
            .skip(1)
            .map(|line| &line[..line.rfind(" <!-- ").unwrap()])
            .collect();
        assert_eq!(
            markdown,
            ["- gloss::", "  - A paper.", "- form::", "  - [[paper]]"],
            "{rendered}"
        );
        let copy = add(&mut nb, "Copy", &markdown.join("\n"));
        let texts = |page: &str| -> Vec<String> {
            nb.page(page)
                .unwrap()
                .rows
                .into_iter()
                .map(|row| row.block.text)
                .collect()
        };
        assert_eq!(texts(&copy), texts(&original));
        assert!(nb.page_by_title("paper").unwrap().is_none());
    }

    #[test]
    fn field_shorthand_follows_the_editor_rule() {
        assert_eq!(
            shorthand_value("Author:: George Eliot"),
            Some("George Eliot")
        );
        assert_eq!(shorthand_value("Author::"), Some(""));
        assert_eq!(shorthand_value("Q >> A:: x"), None);
        assert_eq!(shorthand_value("{{c1::answer}}"), None);
        assert_eq!(shorthand_value("[[Page]]:: x"), None);
        assert_eq!(shorthand_value("Name:: one\ntwo"), None);
        assert_eq!(shorthand_value("Name:: one\u{2028}two"), None);
        assert_eq!(shorthand_value(&format!("{}:: x", "n".repeat(61))), None);
        // The name is counted in UTF-16 units, as the core counts it.
        assert_eq!(
            shorthand_value(&format!("{}:: v", "😀".repeat(30))),
            Some("v")
        );
        assert_eq!(shorthand_value(&format!("{}:: v", "😀".repeat(31))), None);
    }

    #[test]
    fn note_problems_name_the_block_and_check_a_field_value_alone() {
        let blocks =
            parse("- Kepler >> \n  - The {{c1::Peace\n- Term:: front >> back\n- ok >> fine");
        let problems = note_problems(&blocks);
        assert_eq!(
            problems,
            [
                (
                    "Kepler >>".to_owned(),
                    "Both sides of a card need text.".to_owned()
                ),
                (
                    "The {{c1::Peace".to_owned(),
                    "Close the cloze with }}.".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn a_field_line_inside_a_longer_block_is_reported_and_fenced_code_is_not() {
        assert_eq!(
            text_problems("Thomas Aquinas\nSource:: Leonine"),
            [(
                "Source:: Leonine".to_owned(),
                "A field entry must be a block of its own, so this line stayed text".to_owned()
            )]
        );
        assert!(text_problems("```\nkey:: value\n```").is_empty());
        assert!(text_problems("Source:: Leonine").is_empty());
    }
}
