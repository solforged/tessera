//! `Name:: value` shorthand and the field definitions it creates.

use std::collections::HashMap;

use super::plan::{Plan, listed, plan_text, touch};
use crate::notebook::new_ulid;
use crate::storage::{validate_id, validation};
use crate::{Block, BlockKind, Error, FieldKind, Notebook, Operation, Result};

/// `Name:: value` shorthand with its name resolved to a field definition.
pub(super) struct Entry<'a> {
    pub(super) field: String,
    pub(super) name: &'a str,
    pub(super) value: Option<&'a str>,
}

impl Notebook {
    /// Convert editor field shorthand before resolving ordinary title links.
    pub(super) fn note_text<'a>(
        &self,
        plan: &mut Plan,
        text: &'a str,
    ) -> Result<(String, Option<Entry<'a>>)> {
        if let Some((name, value)) = field_shorthand(text) {
            let field = self.field_target(plan, name)?;
            Ok((
                format!("[[{field}]]"),
                Some(Entry {
                    field,
                    name,
                    value: (!value.is_empty()).then_some(value),
                }),
            ))
        } else {
            Ok((self.link_titles(plan, text)?, None))
        }
    }

    /// Load the live field definitions into the plan once: their IDs by
    /// lowercase name, choice fields' options and the kinds values must read as.
    fn load_fields(&self, plan: &mut Plan) -> Result<()> {
        if plan.fields.is_some() {
            return Ok(());
        }
        let mut fields = HashMap::new();
        for field in crate::fields::definitions(&self.conn)? {
            match field.kind {
                // Status and priority keep their task options, never value links.
                FieldKind::Choice if crate::built_in::task_options(&field.name).is_empty() => {
                    plan.choices
                        .insert(field.id.clone(), (field.name.clone(), field.options));
                }
                kind if value_form(kind).is_some() => {
                    plan.checked
                        .insert(field.id.clone(), (field.name.clone(), kind));
                }
                _ => {}
            }
            fields.insert(field.name.to_lowercase(), field.id);
        }
        plan.fields = Some(fields);
        Ok(())
    }

    /// The choice field `block` is an entry of, whose values are the blocks
    /// under it.
    pub(super) fn choice_entry(&self, plan: &mut Plan, block: &Block) -> Result<Option<String>> {
        let Some(field) = crate::fields::reference(&block.text) else {
            return Ok(None);
        };
        if block.kind != BlockKind::Block {
            return Ok(None);
        }
        self.load_fields(plan)?;
        Ok(plan.choices.contains_key(field).then(|| field.to_owned()))
    }

    fn field_target(&self, plan: &mut Plan, name: &str) -> Result<String> {
        self.load_fields(plan)?;
        let key = name.to_lowercase();
        if let Some(id) = plan.fields.as_ref().and_then(|fields| fields.get(&key)) {
            return Ok(id.clone());
        }
        let page = match crate::fields::page_id(&self.conn)? {
            Some(id) => id,
            None => match plan.titles.get("fields") {
                Some(id) => id.clone(),
                None => plan.create_page("Fields")?,
            },
        };
        let after = if let Some(id) = plan.created_fields.last() {
            Some(id.clone())
        } else if plan.created.contains(&page) {
            None
        } else {
            self.last_child(&page, &page)?
        };
        // A built-in name gets the definition the core owns: its lowercase
        // name, kind and starting options, as a template would make it.
        let built_in = crate::built_in::field_named(name);
        let id = match built_in {
            Some(field) if crate::built_in::task_field(field.name).is_some() => {
                crate::notebook::derived_id(&["task-field", &page, field.name])
            }
            _ => new_ulid().to_string(),
        };
        plan.operations.push(Operation::Insert {
            id: id.clone(),
            parent_id: page,
            after,
            text: built_in.map_or(name, |field| field.name).to_owned(),
            heading: None,
        });
        if let Some(field) = built_in.filter(|field| field.kind != FieldKind::Text) {
            // Setting a relation's kind files Links to its types where those pages exist.
            plan.operations.push(Operation::SetFieldKind {
                id: id.clone(),
                base_revision: 1,
                kind: field.kind,
            });
            if field.kind == FieldKind::Choice {
                if crate::built_in::task_options(field.name).is_empty() {
                    let (operations, options) = crate::built_in::starting_options(field, &id);
                    plan.operations.extend(operations);
                    plan.options
                        .extend(options.iter().map(|option| option.id.clone()));
                    plan.choices
                        .insert(id.clone(), (field.name.to_owned(), options));
                }
            } else if value_form(field.kind).is_some() {
                plan.checked
                    .insert(id.clone(), (field.name.to_owned(), field.kind));
            }
        }
        if let Some(field) = built_in.filter(|field| field.role != crate::FieldRole::Attribute) {
            // A gloss reads as a standfirst under its owner, as the editor's Gloss makes it.
            plan.operations.push(Operation::SetFieldRole {
                id: id.clone(),
                base_revision: if field.kind == FieldKind::Text { 1 } else { 2 },
                role: field.role,
            });
        }
        plan.fields
            .as_mut()
            .expect("fields were loaded")
            .insert(key, id.clone());
        plan.created_fields.push(id.clone());
        Ok(id)
    }

    /// A shorthand value always precedes authored children. Values added to
    /// existing blocks are separate roots for undo, not part of their parent.
    pub(super) fn plan_value(
        &self,
        plan: &mut Plan,
        parent_id: &str,
        entry: Option<&Entry>,
        removable: bool,
    ) -> Result<Option<String>> {
        let Some((field, value)) = entry.and_then(|entry| Some((&entry.field, entry.value?)))
        else {
            return Ok(None);
        };
        let id = new_ulid().to_string();
        let text = self.value_text(plan, field, value)?;
        plan.operations.push(Operation::Insert {
            id: id.clone(),
            parent_id: parent_id.to_owned(),
            after: None,
            text,
            heading: None,
        });
        plan.inserted.push(id.clone());
        if removable {
            plan.removable.push(id.clone());
        }
        Ok(Some(id))
    }

    /// A field value as stored: a link to the option it names for a choice
    /// field, which never creates a page, or the text with its title
    /// references linked for any other field. A value a number, date, span,
    /// URL, identifier or checkbox field cannot read is refused.
    pub(super) fn value_text(&self, plan: &mut Plan, field: &str, value: &str) -> Result<String> {
        let Some((name, options)) = plan.choices.get(field) else {
            let text = self.link_titles(plan, value)?;
            let Some((name, kind)) = plan.checked.get(field) else {
                return Ok(text);
            };
            let target = match crate::fields::reference(&text) {
                Some(id) if validate_id(id).is_ok() => self.live_block(id)?,
                _ => None,
            };
            let crate::Reading::Problem { problem, .. } =
                crate::fields::reading(*kind, field, &text, target.as_ref())
            else {
                return Ok(text);
            };
            let (noun, form) = value_form(*kind).expect("checked kinds have a written form");
            return Err(validation(format!(
                "{name} is {noun} field and “{}” is {problem}; {form}",
                value.trim()
            )));
        };
        let wanted = value.trim();
        let label = wanted
            .strip_prefix("[[")
            .and_then(|inner| inner.strip_suffix("]]"))
            .map_or(wanted, |inner| {
                crate::storage::reference_parts(inner).0.trim()
            });
        let folded = label.to_lowercase();
        if let Some(option) = options
            .iter()
            .find(|option| option.id == label || option.text.trim().to_lowercase() == folded)
        {
            return Ok(format!("[[{}]]", option.id));
        }
        Err(validation(if options.is_empty() {
            format!(
                "{name} is a choice field with no options yet; a person adds its options on the Fields page"
            )
        } else {
            let options: Vec<&str> = options.iter().map(|option| option.text.trim()).collect();
            format!(
                "“{wanted}” is not an option of {name}; use one of {}",
                listed(&options)
            )
        }))
    }

    /// Replace a field entry's first value, or give a value to an entry that
    /// has none, leaving the entry itself as it is.
    pub(super) fn plan_entry_value(
        &self,
        plan: &mut Plan,
        block: &Block,
        revision: Option<i64>,
        entry: &Entry,
    ) -> Result<()> {
        // No operation may touch the entry itself, so check its revision here.
        if let Some(expected) = revision
            && expected != block.revision
        {
            return Err(Error::Conflict {
                op_index: plan.operations.len(),
                what: "atom",
                id: block.id.clone(),
                expected,
                found: Some(block.revision),
            });
        }
        let Some(value) = entry.value else {
            return Ok(());
        };
        let Some(first) = self.first_child(&block.id)? else {
            self.plan_value(plan, &block.id, Some(entry), true)?;
            return Ok(());
        };
        let text = self.value_text(plan, &entry.field, value)?;
        if text != first.text {
            touch(plan, &first, None);
            plan.changed.push(first.id.clone());
            plan_text(plan, &first, text);
        }
        Ok(())
    }
}

