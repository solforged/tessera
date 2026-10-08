//! Appending an outline to a page, journal day or block in one attributed
//! batch. This is the write path for agents: they name a target by title or
//! date instead of tracking block IDs and revisions, and hand-written
//! `[[Title]]` references link the way the browser links them when a block
//! is left.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::notebook::{new_ulid, now_ms};
use crate::storage::{validate_date, validate_id, validation};
use crate::{Actor, Batch, Block, Committed, Notebook, Operation, Result};

/// Where a note is appended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteTarget {
    /// The live page with this title, ignoring case; created when missing.
    Page { title: String },
    /// The journal root for a `YYYY-MM-DD` date, or today in the notebook
    /// time zone; created when missing.
    Journal {
        #[serde(default)]
        date: Option<String>,
    },
    /// After the last child of an existing block.
    Block { id: String },
}

/// One block of a note and its nested children.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteBlock {
    pub text: String,
    /// Heading level 1 to 3.
    #[serde(default)]
    pub heading: Option<u8>,
    #[serde(default)]
    pub children: Vec<NoteBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub actor: Actor,
    #[serde(default)]
    pub reason: Option<String>,
    pub target: NoteTarget,
    pub blocks: Vec<NoteBlock>,
}

/// The result of [`Notebook::add_note`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteReceipt {
    /// The page or journal root the note landed in.
    pub page: Block,
    /// The parent of the note's top-level blocks.
    pub parent_id: String,
    /// The new blocks' IDs in reading order.
    pub blocks: Vec<String>,
    /// Pages the note created: a missing target page and missing pages named
    /// by `[[Title]]` references.
    pub created_pages: Vec<Block>,
    pub committed: Committed,
}

/// Pages resolved or created while building one note's batch, keyed by
/// lowercase title.
struct Plan {
    operations: Vec<Operation>,
    titles: HashMap<String, String>,
    created: Vec<String>,
    blocks: Vec<String>,
}

impl Plan {
    fn create_page(&mut self, title: &str) -> String {
        let id = new_ulid().to_string();
        self.operations.push(Operation::CreatePage {
            id: id.clone(),
            title: title.to_owned(),
        });
        self.titles.insert(title.to_lowercase(), id.clone());
        self.created.push(id.clone());
        id
    }
}

impl Notebook {
    /// Append `note.blocks` at the end of the target's children in one
    /// batch. Missing target pages and journal days are created in the same
    /// batch, so a failure writes nothing.
    pub fn add_note(&mut self, note: &Note) -> Result<NoteReceipt> {
        if note.blocks.is_empty() {
            return Err(validation("a note must contain a block"));
        }
        let mut plan = Plan {
            operations: Vec::new(),
            titles: HashMap::new(),
            created: Vec::new(),
            blocks: Vec::new(),
        };
        let (page_id, parent_id, after) = match &note.target {
            NoteTarget::Page { title } => {
                let title = title.trim();
                match self.page_by_title(title)? {
                    Some(page) => {
                        plan.titles.insert(title.to_lowercase(), page.id.clone());
                        let after = self.last_child(&page.id, &page.id)?;
                        (page.id.clone(), page.id, after)
                    }
                    None => {
                        let id = plan.create_page(title);
                        (id.clone(), id, None)
                    }
                }
            }
            NoteTarget::Journal { date } => {
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
                        (day.id.clone(), day.id, after)
                    }
                    None => {
                        let id = new_ulid().to_string();
                        plan.operations.push(Operation::CreateJournal {
                            id: id.clone(),
                            date,
                        });
                        (id.clone(), id, None)
                    }
                }
            }
            NoteTarget::Block { id } => {
                let block = self.block(id)?;
                let after = self.last_child(&block.page_id, &block.id)?;
                (block.page_id, block.id, after)
            }
        };
        self.plan_blocks(&mut plan, &parent_id, after, &note.blocks)?;
        let committed = self.apply(&Batch {
            actor: note.actor.clone(),
            reason: note.reason.clone(),
            idempotency_key: None,
            operations: plan.operations,
        })?;
        Ok(NoteReceipt {
            page: self.block(&page_id)?,
            parent_id,
            blocks: plan.blocks,
            created_pages: plan
                .created
                .iter()
                .map(|id| self.block(id))
                .collect::<Result<_>>()?,
            committed,
        })
    }

    fn plan_blocks(
        &self,
        plan: &mut Plan,
        parent_id: &str,
        mut after: Option<String>,
        blocks: &[NoteBlock],
    ) -> Result<()> {
        for block in blocks {
            let id = new_ulid().to_string();
            let text = self.link_titles(plan, &block.text)?;
            plan.operations.push(Operation::Insert {
                id: id.clone(),
                parent_id: parent_id.to_owned(),
                after: after.replace(id.clone()),
                text,
                heading: block.heading,
            });
            plan.blocks.push(id.clone());
            self.plan_blocks(plan, &id, None, &block.children)?;
        }
        Ok(())
    }

    /// The last live child of `parent_id`, which lives on `page_id`.
    fn last_child(&self, page_id: &str, parent_id: &str) -> Result<Option<String>> {
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

    /// Rewrite `[[Title]]` to `[[id]]` for the live page with that title,
    /// creating it when missing, and keep any `|alias`. A date names a
    /// journal day and stays as written when that day does not exist. ID
    /// references and `#[[Tag]]` tags are left alone.
    fn link_titles(&self, plan: &mut Plan, text: &str) -> Result<String> {
        let mut linked = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find("[[") {
            let (before, opened) = rest.split_at(start);
            let Some(end) = opened[2..].find("]]") else {
                break;
            };
            let reference = &opened[2..2 + end];
            let tag = before.strip_suffix('#').is_some_and(|prefix| {
                prefix
                    .chars()
                    .next_back()
                    .is_none_or(|ch| !ch.is_alphanumeric() && ch != '_')
            });
            let (target, alias) = match reference.split_once('|') {
                Some((target, alias)) => (target, Some(alias)),
                None => (reference, None),
            };
            let title = target.trim();
            let resolved = if tag
                || title.is_empty()
                || title.contains(['[', ']', '\n', '\r'])
                || alias.is_some_and(|alias| alias.contains(']'))
                || validate_id(target).is_ok()
            {
                None
            } else {
                self.title_target(plan, title)?
            };
            linked.push_str(before);
            match resolved {
                Some(id) => {
                    linked.push_str("[[");
                    linked.push_str(&id);
                    if let Some(alias) = alias {
                        linked.push('|');
                        linked.push_str(alias);
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

    fn title_target(&self, plan: &mut Plan, title: &str) -> Result<Option<String>> {
        if let Some(id) = plan.titles.get(&title.to_lowercase()) {
            return Ok(Some(id.clone()));
        }
        let bytes = title.as_bytes();
        let date_shaped = bytes.len() == 10
            && bytes.iter().enumerate().all(|(index, byte)| match index {
                4 | 7 => *byte == b'-',
                _ => byte.is_ascii_digit(),
            });
        if date_shaped {
            return Ok(match validate_date(title) {
                Ok(()) => self.journal(title)?.map(|day| day.id),
                Err(_) => None,
            });
        }
        if let Some(page) = self.page_by_title(title)? {
            plan.titles.insert(title.to_lowercase(), page.id.clone());
            return Ok(Some(page.id));
        }
        Ok(Some(plan.create_page(title)))
    }
}
