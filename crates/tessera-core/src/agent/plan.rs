//! Planning an agent edit into operations and an inverse.

use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, params};

use super::request::{AgentCitation, BlockTarget, NOTE_LIMIT, OutlineBlock, TITLE_LIMIT};
use crate::history::Step;
use crate::notebook::{new_ulid, now_ms};
use crate::storage::{validate_date, validate_id, validation};
use crate::{
    Block, BlockKind, CardQuery, Error, FieldKind, FieldOption, Operation, Result, TaskState,
    TaskStatus, Workshop,
};

#[derive(Default)]
pub(super) struct Plan {
    pub(super) operations: Vec<Operation>,
    pub(super) steps: Vec<Step>,
    /// Pages resolved or created for this batch, by lowercase title.
    pub(super) titles: HashMap<String, String>,
    /// Pages a `[[Name]]` reached by alias or another spelling of their title,
    /// by folded name.
    pub(super) names: HashMap<String, String>,
    pub(super) created: Vec<String>,
    /// Live and newly created field definitions, keyed by lowercase name.
    pub(super) fields: Option<HashMap<String, String>>,
    /// Choice fields by definition ID, with their name and live options.
    pub(super) choices: HashMap<String, (String, Vec<FieldOption>)>,
    /// Fields whose values must read as their kind, by definition ID, with
    /// their name and kind.
    pub(super) checked: HashMap<String, (String, FieldKind)>,
    pub(super) created_fields: Vec<String>,
    /// Option atoms of created definitions, removed with them by undo.
    pub(super) options: Vec<String>,
    pub(super) inserted: Vec<String>,
    pub(super) removable: Vec<String>,
    pub(super) changed: Vec<String>,
    pub(super) saved_decks: Vec<String>,
    /// The revision the next operation on each touched block is based on.
    pub(super) revisions: HashMap<String, i64>,
}

impl Plan {
    pub(super) fn create_page(&mut self, title: &str) -> Result<String> {
        page_title(title)?;
        let id = new_ulid().to_string();
        self.operations.push(Operation::CreatePage {
            id: id.clone(),
            title: title.to_owned(),
        });
        self.titles
            .insert(crate::storage::title_key(title), id.clone());
        self.created.push(id.clone());
        Ok(id)
    }
}

/// The base revision for the next operation on `id`, which bumps it.
pub(super) fn next_revision(revisions: &mut HashMap<String, i64>, id: &str) -> i64 {
    let revision = revisions
        .get_mut(id)
        .expect("touched blocks start with a revision");
    *revision += 1;
    *revision - 1
}

impl Workshop {
    pub(super) fn plan_blocks_edit(
        &self,
        plan: &mut Plan,
        target: &BlockTarget,
        blocks: &[OutlineBlock],
    ) -> Result<(String, String)> {
        if blocks.is_empty() {
            return Err(validation("a capture must contain an atom"));
        }
        if note_size(blocks) > NOTE_LIMIT {
            return Err(validation(format!(
                "a note can add at most {NOTE_LIMIT} atoms, counting nested ones; split it into several notes"
            )));
        }
        let mut tagged = Vec::new();
        let mut values = None;
        let (page_id, parent_id, after, title) = match target {
            BlockTarget::Page { title } => {
                let title = title.trim();
                page_title(title)?;
                if crate::storage::title_key(title) == "fields" {
                    return Err(fields_target());
                }
                let page = match self.named_page(title)? {
                    crate::aliases::Named::Title(page) => {
                        plan.titles
                            .insert(crate::storage::title_key(title), page.id.clone());
                        Some(page)
                    }
                    // A link with the same wording in the note keeps it, as
                    // `[[Name]]` does when it reaches a page by another name.
                    crate::aliases::Named::Folded(page) => {
                        plan.names
                            .insert(crate::aliases::fold(title), page.id.clone());
                        Some(page)
                    }
                    crate::aliases::Named::Several(matches) => {
                        return Err(self.ambiguous_name(title, &matches)?);
                    }
                    crate::aliases::Named::None => None,
                };
                match page {
                    Some(page) => {
                        if crate::fields::page_id(&self.conn)?.as_deref() == Some(page.id.as_str())
                        {
                            return Err(fields_target());
                        }
                        tagged = self.plan_tags(plan, &page, title)?;
                        let after = self.last_child(&page.id, &page.id)?;
                        (page.id.clone(), page.id, after, page.text)
                    }
                    None => {
                        let id = plan.create_page(title)?;
                        (id.clone(), id, None, title.to_owned())
                    }
                }
            }
            BlockTarget::Journal { date } => {
                let date = match date {
                    Some(date) => {
                        validate_date(date)?;
                        date.clone()
                    }
                    None => self.today(now_ms())?,
                };
                match self.journal(&date)? {
                    Some(day) => {
                        let after = self.last_child(&day.id, &day.id)?;
                        (day.id.clone(), day.id, after, date)
                    }
                    None => {
                        let id = new_ulid().to_string();
                        plan.operations.push(Operation::CreateJournal {
                            id: id.clone(),
                            date: date.clone(),
                        });
                        plan.created.push(id.clone());
                        (id.clone(), id, None, date)
                    }
                }
            }
            BlockTarget::Block { id } => {
                let block = self.block(id)?;
                if crate::fields::page_id(&self.conn)?.as_deref() == Some(block.page_id.as_str()) {
                    return Err(fields_target());
                }
                let after = self.last_child(&block.page_id, &block.id)?;
                let title = self.block(&block.page_id)?.text;
                values = self.choice_entry(plan, &block)?;
                (block.page_id, block.id, after, title)
            }
        };
        self.plan_blocks(plan, &parent_id, after, blocks, true, values.as_deref())?;
        let count = plan.inserted.len();
        let mut summary = format!(
            "Added {count} atom{} to {title}",
            if count == 1 { "" } else { "s" }
        );
        if !tagged.is_empty() {
            summary.push_str(" and tagged it ");
            summary.push_str(&listed(&tagged));
        }
        Ok((page_id, summary))
    }

