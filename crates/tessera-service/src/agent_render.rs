//! Plain-text renderings of notebook state for agents.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Write;

use anyhow::Context;
use serde::Serialize;
use tessera_core::calendar::{RepeatUnit, Repeater};
use tessera_core::card_text::CardKind;
use tessera_core::{
    Block, BlockCapabilities, BlockKind, CardUnit, FieldKind, FieldOption, FieldsView, PageView,
    QuoteState, SettingsView, TaskState, TaskStatus,
};

/// The notebook's calendar: today and the zone timestamps are shown in.
pub struct Clock {
    zone: jiff::tz::TimeZone,
    pub today: String,
}

impl Clock {
    pub fn new(settings: &SettingsView) -> anyhow::Result<Self> {
        Ok(Self {
            zone: jiff::tz::TimeZone::get(&settings.time_zone)
                .with_context(|| format!("unknown time zone {}", settings.time_zone))?,
            today: settings.today.clone(),
        })
    }

    /// The calendar date of a Unix millisecond timestamp in the notebook zone.
    pub fn date(&self, ms: i64) -> String {
        jiff::Timestamp::from_millisecond(ms)
            .map(|instant| instant.to_zoned(self.zone.clone()).date().to_string())
            .unwrap_or_else(|_| ms.to_string())
    }
}

/// What a page rendering needs beyond the page itself.
pub struct PageContext<'a> {
    pub fields: &'a Fields,
    /// Active cards whose source blocks are on the page.
    pub cards: &'a [CardUnit],
    pub clock: &'a Clock,
}

/// The field definitions a page rendering names.
#[derive(Default)]
pub struct Fields {
    /// Names by definition ID.
    pub names: HashMap<String, String>,
    /// Choice fields' live options by definition ID.
    pub choices: HashMap<String, Vec<FieldOption>>,
}

impl From<FieldsView> for Fields {
    fn from(view: FieldsView) -> Self {
        let mut fields = Self::default();
        for field in view.fields {
            let definition = field.definition;
            if definition.kind == FieldKind::Choice {
                fields
                    .choices
                    .insert(definition.id.clone(), definition.options);
            }
            fields.names.insert(definition.id, definition.name);
        }
        fields
    }
}

