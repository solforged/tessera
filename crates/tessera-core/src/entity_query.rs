//! Source selection and derived attributes for the shared block query.
use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::Connection;

use crate::reads::hidden_blocks;
use crate::storage::validation;
use crate::{
    FieldKind, Notebook, Query, QueryAttribute, QueryAttributeValue, QueryGroup, QueryRow,
    QuerySource, Reading, ReadingValue, Result,
};

type Attributes = BTreeMap<String, Vec<QueryAttributeValue>>;
pub(crate) type Entities = HashMap<String, Attributes>;

pub(crate) fn attributes(source: QuerySource) -> Vec<QueryAttribute> {
    use FieldKind::{Checkbox, Choice, Date, Instance, Number, Text};
    let specific: &[(&str, &str, FieldKind)] = match source {
        QuerySource::Notes => &[
            ("@kind", "Kind", Choice),
            ("@resolved", "Resolved", Checkbox),
            ("@revisit", "Revisit", Date),
        ],
        QuerySource::Questions => &[
            ("@state", "State", Choice),
            ("@parent", "Parent", Instance),
            ("@program", "Program", Instance),
            ("@readings", "Readings", Number),
            ("@current", "Current reading", Text),
            ("@last_assessed", "Last assessed", Date),
            ("@revisit", "Revisit", Date),
            ("@inline", "Inline", Checkbox),
        ],
        QuerySource::Positions => &[
            ("@holder", "Holder", Instance),
            ("@subject", "Subject", Instance),
            ("@relation", "Relation", Choice),
            ("@target_holder", "Target holder", Instance),
            ("@cites", "Cites", Instance),
        ],
        QuerySource::Sources => &[
            ("@creator", "Creator", Instance),
            ("@cited_by", "Cited by", Number),
            ("@highlights", "Highlights", Number),
        ],
        QuerySource::Tasks => &[
            ("@status", "Status", Choice),
            ("@due", "Due", Date),
            ("@scheduled", "Scheduled", Date),
            ("@project", "Project", Instance),
        ],
        QuerySource::Highlights => &[("@source", "Source", Instance), ("@color", "Color", Choice)],
    };
    [
        ("@title", "Title", Text),
        ("@page", "Page", Instance),
        ("@created", "Created", Date),
        ("@updated", "Updated", Date),
    ]
    .iter()
    .chain(specific)
    .map(|&(key, name, kind)| QueryAttribute {
        key: key.into(),
        name: name.into(),
        kind,
    })
    .collect()
}

pub(crate) fn default_columns(
    source: QuerySource,
    fields: &[crate::FieldDefinition],
) -> Vec<String> {
    let keys: &[&str] = match source {
        QuerySource::Notes => &[],
        QuerySource::Questions => &["@state", "@parent", "@readings", "@current", "@revisit"],
        QuerySource::Positions => &["@holder", "@subject", "Gist", "Work"],
        QuerySource::Sources => &["@creator", "Published", "@cited_by"],
        QuerySource::Tasks => &["@status", "@due", "@scheduled", "@project"],
        QuerySource::Highlights => &["@source", "@color"],
    };
    keys.iter()
        .filter_map(|key| {
            if key.starts_with('@') {
                Some((*key).into())
            } else {
                fields
                    .iter()
                    .find(|field| field.name.eq_ignore_ascii_case(key))
                    .map(|field| field.id.clone())
            }
        })
        .collect()
}

fn push(attrs: &mut Attributes, key: &str, value: ReadingValue, target: Option<String>) {
    let text = match &value {
        ReadingValue::Text(text) => text.clone(),
        ReadingValue::Number(number) => number.to_string(),
        ReadingValue::Checkbox(checked) => checked.to_string(),
        ReadingValue::Span(span) => format!(
            "{}–{}",
            span.from
                .map_or_else(|| "?".into(), |year| year.to_string()),
            span.through
                .map_or_else(|| "?".into(), |year| year.to_string()),
        ),
    };
    let value = QueryAttributeValue {
        text,
        reading: Reading::Value {
            ok: true,
            value,
            target,
        },
    };
    let values = attrs.entry(key.into()).or_default();
    if !values.contains(&value) {
        values.push(value);
    }
}
fn text(attrs: &mut Attributes, key: &str, value: impl Into<String>) {
    push(attrs, key, ReadingValue::Text(value.into()), None);
}
fn optional(attrs: &mut Attributes, key: &str, value: Option<String>) {
    if let Some(value) = value {
        text(attrs, key, value);
    }
}
fn instance(attrs: &mut Attributes, key: &str, id: &str, titles: &HashMap<String, String>) {
    if let Some(title) = titles.get(id) {
        push(
            attrs,
            key,
            ReadingValue::Text(title.clone()),
            Some(id.into()),
        );
    }
}