    /// File an existing page under the tags its target title gives, as
    /// creating the page with that title would: each tag the page is not
    /// yet filed under is appended to its title as written. Tags never
    /// change a page's name, so this is not a rename. Returns those tags.
    fn plan_tags<'a>(&self, plan: &mut Plan, page: &Block, title: &'a str) -> Result<Vec<&'a str>> {
        let mut seen = HashSet::new();
        let mut missing = Vec::new();
        for token in crate::tag_tokens(title) {
            let key = crate::storage::title_key(token.title);
            let type_id = match token.id {
                Some(id) => crate::storage::live_tag(&self.conn, id)?.map(|_| id.to_owned()),
                None => crate::storage::resolve_type(
                    &self.conn,
                    token.title,
                    &key,
                    None,
                    &mut Vec::new(),
                )?,
            };
            let filed = match &type_id {
                // A page is never filed under itself.
                Some(type_id) => {
                    *type_id == page.id
                        || self.conn.query_row(
                            "SELECT EXISTS(SELECT 1 FROM memberships WHERE block_id = ?1 AND type_id = ?2)",
                            params![page.id, type_id],
                            |row| row.get(0),
                        )?
                }
                None => false,
            };
            if seen.insert(type_id.unwrap_or(key)) && !filed {
                missing.push(&title[token.span]);
            }
        }
        if !missing.is_empty() {
            touch(plan, page, None);
            plan_text(
                plan,
                page,
                format!("{} {}", page.text.trim_end(), missing.join(" ")),
            );
            plan.changed.push(page.id.clone());
        }
        Ok(missing)
    }

    /// Plan `blocks` under `parent_id`. When the parent is an entry of the
    /// choice field `values`, each block is one of its values and links the
    /// option it names, as the entry's shorthand value does.
    fn plan_blocks(
        &self,
        plan: &mut Plan,
        parent_id: &str,
        mut after: Option<String>,
        blocks: &[OutlineBlock],
        top: bool,
        values: Option<&str>,
    ) -> Result<()> {
        for block in blocks {
            let id = new_ulid().to_string();
            let (text, entry) = match values {
                Some(field) => (self.value_text(plan, field, &block.text)?, None),
                None => self.note_text(plan, &block.text)?,
            };
            plan.operations.push(Operation::Insert {
                id: id.clone(),
                parent_id: parent_id.to_owned(),
                after: after.replace(id.clone()),
                text,
                heading: block.heading,
            });
            plan.inserted.push(id.clone());
            if top {
                plan.removable.push(id.clone());
            }
            if block.task.is_some() {
                plan.revisions.insert(id.clone(), 1);
                self.plan_task(plan, &id, None, block.task.clone(), false)?;
            }
            let value_id = self.plan_value(plan, &id, entry.as_ref(), false)?;
            let choice = entry
                .as_ref()
                .map(|entry| entry.field.as_str())
                .filter(|field| plan.choices.contains_key(*field));
            self.plan_blocks(plan, &id, value_id, &block.children, false, choice)?;
        }
        Ok(())
    }

    pub(super) fn plan_edit(
        &self,
        plan: &mut Plan,
        id: &str,
        revision: Option<i64>,
        text: Option<&str>,
        heading: Option<u8>,
    ) -> Result<(String, String)> {
        let block = self.block(id)?;
        if block.kind != BlockKind::Block && heading.is_some_and(|level| level != 0) {
            return Err(validation(
                "a page or journal title cannot be a heading; set the heading on an atom inside it",
            ));
        }
        touch(plan, &block, revision);
        if let Some(text) = text {
            if block.kind == BlockKind::Block {
                let current = match crate::fields::reference(&block.text) {
                    Some(field) if crate::fields::is_definition(&self.conn, field)? => Some(field),
                    _ => None,
                };
                // A value under a choice entry links the option it names.
                let values = match (current, &block.parent_id) {
                    (None, Some(parent)) => self.choice_entry(plan, &self.block(parent)?)?,
                    _ => None,
                };
                let (linked, entry) = match &values {
                    Some(field) => (self.value_text(plan, field, text)?, None),
                    None => self.note_text(plan, text)?,
                };
                match (current, &entry) {
                    (Some(current), Some(entry)) if current != entry.field => {
                        return Err(validation(format!(
                            "this atom is the {} entry and cannot change to {}; delete it and write `{}:: …` as a new atom, or edit its value atom instead",
                            self.block(current)?.text,
                            entry.name,
                            entry.name
                        )));
                    }
                    (Some(_), Some(entry)) => {
                        self.plan_entry_value(plan, &block, revision, entry)?
                    }
                    _ => {
                        self.plan_value(plan, id, entry.as_ref(), true)?;
                        plan_text(plan, &block, linked);
                    }
                }
            } else {
                if block.kind == BlockKind::Page {
                    page_title(text.trim())?;
                }
                plan_text(plan, &block, text.to_owned());
            }
        }
        if let Some(level) = heading {
            let heading = (level != 0).then_some(level);
            if heading != block.heading {
                plan.operations.push(Operation::SetHeading {
                    id: id.to_owned(),
                    base_revision: next_revision(&mut plan.revisions, id),
                    heading,
                });
                plan.steps.push(Step::Heading {
                    id: id.to_owned(),
                    heading: block.heading,
                });
            }
        }
        if plan.steps.is_empty() && plan.inserted.is_empty() {
            return Err(validation(
                "nothing to change: the atom already reads that way",
            ));
        }
        plan.changed.push(id.to_owned());
        let summary = match (block.kind, text) {
            (BlockKind::Page, Some(text)) if text != block.text => {
                format!("Renamed {} to {text}", block.text)
            }
            _ => format!(
                "Edited “{}” on {}",
                snippet(&self.readable(text.unwrap_or(&block.text))?),
                self.block(&block.page_id)?.text
            ),
        };
        Ok((block.page_id, summary))
    }

    pub(super) fn plan_card_held(
        &self,
        plan: &mut Plan,
        card_id: &str,
        revision: Option<i64>,
        held: bool,
    ) -> Result<(String, String)> {
        let card = self.card(card_id)?;
        if let Some(expected) = revision
            && expected != card.revision
        {
            return Err(Error::Conflict {
                op_index: plan.operations.len(),
                what: "card",
                id: card_id.to_owned(),
                expected,
                found: Some(card.revision),
            });
        }
        if !card.active {
            return Err(validation("inactive cards cannot be held or released"));
        }
        if card.held == held {
            return Err(validation(if held {
                "nothing to change: the card is already held"
            } else {
                "nothing to change: the card is already released"
            }));
        }
        let block = self.block(&card.source_block_id)?;
        let page = self.block(&block.page_id)?;
        plan.operations.push(Operation::SetCardHeld {
            id: card_id.to_owned(),
            base_revision: card.revision,
            held,
        });
        plan.steps.push(Step::CardHeld {
            id: card_id.to_owned(),
            held: card.held,
        });
        Ok((
            page.id,
            format!(
                "{} card “{}” on {}",
                if held { "Held" } else { "Released" },
                snippet(&card.front),
                page.text
            ),
        ))
    }

    pub(super) fn plan_save_deck(
        &self,
        plan: &mut Plan,
        id: Option<&str>,
        revision: Option<i64>,
        name: &str,
        query: &CardQuery,
    ) -> Result<String> {
        let existing = id.map(|id| self.deck(id)).transpose()?;
        if existing.is_none() && revision.is_some() {
            return Err(validation(
                "revision applies only to an existing deck; give the deck's id, or leave revision out to create a deck",
            ));
        }
        let trimmed = name.trim();
        if let Some(deck) = &existing
            && deck.name == trimmed
            && deck.query == *query
        {
            return Err(validation(format!(
                "nothing to change: deck {} already has that name and query",
                deck.name
            )));
        }
        // Keeping a name that already matches another deck lets an older
        // duplicate still be saved; taking such a name is refused.
        let folded = trimmed.to_lowercase();
        if existing
            .as_ref()
            .is_none_or(|deck| deck.name.to_lowercase() != folded)
            && let Some(other) = self.decks()?.into_iter().find(|deck| {
                deck.name.to_lowercase() == folded
                    && existing.as_ref().is_none_or(|own| own.id != deck.id)
            })
        {
            return Err(validation(format!(
                "a deck named {} already exists ({}); choose another name, or save that deck by its id",
                other.name, other.id
            )));
        }
        let (id, base_revision, summary) = if let Some(deck) = existing {
            let base_revision = revision.unwrap_or(deck.revision);
            plan.steps.push(Step::DeckSaved {
                id: deck.id.clone(),
                name: deck.name,
                query: deck.query,
            });
            (
                deck.id,
                Some(base_revision),
                format!("Saved deck {trimmed}"),
            )
        } else {
            let id = new_ulid().to_string();
            plan.steps.push(Step::DeckCreated { id: id.clone() });
            (id, None, format!("Created deck {trimmed}"))
        };
        plan.operations.push(Operation::SaveDeck {
            id: id.clone(),
            base_revision,
            name: name.to_owned(),
            query: query.clone(),
        });
        plan.saved_decks.push(id);
        Ok(summary)
    }

    pub(super) fn plan_delete_deck(
        &self,
        plan: &mut Plan,
        id: &str,
        revision: Option<i64>,
    ) -> Result<String> {
        let deck = self.deck(id)?;
        let summary = format!("Deleted deck {} ({})", deck.name, deck.id);
        plan.operations.push(Operation::DeleteDeck {
            id: id.to_owned(),
            base_revision: revision.unwrap_or(deck.revision),
        });
        plan.steps.push(Step::DeckDeleted {
            id: deck.id,
            name: deck.name,
            query: deck.query,
        });
        Ok(summary)
    }

    pub(super) fn plan_citations(
        &self,
        plan: &mut Plan,
        citations: &[AgentCitation],
    ) -> Result<(String, String)> {
        if citations.is_empty() {
            return Err(validation("a cite change must contain a citation"));
        }
        let mut pages: Vec<Block> = Vec::new();
        // The passage ordinals each snapshot's citations cover, to count each passage once.
        let mut covered: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
        let mut planned = HashSet::new();
        for citation in citations {
            let block = self.block(&citation.block_id)?;
            if let Some(expected) = citation.revision
                && expected != block.revision
            {
                return Err(Error::Conflict {
                    op_index: plan.operations.len(),
                    what: "atom",
                    id: block.id,
                    expected,
                    found: Some(block.revision),
                });
            }
            if !pages.iter().any(|page| page.id == block.page_id) {
                pages.push(self.block(&block.page_id)?);
            }
            if !plan.revisions.contains_key(&block.id) {
                touch(plan, &block, citation.revision);
                plan.changed.push(block.id.clone());
            }
            if citation.quote.is_some() && citation.end_passage_id.is_some() {
                return Err(validation("give quote or end_passage_id, not both"));
            }
            if citation.quote.as_deref() == Some("") {
                return Err(validation(
                    "quote is empty; leave quote out to cite the whole passage",
                ));
            }
            let first = self.passage(&citation.passage_id)?;
            let snapshot: String = self.conn.query_row(
                "SELECT snapshot_id FROM passages WHERE id = ?1",
                [&first.id],
                |row| row.get(0),
            )?;
            let (start_offset, end_id, end_offset, last_ordinal) =
                if let Some(quote) = &citation.quote {
                    let offset = first.text.find(quote).ok_or_else(|| {
                        validation(format!("quote not found in passage {}", first.id))
                    })?;
                    (
                        first.text[..offset].encode_utf16().count(),
                        first.id.clone(),
                        first.text[..offset + quote.len()].encode_utf16().count(),
                        first.ordinal,
                    )
                } else {
                    let last = citation
                        .end_passage_id
                        .as_deref()
                        .filter(|id| *id != first.id)
                        .map(|id| self.passage(id))
                        .transpose()?;
                    if let Some(last) = &last {
                        let last_snapshot: String = self.conn.query_row(
                            "SELECT snapshot_id FROM passages WHERE id = ?1",
                            [&last.id],
                            |row| row.get(0),
                        )?;
                        if snapshot != last_snapshot {
                            return Err(validation("citation passages must share one snapshot"));
                        }
                    }
                    let last = last.as_ref().unwrap_or(&first);
                    (
                        0,
                        last.id.clone(),
                        last.text.encode_utf16().count(),
                        last.ordinal,
                    )
                };
            let start_offset = u32::try_from(start_offset)
                .map_err(|_| validation("citation offset exceeds UTF-16 range"))?;
            let end_offset = u32::try_from(end_offset)
                .map_err(|_| validation("citation offset exceeds UTF-16 range"))?;
            let duplicate = !planned.insert((
                block.id.clone(),
                first.id.clone(),
                start_offset,
                end_id.clone(),
                end_offset,
            )) || self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM citations WHERE block_id = ?1 AND active = 1
                     AND start_passage = ?2 AND start_offset = ?3 AND end_passage = ?4 AND end_offset = ?5)",
                params![block.id, first.id, start_offset, end_id, end_offset],
                |row| row.get::<_, bool>(0),
            )?;
            if duplicate {
                return Err(validation(format!(
                    "nothing to change: atom {} already has this citation",
                    block.id
                )));
            }
            covered.entry(snapshot.clone()).or_default().push((
                first.ordinal.min(last_ordinal),
                first.ordinal.max(last_ordinal),
            ));
            let citation_id = new_ulid().to_string();
            plan.operations.push(Operation::Cite {
                id: block.id.clone(),
                base_revision: next_revision(&mut plan.revisions, &block.id),
                citation_id: citation_id.clone(),
                snapshot_id: snapshot,
                start: crate::library::PassagePoint {
                    passage_id: first.id,
                    offset: start_offset,
                },
                end: crate::library::PassagePoint {
                    passage_id: end_id,
                    offset: end_offset,
                },
                color: None,
            });
            plan.steps.push(Step::Uncite {
                id: block.id,
                citation_id,
            });
        }
        let count: i64 = covered
            .into_values()
            .map(|mut ranges| {
                ranges.sort_unstable();
                let (mut count, mut end) = (0, i64::MIN);
                for (from, through) in ranges {
                    let from = from.max(end.saturating_add(1));
                    if through >= from {
                        count += through - from + 1;
                    }
                    end = end.max(through);
                }
                count
            })
            .sum();
        let titles: Vec<&str> = pages.iter().map(|page| page.text.as_str()).collect();
        Ok((
            pages[0].id.clone(),
            format!(
                "Cited {count} passage{} on {}",
                if count == 1 { "" } else { "s" },
                listed(&titles)
            ),
        ))
    }

    pub(super) fn plan_move(
        &self,
        plan: &mut Plan,
        id: &str,
        revision: Option<i64>,
        parent_id: Option<&str>,
        after: Option<&str>,
        first: bool,
    ) -> Result<(String, String)> {
        let block = self.block(id)?;
        let Some(old_parent) = block.parent_id.clone() else {
            return Err(validation("a titled atom cannot be moved"));
        };
        let (parent, after) = match (parent_id, after, first) {
            (_, Some(_), true) => return Err(validation("give after or first, not both")),
            (parent, Some(after), false) => {
                let sibling = self.block(after)?;
                let sibling_parent = sibling.parent_id.ok_or_else(|| {
                    validation("an atom cannot be placed beside the outline's root")
                })?;
                if parent.is_some_and(|parent| parent != sibling_parent) {
                    return Err(validation("after must be a child of parent_id"));
                }
                (sibling_parent, Some(after.to_owned()))
            }
            (Some(parent), None, true) => (parent.to_owned(), None),
            (None, None, true) => (old_parent.clone(), None),
            (Some(parent), None, false) => {
                let page = self.block(parent)?.page_id;
                (parent.to_owned(), self.last_child(&page, parent)?)
            }
            (None, None, false) => return Err(validation("give parent_id, after or first")),
        };
        let old_after = self.previous_sibling(&block)?;
        if after.as_deref() == Some(id) || (parent == old_parent && after == old_after) {
            return Err(validation("nothing to change: the atom is already there"));
        }
        touch(plan, &block, revision);
        plan.operations.push(Operation::Move {
            id: id.to_owned(),
            base_revision: next_revision(&mut plan.revisions, id),
            parent_id: parent.clone(),
            after,
        });
        plan.steps.push(Step::Move {
            id: id.to_owned(),
            parent_id: old_parent,
            after: old_after,
        });
        plan.changed.push(id.to_owned());
        let page = self.block(&self.block(&parent)?.page_id)?;
        let summary = format!(
            "Moved “{}” to {}",
            snippet(&self.readable(&block.text)?),
            page.text
        );
        Ok((page.id, summary))
    }

    /// `text` with references shown as their alias or their target's text.
    pub(super) fn readable(&self, text: &str) -> Result<String> {
        let mut shown = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find("[[") {
            let Some(end) = rest[start + 2..].find("]]") else {
                break;
            };
            let reference = &rest[start + 2..start + 2 + end];
            let (target, alias, locator) = crate::storage::reference_parts(reference);
            let label = match alias.filter(|alias| !alias.is_empty()) {
                Some(alias) => Some(alias.to_owned()),
                None if validate_id(target).is_ok() => {
                    self.live_block(target)?.map(|block| block.text)
                }
                None => None,
            };
            shown.push_str(&rest[..start]);
            shown.push_str(label.as_deref().unwrap_or(&rest[start..start + 4 + end]));
            if label.is_some()
                && let Some(locator) = locator.filter(|locator| !locator.is_empty())
            {
                shown.push('\u{2009}');
                shown.push_str(locator);
            }
            rest = &rest[start + 4 + end..];
        }
        shown.push_str(rest);
        Ok(shown)
    }

    /// Operations taking a task from `current` to `target`; `record` adds
    /// their inverses. Returns the summary verb.
    pub(super) fn plan_task(
        &self,
        plan: &mut Plan,
        id: &str,
        current: Option<TaskState>,
        target: Option<TaskState>,
        record: bool,
    ) -> Result<String> {
        if current == target {
            return Err(validation(
                "nothing to change: the task already has that state",
            ));
        }
        let set = |plan: &mut Plan, before: Option<TaskState>, after: Option<TaskState>| {
            plan.operations.push(Operation::SetTask {
                id: id.to_owned(),
                base_revision: next_revision(&mut plan.revisions, id),
                task: after.clone(),
            });
            if record {
                plan.steps.push(Step::Task {
                    id: id.to_owned(),
                    states: Box::new((before, after)),
                });
            }
        };
        let Some(target) = target else {
            set(plan, current, None);
            return Ok("Removed the task from".into());
        };
        let finishing = target.status == Some(TaskStatus::Done)
            && current
                .as_ref()
                .is_none_or(|current| current.status != Some(TaskStatus::Done));
        if !finishing {
            let verb = match target.status {
                Some(status)
                    if current
                        .as_ref()
                        .is_some_and(|current| current.status == Some(status)) =>
                {
                    "Updated the task".to_owned()
                }
                Some(status) => format!("Set to {}", status_name(status)),
                None => "Scheduled".to_owned(),
            };
            set(plan, current, Some(target));
            return Ok(verb);
        }
        if current.as_ref().is_some_and(|task| task.status.is_none()) {
            return Err(validation("Add #task before completing."));
        }
        let open = TaskState {
            status: Some(match current.as_ref().and_then(|current| current.status) {
                Some(status @ (TaskStatus::Doing | TaskStatus::Waiting)) => status,
                _ => TaskStatus::Todo,
            }),
            completed_on: None,
            ..target.clone()
        };
        if current.as_ref() != Some(&open) {
            set(plan, current, Some(open));
        }
        let occurrence_id = new_ulid().to_string();
        plan.operations.push(Operation::CompleteTask {
            id: id.to_owned(),
            base_revision: next_revision(&mut plan.revisions, id),
            occurrence_id: occurrence_id.clone(),
            completed_on: match target.completed_on {
                Some(date) => date,
                None => self.today(now_ms())?,
            },
        });
        if record {
            plan.steps.push(Step::Uncomplete {
                id: id.to_owned(),
                occurrence_id,
            });
        }
        Ok("Completed".into())
    }

    fn previous_sibling(&self, block: &Block) -> Result<Option<String>> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT s.id FROM blocks s JOIN blocks b ON b.id = ?1
                 WHERE s.parent_id = b.parent_id AND s.deletion_id IS NULL
                   AND (s.ordinal, s.id) < (b.ordinal, b.id)
                 ORDER BY s.ordinal DESC, s.id DESC LIMIT 1",
            )?
            .query_row([&block.id], |row| row.get(0))
            .optional()?)
    }

    pub(super) fn first_child(&self, parent_id: &str) -> Result<Option<Block>> {
        let id: Option<String> = self
            .conn
            .prepare_cached(
                "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
                 ORDER BY ordinal, id LIMIT 1",
            )?
            .query_row([parent_id], |row| row.get(0))
            .optional()?;
        id.map(|id| self.block(&id)).transpose()
    }

    /// The last live child of `parent_id`, which lives on `page_id`.
    pub(super) fn last_child(&self, page_id: &str, parent_id: &str) -> Result<Option<String>> {
        let page = self.page(page_id)?;
        let (start, depth) = if parent_id == page_id {
            (0, 0)
        } else {
            let index = page
                .rows
                .iter()
                .position(|row| row.block.id == parent_id)
                .ok_or_else(|| crate::storage::not_found(parent_id))?;
            (index + 1, page.rows[index].depth + 1)
        };
        let mut last = None;
        for row in &page.rows[start..] {
            if row.depth < depth {
                break;
            }
            if row.depth == depth {
                last = Some(&row.block.id);
            }
        }
        Ok(last.cloned())
    }

    /// Rewrite `[[Title]]` to `[[id]]` for the live page with that title, or
    /// to `[[id|Title]]` for the one page with that name or alias, creating it
    /// when missing, and keep any `|alias|locator`. A date names a journal day
    /// and stays as written when that day does not exist. ID references and
    /// `#[[Tag]]` tags are left alone.
    pub(super) fn link_titles(&self, plan: &mut Plan, text: &str) -> Result<String> {
        let mut linked = String::with_capacity(text.len());
        let mut rest = text;
        let mut code = crate::storage::inline_code_spans(text).peekable();
        while let Some(start) = rest.find("[[") {
            let absolute_start = text.len() - rest.len() + start;
            while code.peek().is_some_and(|span| span.end <= absolute_start) {
                code.next();
            }
            let in_code = code.peek().is_some_and(|span| span.start <= absolute_start);
            let (before, opened) = rest.split_at(start);
            let Some(end) = opened[2..].find("]]") else {
                break;
            };
            let reference = &opened[2..2 + end];
            let tag = before.strip_suffix('#').is_some_and(|prefix| {
                prefix
                    .chars()
                    .next_back()
                    .is_none_or(|ch| !crate::storage::bare_tag_character(ch))
            });
            let (target, alias, locator) = crate::storage::reference_parts(reference);
            let title = target.trim();
            let resolved = if in_code
                || tag
                || title.is_empty()
                || target
                    .get(..8)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
                || target
                    .get(..7)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
                || title.contains(['[', ']', '\n', '\r'])
                || alias.is_some_and(|alias| alias.contains(']'))
                || validate_id(target).is_ok()
                || target
                    .strip_prefix("view:")
                    .is_some_and(|id| validate_id(id).is_ok())
            {
                None
            } else {
                self.title_target(plan, title)?
            };
            linked.push_str(before);
            match resolved {
                Some((id, renamed)) => {
                    linked.push_str("[[");
                    linked.push_str(&id);
                    // A page reached by another name keeps the typed wording.
                    let label = if renamed && alias.is_none_or(str::is_empty) {
                        Some(title)
                    } else {
                        alias
                    };
                    if let Some(label) = label {
                        linked.push('|');
                        linked.push_str(label);
                    }
                    if let Some(locator) = locator {
                        linked.push('|');
                        linked.push_str(locator);
                    }
                    linked.push_str("]]");
                }
                None => linked.push_str(&opened[..2 + end + 2]),
            }
            rest = &opened[2 + end + 2..];
        }
        linked.push_str(rest);
        Ok(linked)
    }

    /// The page a hand-typed `[[Name]]` links, found as the editor finds it: a
    /// journal day for a date; the page with that title; else the one page
    /// whose title or alias matches ignoring case, diacritics and
    /// punctuation, marked `true` so the link keeps the typed name; else a
    /// new page. A name several pages share is refused with their IDs rather
    /// than guessed or duplicated.
    fn title_target(&self, plan: &mut Plan, title: &str) -> Result<Option<(String, bool)>> {
        let key = crate::storage::title_key(title);
        if let Some(id) = plan.titles.get(&key) {
            return Ok(Some((id.clone(), false)));
        }
        if date_shaped(title) {
            return Ok(match validate_date(title) {
                Ok(()) => self.journal(title)?.map(|day| (day.id, false)),
                Err(_) => None,
            });
        }
        if let Some(page) = self.page_by_title(title)? {
            plan.titles.insert(key, page.id.clone());
            return Ok(Some((page.id, false)));
        }
        let name = crate::aliases::fold(title);
        if let Some(id) = plan.names.get(&name) {
            return Ok(Some((id.clone(), true)));
        }
        let id = match self.folded_page(title)? {
            crate::aliases::Named::None => {
                // A page this change creates is not stored yet, so match it here.
                let created = plan
                    .titles
                    .iter()
                    .find(|(known, id)| {
                        !name.is_empty()
                            && plan.created.contains(id)
                            && crate::aliases::fold(known) == name
                    })
                    .map(|(_, id)| id.clone());
                match created {
                    Some(id) => id,
                    None => return plan.create_page(title).map(|id| Some((id, false))),
                }
            }
            crate::aliases::Named::Title(page) | crate::aliases::Named::Folded(page) => page.id,
            crate::aliases::Named::Several(matches) => {
                return Err(validation(format!(
                    "[[{title}]] could link {}, which share that name or alias; link the one you mean as [[ID|{title}]]",
                    self.name_candidates(&matches)?
                )));
            }
        };
        plan.names.insert(name, id.clone());
        Ok(Some((id, true)))
    }
}

