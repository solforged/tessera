//! Plain-text renderings of notebook state for agents.

use std::collections::HashMap;
use std::fmt::Write;

use anyhow::Context;
use serde::Serialize;
use tessera_core::calendar::{RepeatUnit, Repeater};
use tessera_core::card_text::CardKind;
use tessera_core::{
    Block, BlockCapabilities, BlockKind, CardUnit, PageView, QuoteState, SettingsView, TaskState,
    TaskStatus,
};

/// The notebook's calendar: today and the zone timestamps are shown in.
pub(super) struct Clock {
    zone: jiff::tz::TimeZone,
    pub today: String,
}

impl Clock {
    pub(super) fn new(settings: &SettingsView) -> anyhow::Result<Self> {
        Ok(Self {
            zone: jiff::tz::TimeZone::get(&settings.time_zone)
                .with_context(|| format!("unknown time zone {}", settings.time_zone))?,
            today: settings.today.clone(),
        })
    }

    /// The calendar date of a Unix millisecond timestamp in the notebook zone.
    pub(super) fn date(&self, ms: i64) -> String {
        jiff::Timestamp::from_millisecond(ms)
            .map(|instant| instant.to_zoned(self.zone.clone()).date().to_string())
            .unwrap_or_else(|_| ms.to_string())
    }
}

/// What a page rendering needs beyond the page itself.
pub(super) struct PageContext<'a> {
    /// Field definition names by ID.
    pub fields: &'a HashMap<String, String>,
    /// Active cards whose source blocks are on the page.
    pub cards: &'a [CardUnit],
    pub clock: &'a Clock,
}

/// The page, or the subtree under `subtree`, as an indented outline. Each
/// block's comment holds its ID and revision, then its tags, task, other
/// capabilities, citations and cards. References to pages and journal days
/// show their title so an agent can write them back as `[[Title]]`, and
/// field entries show as `Name::`, the shorthand that writes them.
pub(super) fn render(
    page: &PageView,
    context: &PageContext,
    subtree: Option<&str>,
) -> anyhow::Result<String> {
    let titles: HashMap<&str, &str> = page
        .targets
        .iter()
        .filter(|block| block.kind != BlockKind::Block)
        .map(|block| (block.id.as_str(), block.text.as_str()))
        .collect();
    let capabilities: HashMap<&str, &BlockCapabilities> = page
        .capabilities
        .iter()
        .map(|caps| (caps.block_id.as_str(), caps))
        .collect();
    let mut cards: HashMap<&str, Vec<&CardUnit>> = HashMap::new();
    for card in context.cards {
        cards
            .entry(card.source_block_id.as_str())
            .or_default()
            .push(card);
    }
    let mut header = vec![format!("{} r{}", page.root.id, page.root.revision)];
    if let Some(caps) = capabilities.get(page.root.id.as_str()) {
        header.extend(capability_details(caps));
    }
    let root_quote = capabilities
        .get(page.root.id.as_str())
        .and_then(|caps| caps.quote.as_ref());
    let quote_title = root_quote.map(|quote| format!("Quote of {}", quote.target_id));
    let title = quote_title.as_deref().unwrap_or(&page.root.text);
    let mut text = format!("# {title} <!-- {} -->\n", header.join(", "));
    if let Some(quote) = root_quote {
        render_quote(&mut text, quote, 0);
    }
    let (rows, base) = match subtree.filter(|id| *id != page.root.id) {
        Some(id) => {
            let start = page
                .rows
                .iter()
                .position(|row| row.block.id == id)
                .with_context(|| format!("block {id} is not on this page"))?;
            let depth = page.rows[start].depth;
            let length = 1 + page.rows[start + 1..]
                .iter()
                .take_while(|row| row.depth > depth)
                .count();
            text.push_str(&format!("(The subtree under block {id}.)\n"));
            (&page.rows[start..start + length], depth)
        }
        None => (&page.rows[..], 0),
    };
    for row in rows {
        let indent = "  ".repeat((row.depth - base) as usize);
        let caps = capabilities.get(row.block.id.as_str());
        let task = caps.and_then(|caps| caps.task.as_ref());
        let marker = task.map_or("", |task| marker(task.status));
        let heading = row
            .block
            .heading
            .map(|level| format!("{} ", "#".repeat(level as usize)))
            .unwrap_or_default();
        let quote = caps.and_then(|caps| caps.quote.as_ref());
        let body = if let Some(quote) = quote {
            format!("Quote of {}", quote.target_id)
        } else {
            match field_entry(&row.block.text).and_then(|id| context.fields.get(id)) {
                Some(name) => format!("{name}::"),
                None => titled(&row.block.text, &titles).replace('\n', &format!("\n{indent}  ")),
            }
        };
        let archived = if row.block.archived {
            " (archived)"
        } else {
            ""
        };
        let mut note = vec![format!("{} r{}", row.block.id, row.block.revision)];
        if !row.manual_types.is_empty() {
            note.push(format!("tags {}", row.manual_types.join(", ")));
        }
        if let Some(task) = task {
            note.extend(task_details(task));
        }
        if let Some(caps) = caps {
            note.extend(capability_details(caps));
        }
        for card in cards.get(row.block.id.as_str()).into_iter().flatten() {
            note.push(card_label(card, context.clock));
        }
        text.push_str(&format!(
            "{indent}- {marker}{heading}{body}{archived} <!-- {} -->\n",
            note.join(", ")
        ));
        if let Some(quote) = quote {
            render_quote(&mut text, quote, row.depth - base + 1);
        }
    }
    Ok(text)
}