/// The page, or the subtree under `subtree`, as an indented outline. Each
/// block's comment holds its ID and revision, then its tags, task, other
/// capabilities, revisit state, citations and cards; the page's comment does
/// the same for its root, with the task's status. References to pages and
/// journal days show their title without its tags so an agent can write them
/// back as `[[Title]]`, tags show as [`agent_tags`] writes them, field
/// entries show as `Name::`, the shorthand that writes them, and a choice
/// field's values under them as `[[Option]]`. Block text reads back through
/// `tessera_add_note` as the same text: a line that would read as structure
/// starts with a backslash, and `-->` shows as `--\>`. Citation quotes are
/// passage text and show as stored.
pub fn render(
    page: &PageView,
    context: &PageContext,
    subtree: Option<&str>,
) -> anyhow::Result<String> {
    // The page itself is a target too, for links from its own blocks.
    let titles: HashMap<&str, &str> = page
        .targets
        .iter()
        .chain([&page.root])
        .filter(|block| block.kind != BlockKind::Block)
        .map(|block| (block.id.as_str(), block.text.as_str()))
        .collect();
    let capabilities: HashMap<&str, &BlockCapabilities> = page
        .capabilities
        .iter()
        .map(|caps| (caps.block_id.as_str(), caps))
        .collect();
    // Each choice field entry on the page, with the options its values name.
    let choices: HashMap<&str, &[FieldOption]> = page
        .rows
        .iter()
        .filter_map(|row| {
            let options = context.fields.choices.get(field_entry(&row.block.text)?)?;
            Some((row.block.id.as_str(), options.as_slice()))
        })
        .collect();
    let mut cards: HashMap<&str, Vec<&CardUnit>> = HashMap::new();
    for card in context.cards {
        cards
            .entry(card.source_block_id.as_str())
            .or_default()
            .push(card);
    }
    let mut header = vec![format!("{} r{}", page.root.id, page.root.revision)];
    // The title's tags leave the display title and ride in the comment, as rows' manual tags do.
    let tags: Vec<Cow<str>> = tessera_core::tag_tokens(&page.root.text)
        .map(|token| match token.id {
            Some(id) => display(id, &titles).unwrap_or(Cow::Borrowed(if token.title.is_empty() {
                id
            } else {
                token.title
            })),
            None => Cow::Borrowed(token.title),
        })
        .collect();
    if !tags.is_empty() {
        header.push(format!("tags {}", tags.join(", ")));
    }
    let root_caps = capabilities.get(page.root.id.as_str()).copied();
    if let Some(task) = root_caps.and_then(|caps| caps.task.as_ref()) {
        // Rows show the status as their marker; a title has none.
        if let Some(status) = task.status {
            header.push(format!("status {}", name(status)));
        }
        header.extend(task_details(task));
    }
    if let Some(caps) = root_caps {
        header.extend(capability_details(caps, context.clock));
    }
    let root_quote = root_caps.and_then(|caps| caps.quote.as_ref());
    let quote_title = root_quote.map(|quote| format!("Quote of {}", quote.target_id));
    let root_title = tessera_core::display_title(&page.root.text, |id| titles.get(id).copied());
    let title = titled(quote_title.as_deref().unwrap_or(&root_title), &titles);
    let mut text = format!(
        "# {} <!-- {} -->\n",
        comment_safe(&title),
        comment_safe(&header.join(", "))
    );
    if let Some(quote) = root_quote {
        render_quote(&mut text, quote, 0, &titles);
    }
    let (rows, base) = match subtree.filter(|id| *id != page.root.id) {
        Some(id) => {
            let start = page
                .rows
                .iter()
                .position(|row| row.block.id == id)
                .with_context(|| format!("atom {id} is not in this outline"))?;
            let depth = page.rows[start].depth;
            let length = 1 + page.rows[start + 1..]
                .iter()
                .take_while(|row| row.depth > depth)
                .count();
            text.push_str(&format!("(The subtree under atom {id}.)\n"));
            (&page.rows[start..start + length], depth)
        }
        None => (&page.rows[..], 0),
    };
    for row in rows {
        let indent = "  ".repeat((row.depth - base) as usize);
        let newline = format!("\n{indent}  ");
        let caps = capabilities.get(row.block.id.as_str()).copied();
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
        } else if let Some(image) = caps.and_then(|caps| caps.image.as_ref()) {
            outline_text(
                &format!(
                    "![{}](/api/images/{})",
                    row.block
                        .text
                        .replace('\\', "\\\\")
                        .replace('[', "\\[")
                        .replace(']', "\\]"),
                    image.sha256
                ),
                &newline,
            )
        } else if let Some(name) =
            field_entry(&row.block.text).and_then(|id| context.fields.names.get(id))
        {
            format!("{}::", comment_safe(name))
        } else if let Some(option) = row
            .block
            .parent_id
            .as_deref()
            .and_then(|parent| choices.get(parent))
            .and_then(|options| option_name(&row.block.text, options))
        {
            outline_text(&format!("[[{option}]]"), &newline)
        } else {
            outline_text(&titled(&row.block.text, &titles), &newline)
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
            note.extend(capability_details(caps, context.clock));
        }
        for card in cards.get(row.block.id.as_str()).into_iter().flatten() {
            let label = card_label(card, context.clock);
            note.push(if card.kind == CardKind::Occlusion {
                format!("{label}: {}", titled(&card_answer(card), &titles))
            } else {
                label
            });
        }
        writeln!(
            text,
            "{indent}- {marker}{heading}{body}{archived} <!-- {} -->",
            comment_safe(&note.join(", "))
        )?;
        if let Some(quote) = quote {
            render_quote(&mut text, quote, row.depth - base + 1, &titles);
        }
    }
    for caps in page.capabilities.iter().filter(|caps| {
        caps.question.is_some()
            && (subtree.is_none_or(|id| id == page.root.id || id == caps.block_id)
                || rows.iter().any(|row| row.block.id == caps.block_id))
    }) {
        let question = caps.question.as_ref().expect("filtered question");
        let mut assessments: Vec<_> = page
            .rows
            .iter()
            .filter_map(|row| {
                let assessment = capabilities
                    .get(row.block.id.as_str())?
                    .assessment
                    .as_ref()?;
                (assessment.question_id.as_deref() == Some(caps.block_id.as_str()))
                    .then_some((row, assessment))
            })
            .collect();
        // The decision journal appears once the question has an assessment.
        if assessments.is_empty() {
            continue;
        }
        assessments.sort_by(|(a, ai), (b, bi)| {
            bi.state
                .assessed_on
                .cmp(&ai.state.assessed_on)
                .then_with(|| b.block.id.cmp(&a.block.id))
        });
        writeln!(text, "\nDecision journal for {}:", caps.block_id)?;
        for (row, assessment) in assessments {
            let decision = question
                .state
                .reading_history
                .iter()
                .rev()
                .find(|decision| decision.assessment_id == row.block.id);
            let status = if assessment.accepted {
                "current answer".to_owned()
            } else if let Some(decision) =
                decision.filter(|decision| decision.status != tessera_core::ReadingStatus::Current)
            {
                format!("{} on {}", name(decision.status), decision.on)
            } else {
                "not accepted".to_owned()
            };
            writeln!(
                text,
                "- {} · {} · {} [{}]",
                assessment.state.assessed_on,
                status,
                comment_safe(&titled(
                    row.block.text.lines().next().unwrap_or_default(),
                    &titles
                )),
                row.block.id
            )?;
        }
    }
    Ok(text)
}

/// A quote's frozen rows under `> `, with links and tags shown by title.
fn render_quote(text: &mut String, quote: &QuoteState, depth: u32, titles: &HashMap<&str, &str>) {
    for row in &quote.rows {
        let indent = "  ".repeat((depth + row.depth) as usize);
        let heading = "#".repeat(row.heading.unwrap_or(0) as usize);
        let body =
            comment_safe(&titled(&row.text, titles)).replace('\n', &format!("\n{indent}>   "));
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

/// Block text as outline lines that `tessera_add_note` reads back as the same
/// text, each line after the first starting with `newline`. A block that is
/// one fenced code block stays as written. In other text, a line that would
/// read back as structure gets one backslash before its first non-blank
/// character (see [`structural`]). Everywhere, `-->` shows as `--\>` so text
/// never ends the row's comment.
fn outline_text(text: &str, newline: &str) -> String {
    let code = fenced(text);
    let mut out = String::with_capacity(text.len() + newline.len());
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            out.push_str(newline);
        }
        let content = line.trim_start();
        if !code && structural(content) {
            out.push_str(&line[..line.len() - content.len()]);
            out.push('\\');
            out.push_str(content);
        } else {
            out.push_str(line);
        }
    }
    match comment_safe(&out) {
        Cow::Borrowed(_) => out,
        Cow::Owned(escaped) => escaped,
    }
}

