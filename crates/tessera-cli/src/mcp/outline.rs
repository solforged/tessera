//! Markdown outlines from agents, parsed into note blocks.

use tessera_core::card_text::{CardParse, parse_card_text};
use tessera_core::{NoteBlock, TaskState, TaskStatus};

/// Parse a Markdown outline into note blocks. Headings contain what follows
/// them until a heading of the same or a higher level; list items nest by
/// indentation; a fenced code block stays one block.
pub(super) fn outline(markdown: &str) -> Vec<NoteBlock> {
    let mut blocks = Vec::new();
    // Open heading levels, outermost first.
    let mut headings: Vec<u8> = Vec::new();
    // Marker columns of the open list items, outermost first.
    let mut items: Vec<usize> = Vec::new();
    // Whether the last block can take a continuation line: an item (with
    // its content column) or a paragraph not yet ended by a blank line.
    let mut open: Option<Continuation> = None;
    let mut lines = markdown.lines();
    while let Some(line) = lines.next() {
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if open == Some(Continuation::Paragraph) {
                open = None;
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let fence = &trimmed[..3];
            let mut code = vec![trimmed.to_owned()];
            for line in lines.by_ref() {
                code.push(line.get(indent..).unwrap_or(line.trim_start()).to_owned());
                if line.trim().starts_with(fence) {
                    break;
                }
            }
            let code = code.join("\n");
            match open {
                Some(Continuation::Item(column)) if indent >= column => {
                    append(&mut blocks, &code);
                }
                _ => {
                    items.clear();
                    push(&mut blocks, headings.len(), text_block(code));
                    open = None;
                }
            }
            continue;
        }
        if let Some((level, title)) = heading(trimmed).filter(|_| indent < 4) {
            while headings.last().is_some_and(|open| *open >= level) {
                headings.pop();
            }
            push(
                &mut blocks,
                headings.len(),
                NoteBlock {
                    text: title.to_owned(),
                    heading: Some(level),
                    task: None,
                    children: Vec::new(),
                },
            );
            headings.push(level);
            items.clear();
            open = None;
            continue;
        }
        if thematic_break(trimmed) {
            open = None;
            continue;
        }
        if let Some(content) = item(trimmed) {
            while items.last().is_some_and(|column| *column > indent) {
                items.pop();
            }
            if items.last() != Some(&indent) {
                items.push(indent);
            }
            push(
                &mut blocks,
                headings.len() + items.len() - 1,
                item_block(content),
            );
            open = Some(Continuation::Item(indent + (trimmed.len() - content.len())));
            continue;
        }
        if shorthand_value(trimmed).is_some() {
            // A field entry is a block of its own: a child of the item whose
            // text it continues, else a sibling of the paragraph before it.
            match open {
                Some(Continuation::Item(column) | Continuation::Fields(column))
                    if indent >= column =>
                {
                    push(
                        &mut blocks,
                        headings.len() + items.len(),
                        text_block(trimmed.to_owned()),
                    );
                    open = Some(Continuation::Fields(column));
                }
                _ => {
                    items.clear();
                    push(&mut blocks, headings.len(), text_block(trimmed.to_owned()));
                    open = None;
                }
            }
            continue;
        }
        match open {
            Some(Continuation::Item(column)) if indent >= column => append(&mut blocks, trimmed),
            // Text after an item's fields is a further child, not field text.
            Some(Continuation::Fields(column)) if indent >= column => push(
                &mut blocks,
                headings.len() + items.len(),
                text_block(trimmed.to_owned()),
            ),
            Some(Continuation::Paragraph) => append(&mut blocks, trimmed),
            _ => {
                items.clear();
                push(&mut blocks, headings.len(), text_block(trimmed.to_owned()));
                open = Some(Continuation::Paragraph);
            }
        }
    }
    blocks
}

