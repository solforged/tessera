use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::fields::{constrained_reading, definition_map, definitions};
use crate::reads::{fts_query, hidden_blocks};
use crate::storage::{block_at, block_columns, not_found, validate_id, validation};
use crate::{
    BlockKind, Direction, FieldDefinition, FieldKind, FieldValue, Filter, FilterOp, Notebook,
    Query, QueryResult, QueryRow, Reading, ReadingValue, Result, SortBy, SortKey, TypeInfo, View,
};

pub(crate) fn validate_query(conn: &Connection, query: &Query) -> Result<Vec<FieldDefinition>> {
    if query.r#type.is_none()
        && query.text.is_none()
        && query.filters.is_empty()
        && query.source.is_none()
        && !query.selects_notes()
    {
        return Err(validation("query needs a type, text or filter"));
    }
    if let Some(id) = &query.r#type {
        validate_id(id)?;
    }
    if query.limit.is_some_and(|limit| limit > 2000) {
        return Err(validation("query limit must not exceed 2000"));
    }
    let definitions = definitions(conn)?;
    let defs = definition_map(&definitions);
    let attributes = crate::entity_query::attributes(query.source.unwrap_or_default());
    let require = |id: &str| -> Result<FieldKind> {
        if id.starts_with('@') {
            return attributes
                .iter()
                .find(|attribute| attribute.key == id)
                .map(|attribute| attribute.kind)
                .ok_or_else(|| {
                    validation(format!(
                        "The attribute {id} does not belong to this source."
                    ))
                });
        }
        defs.get(id)
            .map(|definition| definition.kind)
            .ok_or_else(|| validation(format!("not a live field definition: {id}")))
    };
    for filter in &query.filters {
        let kind = require(&filter.field)?;
        if !matches!(
            filter.op,
            FilterOp::Present | FilterOp::Set | FilterOp::Empty
        ) && filter.value.is_none()
        {
            return Err(validation("filter value is required"));
        }
        if kind == FieldKind::Number && ordered(filter.op) {
            filter_number(filter.value.as_deref().expect("validated filter value"))?;
        }
        if kind == FieldKind::Date
            && let Some(value) = &filter.value
        {
            crate::entity_query::relative_date(conn, value)?;
        }
    }
    for key in &query.sort {
        if key.by == SortBy::Field {
            require(
                key.field
                    .as_deref()
                    .ok_or_else(|| validation("field sort needs a field"))?,
            )?;
        }
    }
    for key in query
        .columns
        .iter()
        .flatten()
        .map(|column| column.key.as_str())
        .chain(query.group.iter().map(|group| group.key.as_str()))
        .chain(query.card.iter().flatten().map(String::as_str))
    {
        require(key)?;
    }
    if query
        .columns
        .iter()
        .flatten()
        .any(|column| column.width == Some(0))
    {
        return Err(validation("Column widths must be greater than zero."));
    }
    Ok(definitions)
}

pub(crate) fn validate_source_query(conn: &Connection, query: &Query) -> Result<()> {
    validate_query(conn, query)?;
    validate_source_type(conn, query)
}

fn validate_source_type(conn: &Connection, query: &Query) -> Result<()> {
    if let Some(id) = &query.r#type {
        let live = conn
            .prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT EXISTS(SELECT 1 FROM blocks b WHERE b.id = ?1 AND b.kind = 'page'
             AND b.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden))"
            ))?
            .query_row([id], |row| row.get::<_, bool>(0))?;
        if !live {
            return Err(validation(format!("not a live type page: {id}")));
        }
    }
    Ok(())
}

fn ordered(op: FilterOp) -> bool {
    matches!(
        op,
        FilterOp::Gt | FilterOp::Gte | FilterOp::Lt | FilterOp::Lte
    )
}
fn filter_number(value: &str) -> Result<f64> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .ok_or_else(|| validation("number filter value must be a number"))
}