/// Whether a line, from its first non-blank character, would read back as
/// outline structure instead of text: a backslash escape itself, a heading,
/// quote or fence, a list item or task marker, a thematic break, or field
/// shorthand. `tessera_add_note` removes the one backslash before each. Tags
/// and clozes are text, so `#Tag` and `{{c1::answer}}` lines stay as written.
fn structural(line: &str) -> bool {
    const TASKS: [&str; 6] = ["[ ]", "[x]", "[X]", "[doing]", "[waiting]", "[cancelled]"];
    // Outline lines end before `\r\n`.
    let line = line.strip_suffix('\r').unwrap_or(line);
    let marker_ends = |rest: &str| rest.is_empty() || rest.starts_with([' ', '\t']);
    let mark = |ch: char| matches!(ch, '-' | '*' | '_');
    let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    line.starts_with(['\\', '>'])
        || ((1..=6).contains(&hashes) && marker_ends(&line[hashes..]))
        || line.starts_with("```")
        || line.starts_with("~~~")
        || line.strip_prefix(['-', '*', '+']).is_some_and(marker_ends)
        || ((1..=9).contains(&digits)
            && line[digits..]
                .strip_prefix(['.', ')'])
                .is_some_and(marker_ends))
        || TASKS
            .iter()
            .any(|task| line.strip_prefix(task).is_some_and(marker_ends))
        || (line.chars().all(|ch| mark(ch) || matches!(ch, ' ' | '\t'))
            && line.chars().filter(|ch| mark(*ch)).count() >= 2)
        || line.find("::").is_some_and(|at| {
            // As the outline reads field shorthand: a name of up to 60
            // characters that is not card syntax.
            let name = line[..at].trim();
            !name.is_empty()
                && line[..at].chars().count() <= 60
                && !name.contains(['\\', '`', '[', ']', '#', ':'])
                && {
                    let card = tessera_core::card_text::parse_card_text(name);
                    card.cards.is_empty() && card.problems.is_empty()
                }
        })
}

/// Whether `text` is one fenced code block: three or more backticks or
/// tildes open its first line, and the same character, at least as many and
/// alone on the line, closes its last line and no line before it.
fn fenced(text: &str) -> bool {
    let Some(mark) = text.chars().next().filter(|ch| matches!(ch, '`' | '~')) else {
        return false;
    };
    let mut lines = text.split('\n');
    let opening = lines.next().unwrap_or_default();
    let width = opening.chars().take_while(|ch| *ch == mark).count();
    // A backtick fence's info string has no backtick (CommonMark 4.5).
    if width < 3 || (mark == '`' && opening[width..].contains('`')) {
        return false;
    }
    let closes = |line: &str| line.len() >= width && line.chars().all(|ch| ch == mark);
    let mut lines = lines.peekable();
    while let Some(line) = lines.next() {
        if lines.peek().is_none() {
            return closes(line.trim_end());
        }
        if closes(line.trim()) {
            return false;
        }
    }
    false
}

/// `-->` as `--\>`, so text never ends the HTML comment it shares a line with.
fn comment_safe(text: &str) -> Cow<'_, str> {
    if text.contains("-->") {
        Cow::Owned(text.replace("-->", "--\\>"))
    } else {
        Cow::Borrowed(text)
    }
}

/// A page or journal day's title from `titles`, their text by ID, without
/// the title's tags.
fn display<'a>(id: &str, titles: &HashMap<&str, &'a str>) -> Option<Cow<'a, str>> {
    titles
        .get(id)
        .map(|text| tessera_core::display_title(text, |id| titles.get(id).copied()))
}

/// The field definition ID of a field entry's text, `[[ID]]` alone.
fn field_entry(text: &str) -> Option<&str> {
    let inner = text.trim().strip_prefix("[[")?.strip_suffix("]]")?;
    let id = inner.split_once('|').map_or(inner, |(id, _)| id);
    (!id.is_empty() && !id.contains(['[', ']'])).then_some(id)
}

/// The name of the option a choice value's text, `[[ID]]` alone, links among
/// its field's `options`, which `tessera_add_note` and `tessera_edit_block`
/// read back under the entry as the same link. A name no link can spell, or
/// that another option shares ignoring case, is left out so the ID stays.
fn option_name<'a>(text: &str, options: &'a [FieldOption]) -> Option<&'a str> {
    let id = text.strip_prefix("[[")?.strip_suffix("]]")?;
    let name = options.iter().find(|option| option.id == id)?.text.trim();
    let folded = name.to_lowercase();
    let shared = options
        .iter()
        .filter(|option| option.text.trim().to_lowercase() == folded)
        .count()
        > 1;
    (!shared && !name.is_empty() && !name.contains(['[', ']', '|', '\n', '\r'])).then_some(name)
}