/// How a field kind whose unreadable values are refused is named, and how to
/// write a value it reads; `None` for kinds that keep any text.
fn value_form(kind: FieldKind) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        FieldKind::Number => ("a number", "write a number such as 42 or 3.5"),
        FieldKind::Date => (
            "a date",
            "write YYYY-MM-DD, YYYY-MM or YYYY, or link an existing journal day",
        ),
        FieldKind::Span => (
            "a span",
            "write years such as 1791–1871, c. 1493, b. 1947, d. 1871 or 1947–?",
        ),
        FieldKind::Url => (
            "a URL",
            "write an address that starts with https:// or http://",
        ),
        FieldKind::Identifier => ("an identifier", "write an ISBN, DOI or arXiv ID"),
        FieldKind::Checkbox => ("a checkbox", "write yes or no"),
        FieldKind::Text | FieldKind::Choice | FieldKind::Instance => return None,
    })
}

/// Match `matchFieldEntry` without allocating a regex for each block. The
/// editor's non-Unicode regex counts name length in UTF-16 code units.
fn field_shorthand(text: &str) -> Option<(&str, &str)> {
    let (name, value) = text.split_once("::")?;
    let length = name.encode_utf16().count();
    if !(1..=60).contains(&length)
        || name.contains([
            '\\', '`', '[', ']', '#', ':', '\n', '\r', '\u{2028}', '\u{2029}',
        ])
    {
        return None;
    }
    let name = name.trim_matches(editor_whitespace);
    if name.is_empty() {
        return None;
    }
    let parsed = crate::card_text::parse_card_text(name);
    if !parsed.cards.is_empty() || !parsed.problems.is_empty() {
        return None;
    }
    let value = match value.chars().next() {
        Some(ch) if editor_whitespace(ch) => &value[ch.len_utf8()..],
        _ => value,
    };
    if value.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((name, value))
}

fn editor_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | ' '
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}