fn render_quote(text: &mut String, quote: &QuoteState, depth: u32) {
    for row in &quote.rows {
        let indent = "  ".repeat((depth + row.depth) as usize);
        let heading = "#".repeat(row.heading.unwrap_or(0) as usize);
        let body = row.text.replace('\n', &format!("\n{indent}>   "));
        writeln!(
            text,
            "{indent}> - {heading}{}{body}",
            if heading.is_empty() { "" } else { " " }
        )
        .expect("writing to a string");
    }
    if quote.truncated {
        writeln!(text, "{}> (truncated)", "  ".repeat(depth as usize))
            .expect("writing to a string");
    }
}

/// The field definition ID of a field entry's text, `[[ID]]` alone.
fn field_entry(text: &str) -> Option<&str> {
    let inner = text.trim().strip_prefix("[[")?.strip_suffix("]]")?;
    let id = inner.split_once('|').map_or(inner, |(id, _)| id);
    (!id.is_empty() && !id.contains(['[', ']'])).then_some(id)
}

/// The checkbox-style marker `outline` reads back as the same status.
pub(super) fn marker(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Todo => "[ ] ",
        TaskStatus::Done => "[x] ",
        TaskStatus::Doing => "[doing] ",
        TaskStatus::Waiting => "[waiting] ",
        TaskStatus::Cancelled => "[cancelled] ",
    }
}

/// Planning details in the words `tessera_set_task` takes.
pub(super) fn task_details(task: &TaskState) -> Vec<String> {
    let mut parts = Vec::new();
    if let Some(day) = &task.scheduled {
        parts.push(match &task.scheduled_time {
            Some(time) => format!("scheduled {day} {time}"),
            None => format!("scheduled {day}"),
        });
    }
    if let Some(day) = &task.deadline {
        let mut part = format!("deadline {day}");
        if let Some(time) = &task.deadline_time {
            part.push_str(&format!(" {time}"));
        }
        if let Some(days) = task.warning_days {
            part.push_str(&format!(" warning {days} days before"));
        }
        parts.push(part);
    }
    if let Some(repeat) = &task.repeater {
        parts.push(format!(
            "repeat {} {}",
            repeat_text(repeat),
            name(repeat.mode)
        ));
    }
    if let Some(priority) = task.priority {
        parts.push(format!("priority {}", name(priority)));
    }
    if let Some(day) = &task.completed_on {
        parts.push(format!("completed {day}"));
    }
    parts
}

/// A repeat interval as `tessera_set_task` takes it: `1d`, `2w`, `1m`, `1y`.
pub(super) fn repeat_text(repeat: &Repeater) -> String {
    let unit = match repeat.unit {
        RepeatUnit::Day => 'd',
        RepeatUnit::Week => 'w',
        RepeatUnit::Month => 'm',
        RepeatUnit::Year => 'y',
    };
    format!("{}{unit}", repeat.every)
}