/// The checkbox-style marker `outline` reads back as the same status.
pub fn marker(status: Option<TaskStatus>) -> &'static str {
    match status {
        Some(TaskStatus::Todo) => "[ ] ",
        Some(TaskStatus::Done) => "[x] ",
        Some(TaskStatus::Doing) => "[doing] ",
        Some(TaskStatus::Waiting) => "[waiting] ",
        Some(TaskStatus::Cancelled) => "[cancelled] ",
        None => "",
    }
}

/// Planning details in the words `tessera_set_task` takes.
pub fn task_details(task: &TaskState) -> Vec<String> {
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
pub fn repeat_text(repeat: &Repeater) -> String {
    let unit = match repeat.unit {
        RepeatUnit::Day => 'd',
        RepeatUnit::Week => 'w',
        RepeatUnit::Month => 'm',
        RepeatUnit::Year => 'y',
    };
    format!("{}{unit}", repeat.every)
}

/// Project, question, assessment, position, relation, source, revisit and
/// citation details. Citation quotes are passage text, shown as stored.
fn capability_details(caps: &BlockCapabilities, clock: &Clock) -> Vec<String> {
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
        part.push_str(&format!(
            " current answer {}",
            question.state.accepted.as_deref().unwrap_or("none")
        ));
        for decision in &question.state.reading_history {
            part.push_str(&format!(
                "; reading {} {} on {}",
                decision.assessment_id,
                name(decision.status),
                decision.on
            ));
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
        if let Some(key) = &source.citation_key {
            parts.push(format!("citation key {key}"));
        }
    }
    if let Some(note) = &caps.note {
        if let Some(day) = &note.revisit_on {
            parts.push(format!("revisit {day}"));
        }
        if let Some(at) = note.resolved_at {
            let mut part = format!("resolved {}", clock.date(at));
            if caps.note_changed {
                part.push_str(" (edited since)");
            }
            parts.push(part);
        }
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

/// A card's ID and revision, kind, template and scheduling state.
pub fn card_label(card: &CardUnit, clock: &Clock) -> String {
    let mut label = format!("card {} r{} {}", card.id, card.revision, name(card.kind));
    if card.kind == CardKind::Occlusion {
        label.push(' ');
        label.push_str(&tessera_core::occlusion::group_letter(
            card.occlusion_index.unwrap_or(0),
        ));
    }
    if let Some(template) = &card.template {
        label.push_str(&format!(" from template {:?}", template.name));
    }
    label.push(' ');
    label.push_str(&card_state(card, clock));
    label
}

/// Held, new, or the date it is next due.
pub fn card_state(card: &CardUnit, clock: &Clock) -> String {
    if card.held {
        "held".into()
    } else if card.schedule.last_reviewed_at.is_none() {
        "new".into()
    } else {
        format!("due {}", clock.date(card.schedule.due_at))
    }
}

pub fn card_front(card: &CardUnit) -> String {
    if card.kind == CardKind::Occlusion {
        format!(
            "occlusion {}",
            tessera_core::occlusion::group_letter(card.occlusion_index.unwrap_or(0))
        )
    } else {
        one_line(&card.front)
    }
}

/// A card's answer: its back, or for child-answer cards, whose back is
/// serialized data, their answer blocks.
pub fn card_answer(card: &CardUnit) -> String {
    if card.kind == CardKind::Occlusion {
        return serde_json::from_str::<tessera_core::occlusion::OcclusionBack>(&card.back)
            .ok()
            .and_then(|back| back.answer)
            .or_else(|| {
                serde_json::from_str::<tessera_core::occlusion::OcclusionFront>(&card.front)
                    .ok()
                    .and_then(|front| front.hint)
            })
            .map(|text| one_line(&text))
            .unwrap_or_default();
    }
    if !matches!(card.kind, CardKind::Multiline | CardKind::List) {
        return one_line(&card.back);
    }
    fn walk(blocks: &[tessera_core::CardAnswerBlock], out: &mut Vec<String>) {
        for block in blocks {
            out.push(match &block.image {
                Some(image) => {
                    format!("![{}](/api/images/{})", one_line(&block.text), image.sha256)
                }
                None => one_line(&block.text),
            });
            walk(&block.children, out);
        }
    }
    let mut parts = Vec::new();
    walk(&card.answer_blocks, &mut parts);
    parts.join(" / ")
}

/// An enum's serialized name, such as `catch_up`.
pub fn name<T: Serialize>(value: T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(name)) => name,
        _ => String::new(),
    }
}

/// Lines joined with ` / ` so a row stays one line.
pub fn one_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" / ")
}

/// The start of a text's first line.
pub fn snippet(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    match line.char_indices().nth(60) {
        Some((end, _)) => {
            // Keep canonical tokens whole so the output layer can resolve their
            // live titles instead of displaying a truncated identifier.
            let end = tessera_core::tag_tokens(line)
                .find(|token| token.span.start < end && end < token.span.end)
                .map_or(end, |token| token.span.end);
            format!("{}…", line[..end].trim_end())
        }
        None => line.to_owned(),
    }
}