/// The value of `Name:: value` field shorthand, read as the editor's
/// `matchFieldEntry` reads it: a name of up to 60 characters without
/// `\`, backticks, brackets, `#` or `:` that is not itself card syntax.
pub(super) fn shorthand_value(text: &str) -> Option<&str> {
    let at = text.find("::")?;
    let name = &text[..at];
    let card = parse_card_text(name.trim());
    if text.contains('\n')
        || name.trim().is_empty()
        || name.chars().count() > 60
        || name.contains(['\\', '`', '[', ']', '#', ':'])
        || !card.cards.is_empty()
        || !card.problems.is_empty()
    {
        return None;
    }
    let value = &text[at + 2..];
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Continuation {
    /// A list item whose text starts at this column.
    Item(usize),
    /// A list item, starting at this column, that field lines have ended.
    Fields(usize),
    Paragraph,
}

fn text_block(text: String) -> NoteBlock {
    NoteBlock {
        text,
        heading: None,
        task: None,
        children: Vec::new(),
    }
}

/// A list item's block. A leading `[ ]`, `[x]`, `[doing]`, `[waiting]` or
/// `[cancelled]` makes it a task, the markers `tessera_read_page` writes.
fn item_block(content: &str) -> NoteBlock {
    const MARKERS: [(&str, TaskStatus); 6] = [
        ("[ ] ", TaskStatus::Todo),
        ("[x] ", TaskStatus::Done),
        ("[X] ", TaskStatus::Done),
        ("[doing] ", TaskStatus::Doing),
        ("[waiting] ", TaskStatus::Waiting),
        ("[cancelled] ", TaskStatus::Cancelled),
    ];
    let (status, text) = MARKERS
        .iter()
        .find_map(|(marker, status)| Some((Some(*status), content.strip_prefix(marker)?)))
        .unwrap_or((None, content));
    NoteBlock {
        task: status.map(|status| TaskState {
            status: Some(status),
            ..TaskState::default()
        }),
        ..text_block(text.trim_start().to_owned())
    }
}

/// Add a block `depth` levels down the last branch, or as deep as it goes.
fn push(blocks: &mut Vec<NoteBlock>, depth: usize, block: NoteBlock) {
    match blocks.last_mut() {
        Some(last) if depth > 0 => push(&mut last.children, depth - 1, block),
        _ => blocks.push(block),
    }
}

/// Continue the most recently added block on a new line.
fn append(blocks: &mut [NoteBlock], line: &str) {
    let mut last = blocks.last_mut().expect("a continuation follows a block");
    while let Some(child) = last.children.last_mut() {
        last = child;
    }
    last.text.push('\n');
    last.text.push_str(line);
}

/// `# Title` to `###### Title`, with deeper levels shown as level 3. `#Tag`
/// without a space is a tag, not a heading.
fn heading(line: &str) -> Option<(u8, &str)> {
    let level = line.bytes().take_while(|byte| *byte == b'#').count();
    let title = line[level..].strip_prefix([' ', '\t'])?.trim();
    ((1..=6).contains(&level) && !title.is_empty()).then(|| (level.min(3) as u8, title))
}

/// The text after a `-`, `*`, `+`, `1.` or `1)` list marker.
fn item(line: &str) -> Option<&str> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    let rest = if digits > 0 && digits < 10 {
        line[digits..].strip_prefix(['.', ')'])?
    } else {
        line.strip_prefix(['-', '*', '+'])?
    };
    if rest.is_empty() {
        return Some(rest);
    }
    rest.strip_prefix([' ', '\t']).map(str::trim_start)
}

fn thematic_break(line: &str) -> bool {
    let compact: String = line.chars().filter(|ch| !ch.is_whitespace()).collect();
    compact.len() >= 3
        && ["-", "*", "_"]
            .iter()
            .any(|mark| compact.chars().all(|ch| ch.to_string() == *mark))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(blocks: &[NoteBlock]) -> Vec<String> {
        fn walk(blocks: &[NoteBlock], depth: usize, out: &mut Vec<String>) {
            for block in blocks {
                let heading = block.heading.map(|h| format!("h{h} ")).unwrap_or_default();
                out.push(format!("{}{heading}{}", "  ".repeat(depth), block.text));
                walk(&block.children, depth + 1, out);
            }
        }
        let mut out = Vec::new();
        walk(blocks, 0, &mut out);
        out
    }

    #[test]
    fn headings_contain_following_content_until_a_peer_heading() {
        let blocks = outline(
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
    fn items_nest_by_indentation_and_dedent_to_the_matching_level() {
        let blocks = outline("1. one\n   * deep\n      + deeper\n2. two\n\t- tabbed\n- three");
        assert_eq!(
            shape(&blocks),
            ["one", "  deep", "    deeper", "two", "  tabbed", "three"]
        );
    }

    #[test]
    fn indented_lines_continue_an_item_and_paragraph_lines_join_until_a_blank() {
        let blocks = outline("- item\n  more\n\n  after blank\nfirst\nsecond\n\nthird");
        assert_eq!(
            shape(&blocks),
            ["item\nmore\nafter blank", "first\nsecond", "third"]
        );
    }

    #[test]
    fn field_lines_are_blocks_of_their_own() {
        let blocks = outline(
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
    fn tags_are_not_headings_and_fences_stay_whole() {
        let blocks = outline(
            "#Idea worth keeping\n```rust\n- not an item\n\n# nor a heading\n```\n---\n- x",
        );
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
    fn every_status_marker_read_page_writes_reads_back_as_that_status() {
        let blocks =
            outline("- [ ] a\n- [x] b\n- [doing] c\n- [waiting] d\n- [cancelled] e\n- [later] f");
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
            ]
        );
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
        assert_eq!(shorthand_value(&format!("{}:: x", "n".repeat(61))), None);
    }

    #[test]
    fn note_problems_name_the_block_and_check_a_field_value_alone() {
        let blocks =
            outline("- Kepler >> \n  - The {{c1::Peace\n- Term:: front >> back\n- ok >> fine");
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