/// References are scoped to the selected block's subtree, not its containing page.
/// Distinct sets keep multiple citations of one source from inflating counts.
fn references(
    conn: &Connection,
    roots: &[String],
    citations: bool,
) -> Result<HashMap<String, HashSet<String>>> {
    let mut statement = conn.prepare_cached(concat!(
        hidden_blocks!(),
        ", subtree(owner, id) AS (
            SELECT value, value FROM json_each(?1)
            UNION ALL SELECT s.owner, b.id FROM subtree s JOIN blocks b ON b.parent_id = s.id
            WHERE b.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)
        ), refs(block_id, target_id) AS (
            SELECT source_id, target_id FROM links
            UNION SELECT c.block_id, s.source_id FROM citations c
            JOIN source_snapshots s ON s.snapshot_id = c.snapshot_id WHERE c.active = 1 AND ?2 = 1
        ) SELECT DISTINCT s.owner, t.id FROM subtree s JOIN refs r ON r.block_id = s.id
        JOIN blocks t ON t.id = r.target_id
        WHERE t.deletion_id IS NULL AND t.rowid NOT IN (SELECT rowid FROM hidden)
        AND (?2 = 0 OR EXISTS(SELECT 1 FROM sources WHERE block_id = t.id AND active = 1))"
    ))?;
    let mut result = HashMap::<String, HashSet<String>>::new();
    for pair in statement.query_map(
        rusqlite::params![
            serde_json::to_string(roots).expect("IDs serialize"),
            citations
        ],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )? {
        let (owner, target) = pair?;
        result.entry(owner).or_default().insert(target);
    }
    Ok(result)
}