/// `text` with its canonical tags as [`agent_tags`] writes them and its
/// references to the pages and journal days in `titles`, their text by ID,
/// showing the target's title without its tags, the `[[Title]]` that links
/// it again. Other references keep their ID.
pub fn titled(text: &str, titles: &HashMap<&str, &str>) -> String {
    let text = agent_tags(text, |id| titles.get(id).copied());
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for (span, target, _) in tessera_core::reference_spans(&text) {
        if !text[span.clone()].starts_with("[[") {
            continue;
        }
        let Some(title) = display(target, titles) else {
            continue;
        };
        out.push_str(&text[cursor..span.start + 2]);
        out.push_str(&title);
        cursor = span.start + 2 + target.len();
    }
    out.push_str(&text[cursor..]);
    out
}

/// Canonical tags as an agent writes them back: `#Title`, or `#[[Title]]`
/// when `#Title` would read back as another tag, as a multi-word title
/// would. `title` gives a tag page's text by ID, shown without its own tags;
/// for a page that is gone the authored alias, then the ID, stands in, as in
/// [`tessera_core::render_tags`]. Other tags and code stay as written.
pub fn agent_tags<'a, 'b>(
    text: &'a str,
    mut title: impl FnMut(&str) -> Option<&'b str>,
) -> Cow<'a, str> {
    let mut rewritten: Option<String> = None;
    let mut cursor = 0;
    for token in tessera_core::tag_tokens(text) {
        let Some(id) = token.id else { continue };
        let live = title(id).map(|page| tessera_core::display_title(page, &mut title));
        let label = match live.as_deref() {
            // A title no tag can spell keeps the authored alias.
            Some(label) if !label.is_empty() && !label.contains(['[', ']', '\n', '\r']) => label,
            _ if !token.title.is_empty() => token.title,
            _ => id,
        };
        let output = rewritten.get_or_insert_with(|| String::with_capacity(text.len()));
        output.push_str(&text[cursor..token.span.start]);
        cursor = token.span.end;
        // A tag runs on through the characters a bare tag may hold.
        let joined = text[cursor..]
            .chars()
            .next()
            .is_some_and(|next| tessera_core::bare_tag(next.encode_utf8(&mut [0; 4])));
        if tessera_core::bare_tag(label) && !joined {
            output.push('#');
            output.push_str(label);
        } else {
            output.push_str("#[[");
            output.push_str(label);
            output.push_str("]]");
        }
    }
    match rewritten {
        Some(mut output) => {
            output.push_str(&text[cursor..]);
            Cow::Owned(output)
        }
        None => Cow::Borrowed(text),
    }
}

pub fn quoted(pages: &[Block]) -> String {
    pages
        .iter()
        .map(|page| format!("{:?}", page.text))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn age(ms: i64) -> String {
    let minutes = ms.max(0) / 60_000;
    match minutes {
        0 => "just now".into(),
        1..60 => format!("{minutes} min ago"),
        60..2880 => format!("{} h ago", minutes / 60),
        _ => format!("{} days ago", minutes / 1440),
    }
}

pub fn kind_label(kind: BlockKind) -> &'static str {
    match kind {
        BlockKind::Journal => "journal day",
        _ => "atom",
    }
}