/// Project, question, assessment, position, relation, source and citation details.
fn capability_details(caps: &BlockCapabilities) -> Vec<String> {
    let mut parts = Vec::new();
    if let Some(project) = &caps.project {
        let mut part = format!("project {} {:?}", name(project.status), project.outcome);
        if let Some(day) = &project.deadline {
            part.push_str(&format!(" deadline {day}"));
        }
        parts.push(part);
    }
    if let Some(question) = &caps.question {
        let mut part = format!("question {}", name(question.status));
        if let Some(parent) = &question.parent_id {
            part.push_str(&format!(
                " parent {parent} ({})",
                if question.parent_explicit {
                    "explicit"
                } else {
                    "structural"
                }
            ));
        }
        if let Some(day) = &question.state.review_on {
            part.push_str(&format!(" review {day}"));
        }
        parts.push(part);
    }
    if let Some(assessment) = &caps.assessment {
        let mut part = format!("assessment {}", assessment.state.assessed_on);
        if assessment.accepted {
            part.push_str(" accepted");
        }
        if assessment.state.aporia {
            part.push_str(" aporia");
        }
        parts.push(part);
    }
    if caps.position.is_some() {
        parts.push("position".into());
    }
    if let Some(relation) = &caps.relation {
        let mut part = format!(
            "relation {} target {}",
            relation.kind.as_str(),
            relation.target_id.as_deref().unwrap_or("none")
        );
        if let Some(problem) = &relation.problem {
            part.push_str(&format!(" ({problem})"));
        }
        parts.push(part);
    }
    if let Some(source) = &caps.source {
        parts.push(format!(
            "source {} {}",
            name(source.format),
            name(source.state)
        ));
    }
    for citation in &caps.citations {
        parts.push(format!(
            "cites “{}” at {} (passage {})",
            snippet(&citation.quote),
            citation.locator,
            citation.start.passage_id
        ));
    }
    parts
}

/// A card's ID, kind, template and scheduling state.
pub(super) fn card_label(card: &CardUnit, clock: &Clock) -> String {
    let mut label = format!("card {} {}", card.id, name(card.kind));
    if let Some(template) = &card.template {
        label.push_str(&format!(" from template {:?}", template.name));
    }
    label.push(' ');
    label.push_str(&card_state(card, clock));
    label
}

/// Held, new, or the date it is next due.
pub(super) fn card_state(card: &CardUnit, clock: &Clock) -> String {
    if card.held {
        "held".into()
    } else if card.schedule.last_reviewed_at.is_none() {
        "new".into()
    } else {
        format!("due {}", clock.date(card.schedule.due_at))
    }
}

/// A card's answer: its back, or for child-answer cards, whose back is
/// serialized data, their answer blocks.
pub(super) fn card_answer(card: &CardUnit) -> String {
    if !matches!(card.kind, CardKind::Multiline | CardKind::List) {
        return one_line(&card.back);
    }
    fn walk(blocks: &[tessera_core::CardAnswerBlock], out: &mut Vec<String>) {
        for block in blocks {
            out.push(one_line(&block.text));
            walk(&block.children, out);
        }
    }
    let mut parts = Vec::new();
    walk(&card.answer_blocks, &mut parts);
    parts.join(" / ")
}

/// An enum's serialized name, such as `catch_up`.
pub(super) fn name<T: Serialize>(value: T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(name)) => name,
        _ => String::new(),
    }
}

/// Lines joined with ` / ` so a row stays one line.
pub(super) fn one_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" / ")
}

/// The start of a text's first line.
pub(super) fn snippet(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    match line.char_indices().nth(60) {
        Some((end, _)) => format!("{}…", line[..end].trim_end()),
        None => line.to_owned(),
    }
}

pub(super) fn titled(text: &str, titles: &HashMap<&str, &str>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let Some(end) = rest[start + 2..].find("]]") else {
            break;
        };
        let reference = &rest[start + 2..start + 2 + end];
        let (target, alias) = match reference.split_once('|') {
            Some((target, alias)) => (target, Some(alias)),
            None => (reference, None),
        };
        out.push_str(&rest[..start]);
        match titles.get(target) {
            Some(title) => {
                out.push_str("[[");
                out.push_str(title);
                if let Some(alias) = alias {
                    out.push('|');
                    out.push_str(alias);
                }
                out.push_str("]]");
            }
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &rest[start + 2 + end + 2..];
    }
    out.push_str(rest);
    out
}

pub(super) fn quoted(pages: &[Block]) -> String {
    pages
        .iter()
        .map(|page| format!("{:?}", page.text))
        .collect::<Vec<_>>()
        .join(", ")
}

pub(super) fn age(ms: i64) -> String {
    let minutes = ms.max(0) / 60_000;
    match minutes {
        0 => "just now".into(),
        1..60 => format!("{minutes} min ago"),
        60..2880 => format!("{} h ago", minutes / 60),
        _ => format!("{} days ago", minutes / 1440),
    }
}

