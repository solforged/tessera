//! Card definitions derived from one canonical block, with wording-independent keys.

use std::borrow::Cow;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardKind {
    Forward,
    Reverse,
    Cloze,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedCard {
    pub key: String,
    pub kind: CardKind,
    pub front: String,
    pub back: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardProblem {
    pub message: String,
    /// UTF-8 byte offsets into the authored block; end is exclusive.
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardParse {
    pub cards: Vec<ParsedCard>,
    pub problems: Vec<CardProblem>,
}

struct Cloze<'a> {
    start: usize,
    end: usize,
    id: &'a str,
    answer_start: usize,
    answer_end: usize,
    hint_start: Option<usize>,
}

fn problem(message: &str, start: usize, end: usize) -> CardProblem {
    CardProblem {
        message: message.to_owned(),
        start,
        end,
    }
}

fn operator(text: &str, at: usize) -> bool {
    text[at..].starts_with(">>") || text[at..].starts_with("<<") || text[at..].starts_with("<>")
}

// Escape complete syntax tokens, not just their first character. Paired slashes
// consume each other, so an even number does not escape the following syntax.
fn escape_end(text: &str, at: usize) -> Option<usize> {
    if text.as_bytes()[at] != b'\\' {
        return None;
    }
    let rest = &text[at + 1..];
    if [">>", "<<", "<>", "{{", "}}", "::", "[[", "]]"]
        .iter()
        .any(|&token| rest.starts_with(token))
    {
        return Some(at + 3);
    }
    if rest
        .as_bytes()
        .first()
        .is_some_and(|ch| b"\\`~[]{}<>:".contains(ch))
    {
        return Some(at + 2);
    }
    None
}

fn run_end(text: &str, at: usize, marker: u8) -> usize {
    let mut end = at;
    while text.as_bytes().get(end) == Some(&marker) {
        end += 1;
    }
    end
}

fn line_prefix(text: &str, at: usize) -> bool {
    for (offset, &ch) in text.as_bytes()[..at].iter().rev().take(4).enumerate() {
        if ch == b'\n' {
            return true;
        }
        if ch != b' ' || offset == 3 {
            return false;
        }
    }
    true
}

// Unclosed code and references shield the remainder while the author is typing.
// Their markup and backslashes are kept verbatim in the resulting card text.
fn protected_end(text: &str, at: usize) -> Option<usize> {
    if text[at..].starts_with("[[") {
        let mut cursor = at + 2;
        while cursor < text.len() {
            if let Some(end) = escape_end(text, cursor) {
                cursor = end;
            } else if text[cursor..].starts_with("]]") {
                return Some(cursor + 2);
            } else {
                cursor += text[cursor..].chars().next().expect("in bounds").len_utf8();
            }
        }
        return Some(text.len());
    }
    let marker = text.as_bytes()[at];
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let fence_start = line_prefix(text, at);
    if marker == b'~' && !fence_start {
        return None;
    }
    let opening_end = run_end(text, at, marker);
    let count = opening_end - at;
    let opening_line_end = (count >= 3 && fence_start).then(|| {
        text[opening_end..]
            .find('\n')
            .map_or(text.len(), |index| opening_end + index)
    });
    // Backtick fence info cannot contain backticks; a same-line triple-backtick
    // span is inline code, and syntax following its closer stays active.
    if let Some(end) =
        opening_line_end.filter(|&end| marker == b'~' || !text[opening_end..end].contains('`'))
    {
        let mut line = end.saturating_add(1).min(text.len());
        while line < text.len() {
            let end = text[line..]
                .find('\n')
                .map_or(text.len(), |index| line + index);
            let mut first = line;
            while first < end && first - line < 3 && text.as_bytes()[first] == b' ' {
                first += 1;
            }
            let closing_end = run_end(text, first, marker);
            if closing_end - first >= count
                && text.as_bytes()[closing_end..end]
                    .iter()
                    .all(|ch| matches!(ch, b' ' | b'\t' | b'\r'))
            {
                return Some(end);
            }
            line = end.saturating_add(1);
        }
        return Some(text.len());
    }
    if marker == b'~' {
        return None;
    }
    let mut cursor = opening_end;
    while let Some(next) = text[cursor..].find('`') {
        let start = cursor + next;
        cursor = run_end(text, start, b'`');
        if cursor - start == count {
            return Some(cursor);
        }
    }
    Some(text.len())
}

// Use the same Unicode White_Space set in Rust and JavaScript (unlike JS trim).
fn trim(text: &str) -> &str {
    text.trim_matches(char::is_whitespace)
}

fn trim_owned(mut text: String) -> String {
    let start = text.len() - text.trim_start_matches(char::is_whitespace).len();
    let length = trim(&text[start..]).len();
    text.truncate(start + length);
    drop(text.drain(..start));
    text
}

fn literal(text: &str, start: usize, end: usize) -> Cow<'_, str> {
    let mut output: Option<String> = None;
    let mut copied = start;
    let mut cursor = start;
    while cursor < end {
        if let Some(escaped) = escape_end(text, cursor) {
            let output = output.get_or_insert_with(|| String::with_capacity(end - start));
            output.push_str(&text[copied..cursor]);
            output.push_str(&text[cursor + 1..escaped]);
            copied = escaped;
            cursor = escaped;
        } else if let Some(protected) = protected_end(text, cursor) {
            cursor = protected;
        } else {
            cursor += text[cursor..].chars().next().expect("in bounds").len_utf8();
        }
    }
    match output {
        Some(mut output) => {
            output.push_str(&text[copied..end]);
            Cow::Owned(output)
        }
        None => Cow::Borrowed(&text[start..end]),
    }
}

fn cloze(text: &str, start: usize) -> (usize, Result<Cloze<'_>, CardProblem>) {
    let mut cursor = start + 2;
    let mut depth = 1_usize;
    let mut nested = false;
    let mut first_separator = None;
    let mut second_separator = None;
    let mut extra_separator = false;
    while cursor < text.len() {
        if let Some(end) = escape_end(text, cursor).or_else(|| protected_end(text, cursor)) {
            cursor = end;
        } else if text[cursor..].starts_with("{{") {
            nested = true;
            depth += 1;
            cursor += 2;
        } else if text[cursor..].starts_with("}}") {
            depth -= 1;
            if depth != 0 {
                cursor += 2;
                continue;
            }
            let end = cursor + 2;
            let invalid = |message| (end, Err(problem(message, start, end)));
            if nested {
                return invalid("Clozes cannot be nested.");
            }
            let Some(separator) = first_separator else {
                return invalid("Use {{c1::answer}} for a cloze.");
            };
            let header = &text[start + 2..separator];
            let Some(digits) = header.strip_prefix('c') else {
                return invalid("Cloze IDs must be positive numbers.");
            };
            let id = digits.trim_start_matches('0');
            if id.is_empty() || !digits.bytes().all(|ch| ch.is_ascii_digit()) {
                return invalid("Cloze IDs must be positive numbers.");
            }
            if extra_separator {
                return invalid("A cloze can have only one hint.");
            }
            let answer_start = separator + 2;
            let answer_end = second_separator.unwrap_or(cursor);
            let hint_start = second_separator.map(|separator| separator + 2);
            if trim(&text[answer_start..answer_end]).is_empty() {
                return invalid("Cloze answers cannot be empty.");
            }
            if hint_start.is_some_and(|hint| trim(&text[hint..cursor]).is_empty()) {
                return invalid("Cloze hints cannot be empty.");
            }
            return (
                end,
                Ok(Cloze {
                    start,
                    end,
                    id,
                    answer_start,
                    answer_end,
                    hint_start,
                }),
            );
        } else if depth == 1 && text[cursor..].starts_with("::") {
            if first_separator.is_none() {
                first_separator = Some(cursor);
            } else if second_separator.is_none() {
                second_separator = Some(cursor);
            } else {
                extra_separator = true;
            }
            cursor += 2;
        } else {
            cursor += text[cursor..].chars().next().expect("in bounds").len_utf8();
        }
    }
    (
        text.len(),
        Err(problem("Close the cloze with }}.", start, text.len())),
    )
}

/// Invalid explicit syntax yields diagnostics and no cards, never a guessed or
/// partially valid set. Keys depend only on direction or the authored cloze ID.
pub fn parse_card_text(text: &str) -> CardParse {
    let mut result = CardParse::default();
    let mut operators: Option<(usize, usize)> = None;
    let mut clozes = Vec::new();
    let mut first_cloze = None;
    let mut cursor = 0;
    while cursor < text.len() {
        if let Some(end) = escape_end(text, cursor).or_else(|| protected_end(text, cursor)) {
            cursor = end;
        } else if text[cursor..].starts_with("{{") {
            first_cloze.get_or_insert(cursor);
            let (end, parsed) = cloze(text, cursor);
            match parsed {
                Ok(cloze) => clozes.push(cloze),
                Err(problem) => result.problems.push(problem),
            }
            cursor = end;
        } else {
            if operator(text, cursor) {
                if let Some((_, last)) = &mut operators {
                    *last = cursor;
                } else {
                    operators = Some((cursor, cursor));
                }
            }
            // Advance one character so overlapping operators (>>> or <>>) are
            // ambiguous too, rather than silently changing one card's wording.
            cursor += text[cursor..].chars().next().expect("in bounds").len_utf8();
        }
    }
    if let Some((first, last)) = operators {
        if first != last {
            result.problems.push(problem(
                "Use only one card operator per block.",
                first,
                last + 2,
            ));
        }
        if let Some(cloze) = first_cloze {
            result.problems.push(problem(
                "Do not mix card operators and clozes.",
                first.min(cloze),
                text.len(),
            ));
        }
    }
    result
        .problems
        .sort_by_key(|problem| (problem.start, problem.end));
    if !result.problems.is_empty() {
        return result;
    }
    if let Some((at, _)) = operators {
        let left = trim_owned(literal(text, 0, at).into_owned());
        let right = trim_owned(literal(text, at + 2, text.len()).into_owned());
        if left.is_empty() || right.is_empty() {
            result
                .problems
                .push(problem("Both sides of a card need text.", at, at + 2));
            return result;
        }
        let card = |key: &str, kind, front, back| ParsedCard {
            key: key.to_owned(),
            kind,
            front,
            back,
        };
        match &text[at..at + 2] {
            ">>" => result
                .cards
                .push(card("forward", CardKind::Forward, left, right)),
            "<<" => result
                .cards
                .push(card("reverse", CardKind::Reverse, right, left)),
            "<>" => {
                result.cards.push(card(
                    "forward",
                    CardKind::Forward,
                    left.clone(),
                    right.clone(),
                ));
                result
                    .cards
                    .push(card("reverse", CardKind::Reverse, right, left));
            }
            _ => unreachable!("recognized operator"),
        }
    } else if !clozes.is_empty() {
        let mut pieces = Vec::with_capacity(clozes.len());
        let mut back = String::with_capacity(text.len());
        let mut previous = 0;
        for cloze in &clozes {
            let before = literal(text, previous, cloze.start);
            let answer = literal(text, cloze.answer_start, cloze.answer_end);
            let hint = cloze.hint_start.map_or(Cow::Borrowed("[…]"), |start| {
                literal(text, start, cloze.end - 2)
            });
            back.push_str(&before);
            back.push_str(&answer);
            pieces.push((before, answer, hint));
            previous = cloze.end;
        }
        let suffix = literal(text, previous, text.len());
        back.push_str(&suffix);
        let back = trim(&back);
        let mut seen = HashSet::with_capacity(clozes.len());
        for group in &clozes {
            if !seen.insert(group.id) {
                continue;
            }
            let mut front = String::with_capacity(text.len());
            for (cloze, (before, answer, hint)) in clozes.iter().zip(&pieces) {
                front.push_str(before);
                front.push_str(if cloze.id == group.id { hint } else { answer });
            }
            front.push_str(&suffix);
            result.cards.push(ParsedCard {
                key: format!("cloze:c{}", group.id),
                kind: CardKind::Cloze,
                front: trim_owned(front),
                back: back.to_owned(),
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(key: &str, kind: CardKind, front: &str, back: &str) -> ParsedCard {
        ParsedCard {
            key: key.to_owned(),
            kind,
            front: front.to_owned(),
            back: back.to_owned(),
        }
    }

    #[test]
    fn ordinary_fields_escapes_and_protected_syntax_are_not_cards() {
        for text in [
            "",
            "ordinary prose",
            "Author:: Frank Herbert",
            "Author::",
            "x > y < z",
            r"front\>>back",
            r"front\<<back",
            r"front\<>back",
            r"\{{c1::answer}}",
            "`a >> b {{c1::answer}}`",
            "``a ` >> b {{c1::answer}}``",
            "[[id|a >> b {{c1::answer}}]]",
            "#[[a << b]]",
            "```txt\na >> b {{c1::answer}}\n```",
            "~~~\na <> b\n~~~",
            "`unfinished >> {{c1::answer}}",
            "[[unfinished >> {{c1::answer}}",
            "```\nunfinished >> {{c1::answer}}",
            "~~~\nunfinished >> {{c1::answer}}",
        ] {
            assert_eq!(parse_card_text(text), CardParse::default(), "{text}");
        }
    }

    #[test]
    fn directions_and_compatible_edits_keep_role_keys() {
        for (text, cards) in [
            (
                " front>>back ",
                vec![card("forward", CardKind::Forward, "front", "back")],
            ),
            (
                "front<<back",
                vec![card("reverse", CardKind::Reverse, "back", "front")],
            ),
            (
                "front<>back",
                vec![
                    card("forward", CardKind::Forward, "front", "back"),
                    card("reverse", CardKind::Reverse, "back", "front"),
                ],
            ),
            (
                "🧠 café>>答🙂",
                vec![card("forward", CardKind::Forward, "🧠 café", "答🙂")],
            ),
        ] {
            assert_eq!(
                parse_card_text(text),
                CardParse {
                    cards,
                    problems: vec![]
                },
                "{text}"
            );
        }
        let changed = parse_card_text("updated question<>updated answer");
        assert_eq!(
            changed
                .cards
                .iter()
                .map(|card| (card.key.as_str(), card.kind))
                .collect::<Vec<_>>(),
            [
                ("forward", CardKind::Forward),
                ("reverse", CardKind::Reverse)
            ]
        );
        assert_eq!(
            parse_card_text("updated question<<updated answer").cards,
            [card(
                "reverse",
                CardKind::Reverse,
                "updated answer",
                "updated question"
            ),]
        );
    }

    #[test]
    fn escapes_render_literals_and_respect_backslash_parity() {
        for (text, front, back) in [
            (r"a\>>b>>c", "a>>b", "c"),
            (r"a\<>b>>c", "a<>b", "c"),
            (r"a>\>b>>c", "a>>b", "c"),
            (r"a\\>>b", r"a\", "b"),
            (r"a\\\>>b>>c", r"a\>>b", "c"),
            (r"C:\notes>>a\::b", r"C:\notes", "a::b"),
            (r"a\{{c1::x}}>>b", "a{{c1::x}}", "b"),
        ] {
            assert_eq!(
                parse_card_text(text),
                CardParse {
                    cards: vec![card("forward", CardKind::Forward, front, back)],
                    problems: vec![],
                },
                "{text}"
            );
        }
        assert_eq!(parse_card_text(r"a\>>>b"), CardParse::default());
    }

    #[test]
    fn code_and_references_preserve_markup_and_shield_nested_syntax() {
        for (text, front, back) in [
            ("`a >> b`>>[[id|x << y]]", "`a >> b`", "[[id|x << y]]"),
            ("``a ` >> b``>>answer", "``a ` >> b``", "answer"),
            ("```a >> b```>>answer", "```a >> b```", "answer"),
            (
                "question>>[[id|{{c1::not a cloze}}]]",
                "question",
                "[[id|{{c1::not a cloze}}]]",
            ),
            (
                "```txt\na >> b\n```\nquestion>>answer",
                "```txt\na >> b\n```\nquestion",
                "answer",
            ),
            (
                "   ~~~~\na >> b\n~~~\nstill << code\n   ~~~~\nQ>>A",
                "~~~~\na >> b\n~~~\nstill << code\n   ~~~~\nQ",
                "A",
            ),
            (
                "```\na >> b\n``` not a closer\nc << d\n```\nQ>>A",
                "```\na >> b\n``` not a closer\nc << d\n```\nQ",
                "A",
            ),
            (r"Q>>```x``` \>>", "Q", "```x``` >>"),
            (r"Q>>`x\>>y`", "Q", r"`x\>>y`"),
        ] {
            assert_eq!(
                parse_card_text(text),
                CardParse {
                    cards: vec![card("forward", CardKind::Forward, front, back)],
                    problems: vec![],
                },
                "{text}"
            );
        }
        assert_eq!(
            parse_card_text("{{c1::`a::b >> {{c2::x}}`::code}}"),
            CardParse {
                cards: vec![card(
                    "cloze:c1",
                    CardKind::Cloze,
                    "code",
                    "`a::b >> {{c2::x}}`"
                )],
                problems: vec![],
            }
        );
        assert_eq!(
            parse_card_text("{{c1::[[id|a::b {{c2::x}}]]}}"),
            CardParse {
                cards: vec![card(
                    "cloze:c1",
                    CardKind::Cloze,
                    "[…]",
                    "[[id|a::b {{c2::x}}]]"
                )],
                problems: vec![],
            }
        );
    }

    #[test]
    fn clozes_group_authored_ids_and_mask_only_their_group() {
        assert_eq!(
            parse_card_text("🧠 {{c1::café::飲}} + {{c2::答🙂}}"),
            CardParse {
                cards: vec![
                    card(
                        "cloze:c1",
                        CardKind::Cloze,
                        "🧠 飲 + 答🙂",
                        "🧠 café + 答🙂"
                    ),
                    card(
                        "cloze:c2",
                        CardKind::Cloze,
                        "🧠 café + […]",
                        "🧠 café + 答🙂"
                    ),
                ],
                problems: vec![],
            }
        );
        assert_eq!(
            parse_card_text(r"{{c1::```x``` \>>::hint}}"),
            CardParse {
                cards: vec![card("cloze:c1", CardKind::Cloze, "hint", "```x``` >>")],
                problems: vec![],
            }
        );
        assert_eq!(
            parse_card_text("A {{c1::one}} B {{c2::two::number}} C {{c01::uno::hint}}."),
            CardParse {
                cards: vec![
                    card(
                        "cloze:c1",
                        CardKind::Cloze,
                        "A […] B two C hint.",
                        "A one B two C uno."
                    ),
                    card(
                        "cloze:c2",
                        CardKind::Cloze,
                        "A one B number C uno.",
                        "A one B two C uno."
                    ),
                ],
                problems: vec![],
            }
        );
        assert_eq!(
            parse_card_text(r"{{c1::a\::b\}}c::h\::i}}"),
            CardParse {
                cards: vec![card("cloze:c1", CardKind::Cloze, "h::i", "a::b}}c")],
                problems: vec![],
            }
        );
        assert_eq!(
            parse_card_text("{{c1::a>>b}}"),
            CardParse {
                cards: vec![card("cloze:c1", CardKind::Cloze, "[…]", "a>>b")],
                problems: vec![],
            }
        );
    }

    #[test]
    fn cloze_identity_survives_edits_insertions_reordering_and_large_ids() {
        let original = parse_card_text("{{c8::eight}} {{c2::two}}").cards;
        let changed = parse_card_text("{{c2::deux}} {{c7::new}} {{c8::huit}}").cards;
        assert_eq!(
            original
                .iter()
                .map(|card| card.key.as_str())
                .collect::<Vec<_>>(),
            ["cloze:c8", "cloze:c2"]
        );
        assert_eq!(
            changed
                .iter()
                .map(|card| card.key.as_str())
                .collect::<Vec<_>>(),
            ["cloze:c2", "cloze:c7", "cloze:c8"]
        );
        assert_eq!(
            changed
                .iter()
                .find(|card| card.key == original[0].key)
                .unwrap()
                .front,
            "deux new […]"
        );
        assert_eq!(
            changed
                .iter()
                .find(|card| card.key == original[1].key)
                .unwrap()
                .front,
            "[…] new huit"
        );
        let id = "900719925474099312345678901234567890";
        let text = format!("{{{{c{id}::answer}}}} {{{{c0{id}::again}}}}");
        assert_eq!(
            parse_card_text(&text).cards,
            [card(
                &format!("cloze:c{id}"),
                CardKind::Cloze,
                "[…] […]",
                "answer again"
            ),]
        );
    }

    #[test]
    fn malformed_clozes_suppress_all_units_instead_of_returning_partial_groups() {
        for text in [
            "{{c0::answer}}",
            "{{c000::answer}}",
            "{{c-1::answer}}",
            "{{c1.5::answer}}",
            "{{c١::answer}}",
            "{{c::answer}}",
            "{{C1::answer}}",
            "{{c1 answer}}",
            "{{answer}}",
            "{{c1::}}",
            "{{c1:: \n }}",
            "{{c1::answer::}}",
            "{{c1::answer::hint::extra}}",
            "{{c1::answer}",
            "{{c1::answer",
            "{{c1::outer {{c2::inner}}}}",
            "{{c1::`unclosed}}",
            "{{c1::[[unclosed}}",
        ] {
            let parsed = parse_card_text(text);
            assert!(parsed.cards.is_empty(), "{text}");
            assert_eq!(
                parsed
                    .problems
                    .iter()
                    .map(|problem| (problem.start, problem.end))
                    .collect::<Vec<_>>(),
                [(0, text.len())],
                "{text}"
            );
            assert!(
                parse_card_text(&format!("{{{{c9::valid}}}} {text}"))
                    .cards
                    .is_empty(),
                "{text}"
            );
        }
    }

    #[test]
    fn mixed_overlapping_and_empty_operator_cards_have_actionable_ranges() {
        for (text, start, end) in [
            ("a >> b << c", 2, 9),
            ("a >> b >> c", 2, 9),
            ("a>>>b", 1, 4),
            ("a<>>b", 1, 4),
            ("a<<<b", 1, 4),
        ] {
            let parsed = parse_card_text(text);
            assert!(parsed.cards.is_empty(), "{text}");
            assert_eq!(
                parsed
                    .problems
                    .iter()
                    .map(|problem| (problem.start, problem.end))
                    .collect::<Vec<_>>(),
                [(start, end)],
                "{text}"
            );
        }
        for (text, operator) in [
            (">>answer", ">>"),
            ("question<<", "<<"),
            (" \n <> \t", "<>"),
        ] {
            let parsed = parse_card_text(text);
            assert!(parsed.cards.is_empty(), "{text}");
            assert_eq!(
                parsed
                    .problems
                    .iter()
                    .map(|problem| &text[problem.start..problem.end])
                    .collect::<Vec<_>>(),
                [operator],
                "{text}"
            );
        }
        for text in [
            "{{c1::answer}} >> back",
            "front << {{c2::answer}}",
            "{{c0::bad}} <> back",
        ] {
            let parsed = parse_card_text(text);
            assert!(parsed.cards.is_empty(), "{text}");
            let start = if text.starts_with("{{") { 0 } else { 6 };
            assert!(
                parsed
                    .problems
                    .iter()
                    .any(|problem| problem.start == start && problem.end == text.len()),
                "{text}"
            );
        }
    }

    #[test]
    fn unicode_diagnostics_use_byte_offsets_and_shared_whitespace_rules() {
        let malformed = parse_card_text("🧠 café {{c0::答}}");
        assert_eq!(
            malformed
                .problems
                .iter()
                .map(|problem| (problem.start, problem.end))
                .collect::<Vec<_>>(),
            [(11, 22)]
        );
        let ambiguous = parse_card_text("🧠 >> α << β");
        assert_eq!(
            ambiguous
                .problems
                .iter()
                .map(|problem| (problem.start, problem.end))
                .collect::<Vec<_>>(),
            [(5, 13)]
        );
        assert_eq!(
            parse_card_text("\u{85}Q\u{2003}>>\u{a0}A\u{85}").cards,
            [card("forward", CardKind::Forward, "Q", "A"),]
        );
        assert!(parse_card_text("\u{85}>>A").cards.is_empty());
        assert_eq!(
            parse_card_text("\u{feff}>>A").cards,
            [card("forward", CardKind::Forward, "\u{feff}", "A"),]
        );
    }
}