/// Start tracking an existing block's revision for this plan.
pub(super) fn touch(plan: &mut Plan, block: &Block, revision: Option<i64>) {
    plan.revisions
        .insert(block.id.clone(), revision.unwrap_or(block.revision));
}

/// Replace `block`'s text unless it already reads that way.
pub(super) fn plan_text(plan: &mut Plan, block: &Block, text: String) {
    if text != block.text {
        plan.operations.push(Operation::EditText {
            id: block.id.clone(),
            base_revision: next_revision(&mut plan.revisions, &block.id),
            text,
        });
        plan.steps.push(Step::Text {
            id: block.id.clone(),
            text: block.text.clone(),
        });
    }
}

/// Refuse a page title that is too long, can never be linked, or is a date,
/// which names a journal day instead.
fn page_title(title: &str) -> Result<()> {
    if title.chars().count() > TITLE_LIMIT {
        return Err(validation(format!(
            "a page title can have at most {TITLE_LIMIT} characters"
        )));
    }
    if title.contains("[[") || title.contains("]]") {
        return Err(validation(
            "a page title cannot contain [[ or ]]; give the title without brackets",
        ));
    }
    if date_shaped(title) {
        return Err(validation(format!(
            "a page title cannot be a date: {title} names a journal day, which the journal target writes to"
        )));
    }
    Ok(())
}