/// `on atom "Title" (id ID)`, naming where a block lives.
pub fn location(page: &Block) -> String {
    format!(
        "on {} {:?} (id {})",
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
    fn canonical_tags_use_live_titles_and_keep_missing_aliases_and_code() {
        let id = "00000000000000000000000001";
        let missing = "00000000000000000000000002";
        let titles = HashMap::from([(id, "Current title")]);
        assert_eq!(
            titled(
                &format!(
                    "#[[{id}|Old]] #[[{missing}|Lost]] #[[{missing}|]] `#[[{id}|Code]]` [[{id}|label|3.12]]"
                ),
                &titles
            ),
            format!(
                "#[[Current title]] #Lost #{missing} `#[[{id}|Code]]` [[Current title|label|3.12]]"
            )
        );
    }

    #[test]
    fn tags_read_back_as_the_same_tag_titles() {
        let marine = "00000000000000000000000001";
        let spring = "00000000000000000000000002";
        let plus = "00000000000000000000000003";
        let person = "00000000000000000000000004";
        let kind = "00000000000000000000000005";
        let missing = "00000000000000000000000006";
        let person_text = format!("Person #[[{kind}|kind]]");
        let titles = HashMap::from([
            (marine, "Marine"),
            (spring, "Spring cleaning"),
            (plus, "C++"),
            (person, person_text.as_str()),
            (kind, "Kind"),
        ]);
        let shown = titled(
            &format!(
                "Plan for #[[{spring}|Spring cleaning]] soon: #[[{marine}|m]], #[[{plus}|c]], \
                 #[[{person}|p]], #[[{missing}|Old name]], #[[{marine}|m]]s, #Legacy #[[Legacy words]]"
            ),
            &titles,
        );
        assert_eq!(
            shown,
            "Plan for #[[Spring cleaning]] soon: #Marine, #[[C++]], #Person, #[[Old name]], \
             #[[Marine]]s, #Legacy #[[Legacy words]]"
        );
        let read: Vec<&str> = tessera_core::tag_tokens(&shown)
            .map(|token| token.title)
            .collect();
        assert_eq!(
            read,
            [
                "Spring cleaning",
                "Marine",
                "C++",
                "Person",
                "Old name",
                "Marine",
                "Legacy",
                "Legacy words"
            ]
        );
    }

    #[test]
    fn links_show_the_target_title_without_its_tags() {
        let page = "00000000000000000000000001";
        let tag = "00000000000000000000000002";
        let text = format!("Charles Babbage #[[{tag}|person]]");
        let titles = HashMap::from([(page, text.as_str()), (tag, "Person")]);
        assert_eq!(
            titled(&format!("Then [[{page}|Babbage]] and [[{page}]]."), &titles),
            "Then [[Charles Babbage|Babbage]] and [[Charles Babbage]]."
        );
    }

    #[test]
    fn text_that_reads_as_structure_is_escaped_and_code_stays_fenced() {
        for (text, shown) in [
            (
                "Line one\n- Fake child <!-- X r1 -->\n# Fake heading -->\n<!-- open comment",
                "Line one\n  \\- Fake child <!-- X r1 --\\>\n  \\# Fake heading --\\>\n  <!-- open comment",
            ),
            ("## not a heading", "\\## not a heading"),
            // Tags and clozes are text.
            (
                "#tag first\n#\n####### seven\n#Tag:: no",
                "#tag first\n  \\#\n  ####### seven\n  #Tag:: no",
            ),
            (
                "Capital of France is {{c1::Paris}}\nThe {{c2::Seine::river}} too",
                "Capital of France is {{c1::Paris}}\n  The {{c2::Seine::river}} too",
            ),
            (
                "[ ] not a task\n[x]\n[doing] x\n[later] x",
                "\\[ ] not a task\n  \\[x]\n  \\[doing] x\n  [later] x",
            ),
            (
                "1. one\n2) two\n2026. year\n1234567890. no\n+ plus\n* star\n-\n-x\n> quote\n\\ slash\n\\frac",
                "\\1. one\n  \\2) two\n  \\2026. year\n  1234567890. no\n  \\+ plus\n  \\* star\n  \\-\n  -x\n  \\> quote\n  \\\\ slash\n  \\\\frac",
            ),
            (
                "a\n---\n***\n___\n- - -\n--\n--->",
                "a\n  \\---\n  \\***\n  \\___\n  \\- - -\n  \\--\n  ---\\>",
            ),
            (
                "a\nWhere:: Lisbon\nsee [[X]]:: no\n:: no",
                "a\n  \\Where:: Lisbon\n  see [[X]]:: no\n  :: no",
            ),
            (
                format!("a\n{}:: too long", "n".repeat(61)).as_str(),
                format!("a\n  {}:: too long", "n".repeat(61)).as_str(),
            ),
            ("a\n   # indented", "a\n     \\# indented"),
            ("-\r\nx", "\\-\r\n  x"),
            (
                "```rust\n- not an item\nKey:: value\n# not a heading\nx --> y\n```",
                "```rust\n  - not an item\n  Key:: value\n  # not a heading\n  x --\\> y\n  ```",
            ),
            ("~~~\n```\n~~~", "~~~\n  ```\n  ~~~"),
            ("````\n```\n````  ", "````\n  ```\n  ````  "),
            // Fences that do not close at the block's end are text.
            ("```\nunclosed\n- item", "\\```\n  unclosed\n  \\- item"),
            ("```\na\n```\nmore", "\\```\n  a\n  \\```\n  more"),
            ("```js``` is how\n```", "\\```js``` is how\n  \\```"),
        ] {
            assert_eq!(outline_text(text, "\n  "), shown, "{text:?}");
        }
    }

    #[test]
    fn details_show_the_revisit_date_and_resolution() {
        let mut caps: BlockCapabilities = serde_json::from_value(serde_json::json!({
            "block_id": "00000000000000000000000001",
            "merge_protected": false,
            "reviewed_cards": false,
            "note": { "resolved_at": 0, "revisit_on": "2026-11-02", "date_set_at": 0 },
            "note_changed": true,
        }))
        .unwrap();
        let clock = Clock {
            zone: jiff::tz::TimeZone::UTC,
            today: "2026-10-12".into(),
        };
        assert_eq!(
            capability_details(&caps, &clock),
            ["revisit 2026-11-02", "resolved 1970-01-01 (edited since)"]
        );
        caps.note_changed = false;
        caps.note = Some(tessera_core::NoteState::default());
        assert!(capability_details(&caps, &clock).is_empty());
    }

    #[test]
    fn page_render_reads_back_as_the_same_text_with_tags_links_and_quotes() {
        use tessera_core::{Actor, Batch, Notebook, Operation};
        let dir = tempfile::tempdir().unwrap();
        let mut nb = Notebook::open(dir.path()).unwrap();
        let id = |n| format!("{n:026}");
        let insert = |n: u32, text: &str, heading: Option<u8>| Operation::Insert {
            id: id(n),
            parent_id: id(2),
            after: (n > 3).then(|| id(n - 1)),
            text: text.into(),
            heading,
        };
        nb.apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![
                Operation::CreatePage {
                    id: id(1),
                    title: "Charles Babbage #person".into(),
                },
                Operation::CreatePage {
                    id: id(2),
                    title: "Reading list".into(),
                },
                insert(
                    3,
                    &format!("Then [[{}|Babbage]] and [[{}]].", id(1), id(1)),
                    None,
                ),
                insert(4, "Plan for #[[Spring cleaning]] soon", None),
                insert(5, "Line one\n- Fake child\n# Fake heading -->", None),
                insert(6, "Real heading", Some(2)),
                insert(7, "# hash task", None),
                Operation::SetTask {
                    id: id(7),
                    base_revision: 1,
                    task: Some(TaskState {
                        status: Some(TaskStatus::Todo),
                        ..TaskState::default()
                    }),
                },
                insert(8, "```rust\n- not an item\nKey:: value\n```", None),
            ],
        })
        .unwrap();
        let mut page = nb.page(&id(2)).unwrap();
        // A cited passage keeps its text as stored, tags and all.
        let tag = id(99);
        page.capabilities.push(
            serde_json::from_value(serde_json::json!({
                "block_id": id(3),
                "merge_protected": false,
                "reviewed_cards": false,
                "citations": [{
                    "id": id(90), "block_id": id(3), "source_id": id(91), "snapshot_id": id(92),
                    "start": { "passage_id": id(93), "offset": 0 },
                    "end": { "passage_id": id(93), "offset": 9 },
                    "quote": format!("cmd --> out #[[{tag}|Example]]"), "locator": "#p3",
                    "ordinal": 3, "triage": null, "color": null,
                }],
            }))
            .unwrap(),
        );
        let fields = Fields::default();
        let clock = Clock {
            zone: jiff::tz::TimeZone::UTC,
            today: "2026-10-12".into(),
        };
        let context = PageContext {
            fields: &fields,
            cards: &[],
            clock: &clock,
        };
        let output = render(&page, &context, None).unwrap();
        let rows: Vec<&str> = output
            .lines()
            .map(|line| line.split(" <!-- ").next().unwrap())
            .collect();
        assert_eq!(
            rows,
            [
                "# Reading list",
                "- Then [[Charles Babbage|Babbage]] and [[Charles Babbage]].",
                "- Plan for #[[Spring cleaning]] soon",
                "- Line one",
                "  \\- Fake child",
                "  \\# Fake heading --\\>",
                "- ## Real heading",
                "- [ ] \\# hash task",
                "- ```rust",
                "  - not an item",
                "  Key:: value",
                "  ```",
            ],
            "{output}"
        );
        assert!(
            output.contains(&format!(
                "cites “cmd --\\> out #[[{tag}|Example]]” at #p3 (passage {}) -->",
                id(93)
            )),
            "{output}"
        );
    }

    #[test]
    fn page_header_shows_the_root_task_and_revisit_state_and_journal_only_once_assessed() {
        use tessera_core::{Actor, Batch, Notebook, Operation, RevisitAction};
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
                title: "Kitchen".into(),
            },
            Operation::Insert {
                id: id(2),
                parent_id: id(1),
                after: None,
                text: "Is it worth it? #question".into(),
                heading: None,
            },
            Operation::Insert {
                id: id(3),
                parent_id: id(2),
                after: None,
                text: "Mostly".into(),
                heading: None,
            },
            Operation::SetTask {
                id: id(1),
                base_revision: 1,
                task: Some(TaskState {
                    status: Some(TaskStatus::Todo),
                    scheduled: Some("2026-11-03".into()),
                    ..TaskState::default()
                }),
            },
        ]))
        .unwrap();
        for (action, next_on) in [
            (RevisitAction::Resolve, None),
            (RevisitAction::Later, Some("2026-11-02".to_owned())),
        ] {
            nb.apply(&batch(vec![Operation::Revisit {
                id: id(1),
                base_revision: nb.block(&id(1)).unwrap().revision,
                action,
                next_on,
                event_id: None,
            }]))
            .unwrap();
        }
        let fields = Fields::default();
        let clock = Clock {
            zone: jiff::tz::TimeZone::UTC,
            today: "2026-10-12".into(),
        };
        let context = PageContext {
            fields: &fields,
            cards: &[],
            clock: &clock,
        };
        let mut page = nb.page(&id(1)).unwrap();
        assert!(
            page.capabilities
                .iter()
                .any(|caps| caps.block_id == id(2) && caps.question.is_some())
        );
        let output = render(&page, &context, None).unwrap();
        let header = output.lines().next().unwrap();
        assert!(
            header.contains(", status todo, scheduled 2026-11-03, "),
            "{header}"
        );
        assert!(
            header.contains(", revisit 2026-11-02, resolved 2"),
            "{header}"
        );
        assert!(!output.contains("Decision journal"), "{output}");
        page.capabilities.push(
            serde_json::from_value(serde_json::json!({
                "block_id": id(3),
                "merge_protected": false,
                "reviewed_cards": false,
                "assessment": {
                    "state": { "assessed_on": "2026-10-20", "aporia": false },
                    "question_id": id(2),
                    "accepted": true,
                },
            }))
            .unwrap(),
        );
        let output = render(&page, &context, None).unwrap();
        assert!(
            output.contains(&format!(
                "\nDecision journal for {}:\n- 2026-10-20 · current answer · Mostly [{}]\n",
                id(2),
                id(3)
            )),
            "{output}"
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
        let fields = Fields::default();
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
    fn page_render_titles_a_tagged_root_by_its_display_title_and_lists_the_tags() {
        use tessera_core::{Actor, Batch, Notebook, Operation};
        let dir = tempfile::tempdir().unwrap();
        let mut nb = Notebook::open(dir.path()).unwrap();
        let id = |n| format!("{n:026}");
        nb.apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![Operation::CreatePage {
                id: id(1),
                title: "Built in tag lab #project #stoic".into(),
            }],
        })
        .unwrap();
        let fields = Fields::default();
        let clock = Clock {
            zone: jiff::tz::TimeZone::UTC,
            today: "2026-10-18".into(),
        };
        let context = PageContext {
            fields: &fields,
            cards: &[],
            clock: &clock,
        };
        let output = render(&nb.page(&id(1)).unwrap(), &context, None).unwrap();
        let header = output.lines().next().unwrap();
        assert!(
            header.starts_with(&format!("# Built in tag lab <!-- {} r", id(1))),
            "{header}"
        );
        assert!(
            header.contains(", tags Project, stoic, project "),
            "{header}"
        );
        assert!(!output.contains("#["), "{output}");
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
        let fields = Fields::default();
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

    #[test]
    fn choice_values_show_their_option_by_name_where_it_reads_back() {
        use tessera_core::{
            Actor, AgentEdit, AgentRequest, Batch, NoteBlock, NoteTarget, Notebook, Operation,
        };
        let dir = tempfile::tempdir().unwrap();
        let mut nb = Notebook::open(dir.path()).unwrap();
        let receipt = nb
            .agent_edit(&AgentRequest {
                actor: Actor::Agent {
                    name: "test".into(),
                },
                reason: None,
                edit: AgentEdit::AddNote {
                    target: NoteTarget::Page {
                        title: "Attention".into(),
                    },
                    blocks: vec![NoteBlock {
                        text: "form:: paper".into(),
                        heading: None,
                        task: None,
                        children: Vec::new(),
                    }],
                },
            })
            .unwrap();
        let page = receipt.page.unwrap().id;
        let fields = Fields::from(nb.fields().unwrap());
        let form = fields
            .names
            .iter()
            .find(|(_, name)| *name == "form")
            .map(|(id, _)| id.clone())
            .unwrap();
        let paper = fields.choices[&form]
            .iter()
            .find(|option| option.text == "paper")
            .map(|option| option.id.clone())
            .unwrap();
        // Elsewhere an option is a block reference, which keeps its ID.
        let insert = |id: String, parent_id: &str, text: String| Operation::Insert {
            id,
            parent_id: parent_id.to_owned(),
            after: None,
            text,
            heading: None,
        };
        let batch = |operations| Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations,
        };
        nb.apply(&batch(vec![insert(
            format!("{:026}", 1),
            &page,
            format!("see [[{paper}]]"),
        )]))
        .unwrap();
        let clock = Clock {
            zone: jiff::tz::TimeZone::UTC,
            today: "2026-11-01".into(),
        };
        let rows = |nb: &Notebook, fields: &Fields| -> Vec<String> {
            let context = PageContext {
                fields,
                cards: &[],
                clock: &clock,
            };
            render(&nb.page(&page).unwrap(), &context, None)
                .unwrap()
                .lines()
                .map(|line| line.split(" <!-- ").next().unwrap().to_owned())
                .collect()
        };
        assert_eq!(
            rows(&nb, &fields),
            [
                "# Attention".to_owned(),
                format!("- see [[{paper}]]"),
                "- form::".to_owned(),
                "  - [[paper]]".to_owned(),
            ]
        );
        // The subtree under the value still knows its entry.
        let value = nb.page(&page).unwrap().rows[2].block.id.clone();
        let context = PageContext {
            fields: &fields,
            cards: &[],
            clock: &clock,
        };
        let subtree = render(&nb.page(&page).unwrap(), &context, Some(&value)).unwrap();
        assert!(subtree.contains("\n- [[paper]] <!-- "), "{subtree}");
        // A name another option shares would read back as the first of them.
        nb.apply(&batch(vec![insert(
            format!("{:026}", 2),
            &form,
            "Paper ".into(),
        )]))
        .unwrap();
        let fields = Fields::from(nb.fields().unwrap());
        assert_eq!(rows(&nb, &fields)[3], format!("  - [[{paper}]]"));
    }

    #[test]
    fn occlusion_text_names_the_group_and_answer_without_serialized_sides() {
        let mut card: CardUnit = serde_json::from_value(serde_json::json!({
            "id": "card", "source_block_id": "source", "key": "occlusion:group",
            "kind": "occlusion", "active": true, "held": false, "definition_revision": 1,
            "front": serde_json::json!({
                "image": { "sha256": "a".repeat(64), "media_type": "image/png", "width": 800, "height": 600 },
                "mode": "hide_one", "tested": [{"shape": "rect", "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}],
                "hint": "Hint", "covered": []
            }).to_string(),
            "back": "{\"answer\":\"Answer\"}", "answer_blocks": [], "revision": 3,
            "schedule": tessera_core::scheduler::new_card(0), "occlusion_index": 1
        })).unwrap();
        let clock = Clock {
            zone: jiff::tz::TimeZone::UTC,
            today: "2026-10-16".into(),
        };
        assert_eq!(card_front(&card), "occlusion B");
        // The card's own revision, which tessera_hold_card checks, not its block's.
        assert_eq!(card_label(&card, &clock), "card card r3 occlusion B new");
        assert_eq!(card_answer(&card), "Answer");
        card.back = "{}".into();
        assert_eq!(card_answer(&card), "Hint");
    }
}