pub(super) fn kind_label(kind: BlockKind) -> &'static str {
    match kind {
        BlockKind::Journal => "journal day",
        _ => "page",
    }
}

/// `on page "Title" (page ID)`, naming where a block lives.
pub(super) fn location(page: &Block) -> String {
    format!(
        "on {} {:?} (page {})",
        kind_label(page.kind),
        page.text,
        page.id
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_to_pages_render_as_titles_and_keep_aliases() {
        let titles = HashMap::from([("01J0000000000000000000000A", "Dune")]);
        assert_eq!(
            titled(
                "see [[01J0000000000000000000000A]] and [[01J0000000000000000000000A|it]] and [[01J0000000000000000000000B]]",
                &titles
            ),
            "see [[Dune]] and [[Dune|it]] and [[01J0000000000000000000000B]]"
        );
    }

    #[test]
    fn quote_render_uses_frozen_nested_rows_instead_of_the_marker() {
        use tessera_core::{Actor, Batch, Notebook, Operation};
        let dir = tempfile::tempdir().unwrap();
        let mut nb = Notebook::open(dir.path()).unwrap();
        let id = |n| format!("{n:026}");
        let batch = |operations| Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations,
        };
        nb.apply(&batch(vec![
            Operation::CreatePage {
                id: id(1),
                title: "Source".into(),
            },
            Operation::CreatePage {
                id: id(2),
                title: "Quotes".into(),
            },
            Operation::Insert {
                id: id(3),
                parent_id: id(1),
                after: None,
                text: "Frozen root".into(),
                heading: None,
            },
            Operation::Insert {
                id: id(4),
                parent_id: id(3),
                after: None,
                text: "Frozen child".into(),
                heading: Some(2),
            },
        ]))
        .unwrap();
        let quote = nb.quote_snapshot(&id(3), 123).unwrap();
        let marker = format!("(({}))", id(3));
        nb.apply(&batch(vec![
            Operation::Insert {
                id: id(5),
                parent_id: id(2),
                after: None,
                text: marker.clone(),
                heading: None,
            },
            Operation::SetQuote {
                id: id(5),
                base_revision: 1,
                quote: Some(quote),
            },
            Operation::EditText {
                id: id(3),
                base_revision: 1,
                text: "Live replacement".into(),
            },
        ]))
        .unwrap();
        let fields = HashMap::new();
        let clock = Clock {
            zone: jiff::tz::TimeZone::UTC,
            today: "2026-10-12".into(),
        };
        let context = PageContext {
            fields: &fields,
            cards: &[],
            clock: &clock,
        };
        let output = render(&nb.page(&id(2)).unwrap(), &context, None).unwrap();
        assert!(output.contains(&id(3)));
        assert!(output.contains("  > - Frozen root\n    > - ## Frozen child\n"));
        assert!(!output.contains(&marker));
        assert!(!output.contains("Live replacement"));
    }

    #[test]
    fn page_render_shows_relation_kind_target_and_problem() {
        use tessera_core::{Actor, Batch, Notebook, Operation, RelationKind};
        let dir = tempfile::tempdir().unwrap();
        let mut nb = Notebook::open(dir.path()).unwrap();
        let id = |n| format!("{n:026}");
        nb.apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![
                Operation::CreatePage {
                    id: id(1),
                    title: "Person".into(),
                },
                Operation::CreatePage {
                    id: id(3),
                    title: "Reasoning".into(),
                },
                Operation::Insert {
                    id: id(2),
                    parent_id: id(3),
                    after: None,
                    text: format!("[[{}]]", id(1)),
                    heading: None,
                },
                Operation::SetRelation {
                    id: id(2),
                    base_revision: 1,
                    relation: Some(RelationKind::Answers),
                },
            ],
        })
        .unwrap();
        let fields = HashMap::new();
        let clock = Clock {
            zone: jiff::tz::TimeZone::UTC,
            today: "2026-10-12".into(),
        };
        let context = PageContext {
            fields: &fields,
            cards: &[],
            clock: &clock,
        };
        let output = render(&nb.page(&id(3)).unwrap(), &context, None).unwrap();
        assert!(output.contains(&format!("relation answers target {}", id(1))));
        assert!(output.contains("question as its target"));
        assert!(output.contains("[[Person]]"));
    }
}