fn fields_target() -> Error {
    validation(
        "the Fields page holds field definitions, not notes; to give an atom a field, write `Name:: value` in its note",
    )
}

/// `YYYY-MM-DD` in shape, whether or not it is a real date.
fn date_shaped(title: &str) -> bool {
    let bytes = title.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

/// How many atoms `blocks` holds, counting nested ones.
fn note_size(blocks: &[OutlineBlock]) -> usize {
    blocks
        .iter()
        .map(|block| 1 + note_size(&block.children))
        .sum()
}

/// Names joined as prose: "A", "A and B", "A, B and C".
pub(crate) fn listed(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn status_name(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Todo => "todo",
        TaskStatus::Doing => "doing",
        TaskStatus::Waiting => "waiting",
        TaskStatus::Done => "done",
        TaskStatus::Cancelled => "cancelled",
    }
}

/// The start of a block's text for summaries. A tag or reference the cut
/// would split is kept whole, so no identifier is truncated.
pub(super) fn snippet(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    match line.char_indices().nth(48) {
        Some((end, _)) => {
            let end = crate::tag_tokens(line)
                .map(|token| token.span)
                .chain(crate::reference_spans(line).map(|(span, _, _)| span))
                .find(|span| span.start < end && end < span.end)
                .map_or(end, |span| span.end);
            format!("{}…", line[..end].trim_end())
        }
        None => line.to_owned(),
    }
}