pub(crate) fn template(conn: &Connection, id: &str) -> Result<Vec<String>> {
    Ok(conn
        .prepare_cached("SELECT field_id FROM type_fields WHERE type_id = ?1 ORDER BY position")?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Columns describe the base membership, not the narrowed result. Read entries
/// rather than values so a blank entry remains an editable column.
fn column_frequencies<'a>(
    conn: &Connection,
    query: &Query,
    definitions: &HashMap<&'a str, &FieldDefinition>,
    kind_members: Option<&HashSet<String>>,
) -> Result<HashMap<&'a str, usize>> {
    let mut statement = conn.prepare_cached(concat!(
        hidden_blocks!(),
        "SELECT e.text, b.id FROM links l JOIN blocks e ON e.id = l.source_id
         JOIN blocks b ON b.id = e.parent_id
         JOIN blocks p ON p.id = b.page_id
         WHERE e.deletion_id IS NULL AND b.deletion_id IS NULL AND p.deletion_id IS NULL
         AND e.rowid NOT IN (SELECT rowid FROM hidden)
         AND (?1 IS NULL OR EXISTS (
             SELECT 1 FROM memberships m JOIN blocks t ON t.id = m.type_id
             WHERE m.block_id = b.id AND m.type_id = ?1 AND t.deletion_id IS NULL
             AND t.rowid NOT IN (SELECT rowid FROM hidden)))
         ORDER BY b.id"
    ))?;
    let mut cursor = statement.query([&query.r#type])?;
    let mut frequencies = HashMap::new();
    let mut owner = String::new();
    let mut fields = HashSet::new();
    let mut count_owner = |owner: &str, fields: &HashSet<&'a str>| {
        if kind_members.is_some_and(|members| !members.contains(owner)) {
            return;
        }
        if query.r#type.is_some()
            || kind_members.is_some()
            || query.filters.is_empty()
            || query
                .filters
                .iter()
                .any(|filter| fields.contains(filter.field.as_str()))
        {
            for &field in fields {
                *frequencies.entry(field).or_default() += 1;
            }
        }
    };
    while let Some(row) = cursor.next()? {
        let id = row.get_ref(1)?.as_str().map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        if owner != id {
            count_owner(&owner, &fields);
            fields.clear();
            owner.clear();
            owner.push_str(id);
        }
        let text = row.get_ref(0)?.as_str().map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        if let Some((field, _)) =
            crate::fields::reference(text).and_then(|id| definitions.get_key_value(id))
        {
            fields.insert(*field);
        }
    }
    count_owner(&owner, &fields);
    Ok(frequencies)
}

pub(crate) fn presentation(
    conn: &Connection,
    id: &str,
) -> Result<(Option<String>, Option<String>)> {
    Ok(conn
        .query_row(
            "SELECT plural, icon FROM type_presentation WHERE type_id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or_default())
}

/// Preserve existing query structure while replacing uniquely resolved instance
/// equality labels. Missing or ambiguous entities are never guessed.
pub(crate) fn migrate_instance_filters(conn: &Connection) -> Result<()> {
    let instances: HashSet<_> = definitions(conn)?
        .into_iter()
        .filter(|field| field.kind == FieldKind::Instance)
        .map(|field| field.id)
        .collect();
    let mut names = HashMap::<String, Vec<String>>::new();
    let mut statement =
        conn.prepare("SELECT id, text FROM blocks WHERE kind = 'page' AND deletion_id IS NULL")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let title: String = row.get(1)?;
        names.entry(title.to_lowercase()).or_default().push(id);
    }
    fn canonicalize(
        value: &mut serde_json::Value,
        instances: &HashSet<String>,
        names: &HashMap<String, Vec<String>>,
    ) -> bool {
        let mut changed = false;
        match value {
            serde_json::Value::Object(object) => {
                if object
                    .get("field")
                    .and_then(|value| value.as_str())
                    .is_some_and(|field| instances.contains(field))
                    && object
                        .get("op")
                        .and_then(|value| value.as_str())
                        .is_some_and(|op| matches!(op, "is" | "is_not"))
                    && let Some(value) = object.get_mut("value")
                    && let Some(label) = value.as_str().filter(|label| validate_id(label).is_err())
                    && let Some(ids) = names
                        .get(&label.to_lowercase())
                        .filter(|ids| ids.len() == 1)
                {
                    *value = serde_json::Value::String(ids[0].clone());
                    changed = true;
                }
                for value in object.values_mut() {
                    changed |= canonicalize(value, instances, names);
                }
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    changed |= canonicalize(value, instances, names);
                }
            }
            _ => {}
        }
        changed
    }
    for table in ["views", "decks", "task_views", "library_views"] {
        let mut statement = conn.prepare(&format!("SELECT id, query FROM {table}"))?;
        let stored = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, json) in stored {
            let mut query: serde_json::Value = serde_json::from_str(&json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            if canonicalize(&mut query, &instances, &names) {
                conn.execute(
                    &format!("UPDATE {table} SET query = ?1 WHERE id = ?2"),
                    params![
                        serde_json::to_string(&query).expect("query values serialize"),
                        id
                    ],
                )?;
            }
        }
    }
    Ok(())
}

fn stored_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<View> {
    let json: String = row.get(2)?;
    let query = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(View {
        id: row.get(0)?,
        name: row.get(1)?,
        query,
        revision: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

impl Notebook {
    pub fn type_info(&self, id: &str) -> Result<TypeInfo> {
        let page = self.block(id)?;
        if page.kind != BlockKind::Page {
            return Err(not_found(id));
        }
        let members = self.conn.prepare_cached(concat!(hidden_blocks!(),
            "SELECT COUNT(DISTINCT m.block_id) FROM memberships m JOIN blocks b ON b.id = m.block_id
             JOIN blocks p ON p.id = b.page_id JOIN blocks t ON t.id = m.type_id
             WHERE m.type_id = ?1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL AND t.deletion_id IS NULL
             AND b.rowid NOT IN (SELECT rowid FROM hidden) AND t.rowid NOT IN (SELECT rowid FROM hidden)"))?
            .query_row([id], |row| row.get::<_, i64>(0))? as usize;
        let (plural, icon) = presentation(&self.conn, id)?;
        Ok(TypeInfo {
            page,
            plural,
            icon,
            fields: template(&self.conn, id)?,
            members,
            card_templates: self.conn.query_row(
                "SELECT COUNT(*) FROM card_templates WHERE type_id = ?1",
                [id],
                |row| row.get::<_, i64>(0),
            )? as usize,
        })
    }

    pub fn types(&self) -> Result<Vec<TypeInfo>> {
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT COUNT(DISTINCT m.block_id), ", block_columns!("t"),
            " FROM memberships m JOIN blocks b ON b.id = m.block_id
             JOIN blocks p ON p.id = b.page_id JOIN blocks t ON t.id = m.type_id
             WHERE t.kind = 'page' AND b.deletion_id IS NULL AND p.deletion_id IS NULL AND t.deletion_id IS NULL
             AND b.rowid NOT IN (SELECT rowid FROM hidden) AND t.rowid NOT IN (SELECT rowid FROM hidden)
             GROUP BY m.type_id"
        ))?;
        let mut rows = statement.query([])?;
        let template_counts: HashMap<String, usize> = self
            .conn
            .prepare_cached("SELECT type_id, COUNT(*) FROM card_templates GROUP BY type_id")?
            .query_map([], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut types = Vec::new();
        while let Some(row) = rows.next()? {
            let page = block_at(row, 1)?;
            let (plural, icon) = presentation(&self.conn, &page.id)?;
            types.push(TypeInfo {
                plural,
                icon,
                fields: template(&self.conn, &page.id)?,
                card_templates: template_counts.get(&page.id).copied().unwrap_or(0),
                page,
                members: row.get::<_, i64>(0)? as usize,
            });
        }
        types.sort_by_cached_key(|info| (info.page.text.to_lowercase(), info.page.id.clone()));
        Ok(types)
    }

    pub fn views(&self) -> Result<Vec<View>> {
        let mut views = self
            .conn
            .prepare_cached("SELECT id, name, query, revision, created_at, updated_at FROM views")?
            .query_map([], stored_view)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        views.sort_by_cached_key(|view| (view.name.to_lowercase(), view.id.clone()));
        Ok(views)
    }

    pub fn view(&self, id: &str) -> Result<View> {
        validate_id(id)?;
        self.conn
            .prepare_cached(
                "SELECT id, name, query, revision, created_at, updated_at FROM views WHERE id = ?1",
            )?
            .query_row([id], stored_view)
            .optional()?
            .ok_or_else(|| not_found(id))
    }

    pub fn query(&self, query: &Query) -> Result<QueryResult> {
        self.query_sources(query, true)
    }

    pub(crate) fn query_all_sources(&self, query: &Query) -> Result<QueryResult> {
        self.query_sources(query, false)
    }

    fn query_sources(&self, query: &Query, truncate: bool) -> Result<QueryResult> {
        let definitions = validate_query(&self.conn, query)?;
        if !truncate {
            validate_source_type(&self.conn, query)?;
        }
        let defs = definition_map(&definitions);
        let source = query.source.unwrap_or_default();
        let attributes = crate::entity_query::attributes(source);
        let mut entities = self.query_entities(source)?;
        let entity_members = entities
            .as_ref()
            .map(|entities| entities.keys().cloned().collect::<HashSet<_>>());
        let note_candidates = self.note_candidates(query)?;
        let matched = if query.selects_notes() {
            None
        } else {
            query.text.as_deref().map(fts_query)
        };
        let filters = query
            .filters
            .iter()
            .map(|filter| {
                let kind = attributes
                    .iter()
                    .find(|attribute| attribute.key == filter.field)
                    .map_or_else(
                        || defs[filter.field.as_str()].kind,
                        |attribute| attribute.kind,
                    );
                PreparedFilter::new(&self.conn, filter, kind)
            })
            .collect::<Result<Vec<_>>>()?;
        let present_owners = filters.iter().find_map(|filter| filter.owners.as_ref());
        let owners = if present_owners.is_none()
            && query.r#type.is_none()
            && query.text.is_none()
            && !query.selects_notes()
            && entities.is_none()
        {
            let mut owners = HashSet::new();
            let mut entries = self.conn.prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT DISTINCT e.parent_id, e.text FROM links l
                 JOIN blocks e ON e.id = l.source_id
                 WHERE e.deletion_id IS NULL AND e.rowid NOT IN (SELECT rowid FROM hidden)"
            ))?;
            let mut cursor = entries.query([])?;
            while let Some(row) = cursor.next()? {
                let text: String = row.get(1)?;
                if crate::fields::reference(&text)
                    .is_some_and(|id| query.filters.iter().any(|filter| filter.field == id))
                {
                    owners.insert(row.get::<_, String>(0)?);
                }
            }
            Some(owners)
        } else {
            None
        };
        let candidates = present_owners.or(owners.as_ref());
        let mut rows: Vec<QueryRow> = Vec::new();
        if matched.as_ref().is_none_or(|text| !text.is_empty())
            && candidates.is_none_or(|owners| !owners.is_empty())
        {
            // One joined read for candidates, values and reference targets. No
            // per-candidate or per-value queries, and no copied text in the index.
            let mut statement = self.conn.prepare_cached(concat!(hidden_blocks!(),
                "SELECT ", block_columns!("b"), ", ", block_columns!("p"),
                ", f.field_id, v.id, v.text, ", block_columns!("t"),
                " FROM blocks b JOIN blocks p ON p.id = b.page_id
                  LEFT JOIN field_values f ON f.owner_id = b.id
                  LEFT JOIN blocks e ON e.id = f.entry_id
                  LEFT JOIN blocks v ON v.id = f.value_id
                  LEFT JOIN links l ON l.source_id = v.id AND l.occurrence = 0
                  LEFT JOIN blocks t ON t.id = l.target_id AND t.deletion_id IS NULL
                  WHERE b.deletion_id IS NULL AND p.deletion_id IS NULL
                  AND b.rowid NOT IN (SELECT rowid FROM hidden)
                  AND (?1 IS NULL OR EXISTS (SELECT 1 FROM memberships m JOIN blocks type ON type.id = m.type_id
                      WHERE m.block_id = b.id AND m.type_id = ?1 AND type.deletion_id IS NULL
                      AND type.rowid NOT IN (SELECT rowid FROM hidden)))
                  AND (?2 IS NULL OR b.rowid IN (SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?2))
                  AND (?3 IS NULL OR b.id IN (SELECT value FROM json_each(?3)))
                  ORDER BY b.id, e.ordinal, e.id, f.ordinal, v.id"))?;
            let selected = entity_members
                .as_ref()
                .map(|members| serde_json::to_string(members).expect("IDs serialize"));
            let mut cursor = statement.query(params![query.r#type, matched, selected])?;
            while let Some(row) = cursor.next()? {
                let id: &str = row.get_ref(0)?.as_str().map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                if candidates.is_some_and(|owners| !owners.contains(id))
                    || entity_members
                        .as_ref()
                        .is_some_and(|members| !members.contains(id))
                    || note_candidates
                        .as_ref()
                        .is_some_and(|notes| !notes.contains(id))
                {
                    continue;
                }
                if rows.last().is_none_or(|r| r.block.block.id != id) {
                    rows.push(QueryRow {
                        block: crate::BlockInPage {
                            block: block_at(row, 0)?,
                            page: block_at(row, 10)?,
                        },
                        values: BTreeMap::new(),
                        attributes: entities
                            .as_mut()
                            .and_then(|entities| entities.remove(id))
                            .unwrap_or_default(),
                    });
                }
                if let Some(field) = row.get::<_, Option<String>>(20)?
                    && let Some(definition) = defs.get(field.as_str())
                {
                    let text = row.get_ref(22)?.as_str().map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            22,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                    if text.trim().is_empty() {
                        continue;
                    }
                    let target = if matches!(row.get_ref(23)?, rusqlite::types::ValueRef::Null) {
                        None
                    } else {
                        Some(block_at(row, 23)?)
                    };
                    let reading = constrained_reading(
                        &self.conn,
                        definition.kind,
                        definition,
                        text,
                        target.as_ref(),
                    )?;
                    rows.last_mut()
                        .expect("candidate exists")
                        .values
                        .entry(field)
                        .or_default()
                        .push(FieldValue {
                            id: row.get(21)?,
                            text: text.to_owned(),
                            reading,
                        });
                }
            }
        }
        self.hydrate_query_attributes(source, &mut rows)?;
        if source != crate::QuerySource::Notes {
            self.retain_entity_references(query, &mut rows)?;
        }
        rows.retain(|row| filters.iter().all(|filter| filter.matches(row)));
        let total = rows.len();
        if !query.sort.is_empty() {
            let option_order: HashMap<_, _> = query
                .sort
                .iter()
                .filter_map(|key| key.field.as_deref().and_then(|id| defs.get(id)))
                .filter(|definition| definition.kind == FieldKind::Choice)
                .flat_map(|definition| {
                    definition
                        .options
                        .iter()
                        .enumerate()
                        .map(|(index, option)| (option.id.as_str(), index))
                })
                .collect();
            let mut keyed: Vec<_> = rows
                .into_iter()
                .map(|row| {
                    let keys = query
                        .sort
                        .iter()
                        .map(|key| sort_value(&row, key, &defs, &option_order))
                        .collect::<Vec<_>>();
                    (row, keys)
                })
                .collect();
            keyed.sort_unstable_by(|(left, a), (right, b)| {
                for ((a, b), key) in a.iter().zip(b).zip(&query.sort) {
                    let order = match (a, b) {
                        (None, None) => Ordering::Equal,
                        (None, Some(_)) => Ordering::Greater,
                        (Some(_), None) => Ordering::Less,
                        (Some(SortValue::Problem), Some(SortValue::Problem)) => Ordering::Equal,
                        (Some(SortValue::Problem), Some(_)) => Ordering::Greater,
                        (Some(_), Some(SortValue::Problem)) => Ordering::Less,
                        (Some(a), Some(b)) => {
                            let order = a.compare(b);
                            if key.direction == Direction::Desc {
                                order.reverse()
                            } else {
                                order
                            }
                        }
                    };
                    if order != Ordering::Equal {
                        return order;
                    }
                }
                left.block.block.id.cmp(&right.block.block.id)
            });
            rows = keyed.into_iter().map(|(row, _)| row).collect();
        }
        let mut columns = crate::entity_query::default_columns(source, &definitions);
        if let Some(id) = query.r#type.as_deref() {
            columns.extend(template(&self.conn, id)?);
        }
        columns.retain(|id| id.starts_with('@') || defs.contains_key(id.as_str()));
        // A note view's columns describe its kind, not the find terms that narrow it.
        let kind_members = query
            .note_kind
            .as_deref()
            .map(|kind| -> Result<HashSet<String>> {
                Ok(self
                    .kind_notes(kind)?
                    .notes
                    .into_iter()
                    .map(|note| note.id)
                    .collect())
            })
            .transpose()?;
        let mut frequencies = column_frequencies(
            &self.conn,
            query,
            &defs,
            entity_members.as_ref().or(kind_members.as_ref()),
        )?;
        for filter in &query.filters {
            if !filter.field.starts_with('@') {
                frequencies.entry(filter.field.as_str()).or_default();
            }
        }
        let mut extra: Vec<_> = frequencies
            .into_iter()
            .filter(|(id, _)| !columns.iter().any(|column| column == id))
            .collect();
        extra.sort_by_cached_key(|(id, count)| {
            (std::cmp::Reverse(*count), defs[id].name.to_lowercase(), *id)
        });
        columns.extend(extra.into_iter().map(|(id, _)| id.to_owned()));
        if let Some(explicit) = &query.columns {
            columns = explicit.iter().map(|column| column.key.clone()).collect();
        }
        let needed: HashSet<&str> = columns
            .iter()
            .map(String::as_str)
            .chain(query.filters.iter().map(|f| f.field.as_str()))
            .chain(
                query
                    .sort
                    .iter()
                    .filter(|s| s.by == SortBy::Field)
                    .filter_map(|s| s.field.as_deref()),
            )
            .chain(query.group.iter().map(|group| group.key.as_str()))
            .chain(query.card.iter().flatten().map(String::as_str))
            .collect();
        let fields = definitions
            .into_iter()
            .filter(|d| needed.contains(d.id.as_str()))
            .collect();
        let note_groups = self.note_groups(query, &rows)?;
        let groups = crate::entity_query::groups(query, &rows);
        if truncate {
            rows.drain(..query.offset.min(rows.len()));
            rows.truncate(query.limit.unwrap_or(500));
        }
        Ok(QueryResult {
            fields,
            columns,
            rows,
            total,
            note_groups,
            attributes,
            groups,
        })
    }
}

struct PreparedFilter<'a> {
    filter: &'a Filter,
    value: String,
    number: Option<f64>,
    instance: bool,
    owners: Option<HashSet<String>>,
}
impl<'a> PreparedFilter<'a> {
    fn new(conn: &Connection, filter: &'a Filter, kind: FieldKind) -> Result<Self> {
        let owners = if filter.op == FilterOp::Present && !filter.field.starts_with('@') {
            let mut owners = HashSet::new();
            let mut statement = conn.prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT e.text, e.parent_id FROM links l
                 JOIN blocks e ON e.id = l.source_id
                 JOIN blocks o ON o.id = e.parent_id
                 WHERE l.target_id = ?1 AND e.deletion_id IS NULL AND o.deletion_id IS NULL
                 AND e.rowid NOT IN (SELECT rowid FROM hidden)"
            ))?;
            let mut cursor = statement.query([&filter.field])?;
            while let Some(row) = cursor.next()? {
                let text = row.get_ref(0)?.as_str().map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                if crate::fields::reference(text) != Some(filter.field.as_str()) {
                    continue;
                }
                let owner = row.get_ref(1)?.as_str().map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                if !owners.contains(owner) {
                    owners.insert(owner.to_owned());
                }
            }
            Some(owners)
        } else {
            None
        };
        Ok(Self {
            filter,
            owners,
            instance: kind == FieldKind::Instance,
            value: if kind == FieldKind::Date {
                crate::entity_query::relative_date(
                    conn,
                    filter.value.as_deref().unwrap_or_default(),
                )?
            } else {
                filter.value.as_deref().unwrap_or_default().to_lowercase()
            },
            number: if kind == FieldKind::Number && ordered(filter.op) {
                Some(filter_number(
                    filter.value.as_deref().expect("validated filter"),
                )?)
            } else {
                None
            },
        })
    }
    fn matches(&self, row: &QueryRow) -> bool {
        let (empty, matched) = if self.filter.field.starts_with('@') {
            let values = row
                .attributes
                .get(&self.filter.field)
                .map(Vec::as_slice)
                .unwrap_or_default();
            (
                values.is_empty(),
                values.iter().any(|value| {
                    self.compare(
                        &value.reading,
                        if self.filter.op == FilterOp::IsNot {
                            FilterOp::Is
                        } else {
                            self.filter.op
                        },
                    )
                }),
            )
        } else {
            let values = row
                .values
                .get(&self.filter.field)
                .map(Vec::as_slice)
                .unwrap_or_default();
            (
                values.is_empty(),
                values.iter().any(|value| {
                    self.compare(
                        &value.reading,
                        if self.filter.op == FilterOp::IsNot {
                            FilterOp::Is
                        } else {
                            self.filter.op
                        },
                    )
                }),
            )
        };
        if empty && self.filter.or_empty {
            return true;
        }
        match self.filter.op {
            FilterOp::Present if self.filter.field.starts_with('@') => !empty,
            FilterOp::Present => self
                .owners
                .as_ref()
                .is_some_and(|owners| owners.contains(&row.block.block.id)),
            FilterOp::Set => !empty,
            FilterOp::Empty => empty,
            FilterOp::IsNot => !matched,
            _ => matched,
        }
    }
    fn compare(&self, reading: &Reading, op: FilterOp) -> bool {
        let Reading::Value { value, target, .. } = reading else {
            return false;
        };
        if self.instance && op == FilterOp::Is {
            return target.as_deref() == self.filter.value.as_deref();
        }
        let order = if let Some(right) = self.number {
            let ReadingValue::Number(left) = value else {
                return false;
            };
            left.partial_cmp(&right)
                .expect("finite readings and filters")
        } else {
            let text = match value {
                ReadingValue::Text(text) => text.to_lowercase(),
                ReadingValue::Number(number) => number.to_string(),
                ReadingValue::Checkbox(value) => value.to_string(),
            };
            match op {
                FilterOp::Is => return text == self.value,
                FilterOp::Contains => return text.contains(&self.value),
                _ => text.cmp(&self.value),
            }
        };
        match op {
            FilterOp::Gt => order.is_gt(),
            FilterOp::Gte => !order.is_lt(),
            FilterOp::Lt => order.is_lt(),
            FilterOp::Lte => !order.is_gt(),
            _ => false,
        }
    }
}

enum SortValue {
    Text(String),
    Number(f64),
    Checkbox(bool),
    Timestamp(i64),
    Option(usize),
    Problem,
}
impl SortValue {
    fn compare(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Text(a), Self::Text(b)) => a.cmp(b),
            (Self::Number(a), Self::Number(b)) => a.partial_cmp(b).expect("finite readings"),
            (Self::Checkbox(a), Self::Checkbox(b)) => a.cmp(b),
            (Self::Timestamp(a), Self::Timestamp(b)) => a.cmp(b),
            (Self::Option(a), Self::Option(b)) => a.cmp(b),
            _ => unreachable!("a sort key has one field kind"),
        }
    }
}
fn sort_value(
    row: &QueryRow,
    key: &SortKey,
    definitions: &HashMap<&str, &FieldDefinition>,
    option_order: &HashMap<&str, usize>,
) -> Option<SortValue> {
    Some(match key.by {
        SortBy::Title => SortValue::Text(row.block.block.text.to_lowercase()),
        SortBy::Created => SortValue::Timestamp(row.block.block.created_at),
        SortBy::Updated => SortValue::Timestamp(row.block.block.updated_at),
        SortBy::Field => {
            let field = key.field.as_deref()?;
            let definition = definitions.get(field);
            let value = if field.starts_with('@') {
                &row.attributes.get(field)?.first()?.reading
            } else {
                &row.values.get(field)?.first()?.reading
            };
            if definition.is_some_and(|definition| definition.kind == FieldKind::Choice) {
                return Some(match value {
                    Reading::Value {
                        target: Some(target),
                        ..
                    } => option_order
                        .get(target.as_str())
                        .map_or(SortValue::Problem, |index| SortValue::Option(*index)),
                    _ => SortValue::Problem,
                });
            }
            match value {
                Reading::Problem { .. } => return None,
                Reading::Value { value, .. } => match value {
                    ReadingValue::Text(text) => SortValue::Text(
                        if definition.is_some_and(|definition| definition.kind == FieldKind::Date)
                            && text.len() < 4
                        {
                            format!("{text:0>4}")
                        } else {
                            text.to_lowercase()
                        },
                    ),
                    ReadingValue::Number(n) => SortValue::Number(*n),
                    ReadingValue::Checkbox(b) => SortValue::Checkbox(*b),
                },
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Actor, Batch, Operation};

    #[test]
    fn migrated_instance_filters_keep_other_predicates_and_query_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let mut notebook = Notebook::open(directory.path()).unwrap();
        let field = ulid::Ulid::from(10_u128).to_string();
        let person = ulid::Ulid::from(20_u128).to_string();
        notebook
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![
                    Operation::CreatePage {
                        id: person.clone(),
                        title: "Aristotle".into(),
                    },
                    Operation::Insert {
                        id: field.clone(),
                        parent_id: notebook.fields().unwrap().page_id,
                        after: None,
                        text: "Author".into(),
                        heading: None,
                    },
                    Operation::SetFieldKind {
                        id: field.clone(),
                        base_revision: 1,
                        kind: FieldKind::Instance,
                    },
                ],
            })
            .unwrap();
        let source = serde_json::json!({
            "filters": [
                {"field": field, "op": "is", "value": "ARISTOTLE"},
                {"field": field, "op": "is_not", "value": "Aristotle"},
                {"field": field, "op": "contains", "value": "Aristotle"},
                {"field": field, "op": "is", "value": "Missing person"},
                {"field": field, "op": "is", "value": person},
            ],
            "sort": [{"by": "title", "direction": "desc", "field": null}], "limit": 123
        });
        for table in ["views", "decks", "task_views", "library_views"] {
            let json = if table == "views" {
                source.clone()
            } else {
                serde_json::json!({"source": source, "other": true})
            };
            notebook.conn.execute(&format!("INSERT INTO {table}(id, name, query, revision, created_at, updated_at) VALUES ('test', 'test', ?1, 4, 1, 2)"), [json.to_string()]).unwrap();
        }
        migrate_instance_filters(&notebook.conn).unwrap();
        for table in ["views", "decks", "task_views", "library_views"] {
            let (json, revision, updated): (String, i64, i64) = notebook
                .conn
                .query_row(
                    &format!("SELECT query, revision, updated_at FROM {table} WHERE id = 'test'"),
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            let json: serde_json::Value = serde_json::from_str(&json).unwrap();
            let query = if table == "views" {
                &json
            } else {
                &json["source"]
            };
            assert_eq!(query["filters"][0]["value"], person);
            assert_eq!(query["filters"][1]["value"], person);
            assert_eq!(query["filters"][2]["value"], "Aristotle");
            assert_eq!(query["filters"][3]["value"], "Missing person");
            assert_eq!(query["filters"][4]["value"], person);
            assert_eq!(query["sort"], source["sort"]);
            assert_eq!(query["limit"], 123);
            assert_eq!((revision, updated), (4, 2));
        }
    }
}