impl Notebook {
    pub(crate) fn query_entities(&self, source: QuerySource) -> Result<Option<Entities>> {
        if source == QuerySource::Notes {
            return Ok(None);
        }
        let titles = self.query_titles()?;
        let mut entities = Entities::new();
        match source {
            QuerySource::Notes => unreachable!(),
            QuerySource::Positions => {
                let positions = crate::position_store::derive(&self.conn, None)?;
                let roots: Vec<_> = positions.keys().cloned().collect();
                let mut cited = references(&self.conn, &roots, true)?;
                for (id, position) in &positions {
                    let attrs = entities.entry(id.clone()).or_default();
                    if let Some(holder) = &position.holder_id {
                        instance(attrs, "@holder", holder, &titles);
                    }
                    instance(attrs, "@subject", &position.subject_id, &titles);
                    for source in cited.remove(id).unwrap_or_default() {
                        instance(attrs, "@cites", &source, &titles);
                    }
                }
                for (id, relation) in crate::relation_store::derive(&self.conn, None)? {
                    if !titles.contains_key(&id) {
                        continue;
                    }
                    let Some(attrs) = entities.get_mut(&relation.source_id) else {
                        continue;
                    };
                    text(attrs, "@relation", relation.kind.as_str());
                    if let Some(target) = relation.target_id.as_deref() {
                        let holder = positions
                            .get(target)
                            .and_then(|position| position.holder_id.as_deref())
                            .unwrap_or(target);
                        instance(attrs, "@target_holder", holder, &titles);
                    }
                }
            }
            QuerySource::Questions => {
                let questions = self.questions(&crate::QuestionQuery::default())?;
                let parents: HashMap<_, _> = questions
                    .iter()
                    .map(|row| (row.block.block.id.as_str(), row.info.parent_id.as_deref()))
                    .collect();
                let assessment_ids = self.conn.prepare_cached(concat!(hidden_blocks!(),
                    "SELECT a.block_id FROM assessments a JOIN blocks b ON b.id = a.block_id WHERE a.active = 1
                     AND b.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)"))?
                    .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
                let mut last = HashMap::<String, String>::new();
                for caps in crate::task_store::capabilities_for(&self.conn, &assessment_ids)? {
                    if let Some(assessment) = caps.assessment
                        && let Some(question) = assessment.question_id
                    {
                        let date = last.entry(question).or_default();
                        if *date < assessment.state.assessed_on {
                            *date = assessment.state.assessed_on;
                        }
                    }
                }
                for row in &questions {
                    let id = &row.block.block.id;
                    let attrs = entities.entry(id.clone()).or_default();
                    let state = match row.info.status {
                        crate::QuestionStatus::Open => "active",
                        crate::QuestionStatus::Unsettled => "recurrent",
                        crate::QuestionStatus::Parked => "parked",
                        crate::QuestionStatus::Answered => "answered",
                    };
                    text(attrs, "@state", state);
                    if let Some(parent) = &row.info.parent_id {
                        instance(attrs, "@parent", parent, &titles);
                    }
                    let mut program = id.as_str();
                    let mut seen = HashSet::new();
                    while seen.insert(program) {
                        match parents.get(program).copied().flatten() {
                            Some(parent) => program = parent,
                            None => break,
                        }
                    }
                    instance(attrs, "@program", program, &titles);
                    push(
                        attrs,
                        "@readings",
                        ReadingValue::Number(row.position_count as f64),
                        None,
                    );
                    optional(
                        attrs,
                        "@current",
                        row.current.as_ref().map(|reading| reading.text.clone()),
                    );
                    optional(attrs, "@last_assessed", last.remove(id));
                    optional(attrs, "@revisit", row.review_on.clone());
                    push(
                        attrs,
                        "@inline",
                        ReadingValue::Checkbox(id != &row.block.page.id),
                        None,
                    );
                }
            }
            QuerySource::Tasks => {
                for row in
                    crate::task_query::visible_tasks(&self.conn, None, crate::TaskProjectVia::Both)?
                {
                    let attrs = entities.entry(row.source.block.id).or_default();
                    text(
                        attrs,
                        "@status",
                        match row.task.status {
                            crate::TaskStatus::Todo => "todo",
                            crate::TaskStatus::Doing => "doing",
                            crate::TaskStatus::Waiting => "waiting",
                            crate::TaskStatus::Done => "done",
                            crate::TaskStatus::Cancelled => "cancelled",
                        },
                    );
                    optional(attrs, "@due", row.task.deadline);
                    optional(attrs, "@scheduled", row.task.scheduled);
                    if let Some(id) = row.project_id {
                        instance(attrs, "@project", &id, &titles);
                    }
                }
            }
            QuerySource::Highlights => {
                for row in self
                    .highlights(&crate::library::HighlightQuery {
                        limit: Some(usize::MAX),
                        ..Default::default()
                    })?
                    .rows
                {
                    let attrs = entities.entry(row.block.block.id).or_default();
                    instance(attrs, "@source", &row.citation.source_id, &titles);
                    optional(attrs, "@color", row.color);
                }
            }
            QuerySource::Sources => {
                let roots = crate::position_store::derive(&self.conn, None)?
                    .into_keys()
                    .filter(|id| titles.contains_key(id))
                    .collect::<Vec<_>>();
                let mut cited_by = HashMap::<String, usize>::new();
                for sources in references(&self.conn, &roots, true)?.into_values() {
                    for source in sources {
                        *cited_by.entry(source).or_default() += 1;
                    }
                }
                let mut highlights = HashMap::<String, HashSet<String>>::new();
                for row in self
                    .highlights(&crate::library::HighlightQuery {
                        limit: Some(usize::MAX),
                        ..Default::default()
                    })?
                    .rows
                {
                    highlights
                        .entry(row.citation.source_id)
                        .or_default()
                        .insert(row.block.block.id);
                }
                let mut statement = self
                    .conn
                    .prepare_cached("SELECT block_id FROM sources WHERE active = 1")?;
                for id in statement.query_map([], |r| r.get::<_, String>(0))? {
                    let id = id?;
                    let attrs = entities.entry(id.clone()).or_default();
                    push(
                        attrs,
                        "@cited_by",
                        ReadingValue::Number(cited_by.get(&id).copied().unwrap_or_default() as f64),
                        None,
                    );
                    push(
                        attrs,
                        "@highlights",
                        ReadingValue::Number(highlights.get(&id).map_or(0, HashSet::len) as f64),
                        None,
                    );
                }
                let mut statement = self.conn.prepare_cached(concat!(
                    hidden_blocks!(),
                    "SELECT DISTINCT fv.owner_id, l.target_id FROM field_values fv
                    JOIN blocks d ON d.id = fv.field_id JOIN blocks v ON v.id = fv.value_id
                    JOIN links l ON l.source_id = v.id AND l.occurrence = 0
                    WHERE lower(d.text) IN ('author', 'editor', 'translator')
                    AND v.rowid NOT IN (SELECT rowid FROM hidden) ORDER BY fv.owner_id, fv.ordinal"
                ))?;
                for row in statement
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                {
                    let (owner, target) = row?;
                    if let Some(attrs) = entities.get_mut(&owner) {
                        instance(attrs, "@creator", &target, &titles);
                    }
                }
            }
        }
        entities.retain(|id, _| titles.contains_key(id));
        for attrs in entities.values_mut() {
            for key in ["@cites", "@relation", "@target_holder"] {
                if let Some(values) = attrs.get_mut(key) {
                    values.sort_by(|a, b| a.text.cmp(&b.text));
                }
            }
        }
        Ok(Some(entities))
    }

    fn query_titles(&self) -> Result<HashMap<String, String>> {
        Ok(self.conn.prepare_cached(concat!(hidden_blocks!(),
            "SELECT b.id, b.text FROM blocks b JOIN blocks p ON p.id = b.page_id
            WHERE b.deletion_id IS NULL AND p.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)"))?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?)
    }

    pub(crate) fn hydrate_query_attributes(
        &self,
        source: QuerySource,
        rows: &mut [QueryRow],
    ) -> Result<()> {
        let zone = crate::settings::time_zone(&self.conn)?;
        let metadata = attributes(source);
        let kinds = if source == QuerySource::Notes {
            self.query_note_kinds()?
        } else {
            HashMap::new()
        };
        let ids: Vec<_> = rows.iter().map(|row| row.block.block.id.clone()).collect();
        let notes: HashMap<_, _> = if source == QuerySource::Notes {
            crate::task_store::capabilities_for(&self.conn, &ids)?
                .into_iter()
                .map(|caps| (caps.block_id.clone(), caps))
                .collect()
        } else {
            HashMap::new()
        };
        for row in rows {
            let attrs = &mut row.attributes;
            for attribute in &metadata {
                attrs.entry(attribute.key.clone()).or_default();
            }
            text(attrs, "@title", &row.block.block.text);
            push(
                attrs,
                "@page",
                ReadingValue::Text(row.block.page.text.clone()),
                Some(row.block.page.id.clone()),
            );
            text(
                attrs,
                "@created",
                crate::settings::date_in_zone(row.block.block.created_at, zone.clone())?,
            );
            text(
                attrs,
                "@updated",
                crate::settings::date_in_zone(row.block.block.updated_at, zone.clone())?,
            );
            if source == QuerySource::Notes {
                if let Some(kinds) = kinds.get(&row.block.block.id) {
                    for kind in kinds {
                        text(attrs, "@kind", kind);
                    }
                }
                let caps = notes.get(&row.block.block.id);
                let note = caps.and_then(|caps| caps.note.as_ref());
                push(
                    attrs,
                    "@resolved",
                    ReadingValue::Checkbox(note.is_some_and(|note| note.resolved_at.is_some())),
                    None,
                );
                let revisit = match caps.and_then(|caps| caps.question.as_ref()) {
                    Some(question) => question.state.review_on.clone(),
                    None => note.and_then(|note| note.revisit_on.clone()),
                };
                optional(attrs, "@revisit", revisit);
            }
        }
        Ok(())
    }

    pub(crate) fn retain_entity_references(
        &self,
        query: &Query,
        rows: &mut Vec<QueryRow>,
    ) -> Result<()> {
        if query.links.is_empty() && query.from.is_empty() && query.cites.is_empty() {
            return Ok(());
        }
        let roots: Vec<_> = rows.iter().map(|row| row.block.block.id.clone()).collect();
        let sources = if query.cites.is_empty() {
            None
        } else {
            Some(self.kind_notes("source")?)
        };
        for (terms, cites, incoming) in [
            (&query.links, false, false),
            (&query.cites, true, false),
            (&query.from, false, true),
        ] {
            if terms.is_empty() {
                continue;
            }
            let refs = if incoming {
                HashMap::new()
            } else {
                references(&self.conn, &roots, cites)?
            };
            for term in terms {
                let ids: Vec<_> = self
                    .query_reference_ids(term, if cites { sources.as_ref() } else { None })?
                    .into_iter()
                    .collect();
                if ids.len() != 1 {
                    rows.clear();
                    return Ok(());
                }
                let target = &ids[0];
                if incoming {
                    let linked = references(&self.conn, &ids, false)?
                        .remove(target)
                        .unwrap_or_default();
                    rows.retain(|row| linked.contains(&row.block.block.id));
                } else {
                    rows.retain(|row| {
                        refs.get(&row.block.block.id)
                            .is_some_and(|refs| refs.contains(target))
                    });
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn groups(query: &Query, rows: &[QueryRow]) -> Vec<QueryGroup> {
    let Some(grouping) = &query.group else {
        return Vec::new();
    };
    let mut groups = HashMap::<String, QueryGroup>::new();
    for row in rows {
        let values: Vec<_> = if grouping.key.starts_with('@') {
            row.attributes
                .get(&grouping.key)
                .into_iter()
                .flatten()
                .map(|value| (&value.text, &value.reading))
                .collect()
        } else {
            row.values
                .get(&grouping.key)
                .into_iter()
                .flatten()
                .map(|value| (&value.text, &value.reading))
                .collect()
        };
        let mut headings = Vec::new();
        for (text, reading) in values {
            let (title, target) = match reading {
                Reading::Value { value, target, .. } => (
                    match value {
                        ReadingValue::Text(value) => value.clone(),
                        ReadingValue::Number(value) => value.to_string(),
                        ReadingValue::Checkbox(value) => value.to_string(),
                        ReadingValue::Span(_) => text.clone(),
                    },
                    target.clone(),
                ),
                Reading::Problem { .. } => (text.clone(), None),
            };
            headings.push((
                target.clone().unwrap_or_else(|| title.clone()),
                title,
                target,
            ));
        }
        if headings.is_empty() {
            headings.push((String::new(), "None".into(), None));
        }
        for (key, title, target) in headings {
            let group = groups.entry(key.clone()).or_insert_with(|| QueryGroup {
                key,
                title,
                target,
                row_ids: Vec::new(),
                count: 0,
            });
            if group.row_ids.last() != Some(&row.block.block.id) {
                group.row_ids.push(row.block.block.id.clone());
                group.count += 1;
            }
        }
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by_cached_key(|group| {
        (
            group.key.is_empty(),
            std::cmp::Reverse(group.count),
            crate::aliases::fold(&group.title),
            group.key.clone(),
        )
    });
    groups
}

pub(crate) fn relative_date(conn: &Connection, value: &str) -> Result<String> {
    let days = if value == "today" {
        Some(0)
    } else if (value.starts_with('+') || value.starts_with('-')) && value.ends_with('d') {
        Some(
            value[..value.len() - 1]
                .parse::<i64>()
                .map_err(|_| validation("Use today or a signed number of days, such as -30d."))?,
        )
    } else {
        None
    };
    match days {
        Some(days) => crate::calendar::add_days(
            &crate::settings::today_in_connection(conn, crate::now_ms())?,
            days,
        ),
        None => Ok(value.into()),
    }
}
