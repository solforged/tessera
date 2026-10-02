use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::fields::{definition_map, definitions, reading};
use crate::reads::{fts_query, hidden_blocks};
use crate::storage::{block_at, block_columns, not_found, validate_id, validation};
use crate::{
    BlockKind, Direction, FieldDefinition, FieldKind, FieldValue, Filter, FilterOp, Notebook,
    Query, QueryResult, QueryRow, Reading, ReadingValue, Result, SortBy, SortKey, TypeInfo, View,
};

pub(crate) fn validate_query(conn: &Connection, query: &Query) -> Result<Vec<FieldDefinition>> {
    if query.r#type.is_none() && query.text.is_none() {
        return Err(validation("query needs a type or text"));
    }
    if let Some(id) = &query.r#type {
        validate_id(id)?;
    }
    if query.limit.is_some_and(|limit| limit > 2000) {
        return Err(validation("query limit must not exceed 2000"));
    }
    let definitions = definitions(conn)?;
    let defs = definition_map(&definitions);
    let require = |id: &str| -> Result<&FieldDefinition> {
        defs.get(id)
            .copied()
            .ok_or_else(|| validation(format!("not a live field definition: {id}")))
    };
    for filter in &query.filters {
        let definition = require(&filter.field)?;
        if !matches!(filter.op, FilterOp::Set | FilterOp::Empty) && filter.value.is_none() {
            return Err(validation("filter value is required"));
        }
        if definition.kind == FieldKind::Number && ordered(filter.op) {
            filter_number(filter.value.as_deref().expect("validated filter value"))?;
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
    Ok(definitions)
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
            "SELECT COUNT(*) FROM memberships m JOIN blocks b ON b.id = m.block_id
             JOIN blocks p ON p.id = b.page_id JOIN blocks t ON t.id = m.type_id
             WHERE m.type_id = ?1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL AND t.deletion_id IS NULL
             AND b.rowid NOT IN (SELECT rowid FROM hidden) AND t.rowid NOT IN (SELECT rowid FROM hidden)"))?
            .query_row([id], |row| row.get::<_, i64>(0))? as usize;
        Ok(TypeInfo {
            page,
            fields: template(&self.conn, id)?,
            members,
        })
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
        let definitions = validate_query(&self.conn, query)?;
        let defs = definition_map(&definitions);
        let matched = query.text.as_deref().map(fts_query);
        let mut rows: Vec<QueryRow> = Vec::new();
        if matched.as_ref().is_none_or(|text| !text.is_empty()) {
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
                  ORDER BY b.id, e.ordinal, e.id, f.ordinal, v.id"))?;
            let mut cursor = statement.query(params![query.r#type, matched])?;
            while let Some(row) = cursor.next()? {
                let id: &str = row.get_ref(0)?.as_str().map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                if rows.last().is_none_or(|r| r.block.block.id != id) {
                    rows.push(QueryRow {
                        block: crate::BlockInPage {
                            block: block_at(row, 0)?,
                            page: block_at(row, 10)?,
                        },
                        values: BTreeMap::new(),
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
                    let reading = reading(definition.kind, &field, text, target.as_ref());
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
        let filters = query
            .filters
            .iter()
            .map(|filter| PreparedFilter::new(filter, defs[filter.field.as_str()].kind))
            .collect::<Result<Vec<_>>>()?;
        rows.retain(|row| filters.iter().all(|filter| filter.matches(row)));
        let total = rows.len();
        if !query.sort.is_empty() {
            let mut keyed: Vec<_> = rows
                .into_iter()
                .map(|row| {
                    let keys = query
                        .sort
                        .iter()
                        .map(|key| sort_value(&row, key))
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
        rows.truncate(query.limit.unwrap_or(500));
        let mut columns = query
            .r#type
            .as_deref()
            .map(|id| template(&self.conn, id))
            .transpose()?
            .unwrap_or_default();
        columns.retain(|id| defs.contains_key(id.as_str()));
        let mut frequencies: HashMap<&str, usize> = HashMap::new();
        for row in &rows {
            for field in row.values.keys() {
                *frequencies.entry(field).or_default() += 1;
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
            .collect();
        let fields = definitions
            .into_iter()
            .filter(|d| needed.contains(d.id.as_str()))
            .collect();
        Ok(QueryResult {
            fields,
            columns,
            rows,
            total,
        })
    }
}

struct PreparedFilter<'a> {
    filter: &'a Filter,
    value: String,
    number: Option<f64>,
}
impl<'a> PreparedFilter<'a> {
    fn new(filter: &'a Filter, kind: FieldKind) -> Result<Self> {
        Ok(Self {
            filter,
            value: filter.value.as_deref().unwrap_or_default().to_lowercase(),
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
        let values = row
            .values
            .get(&self.filter.field)
            .map(Vec::as_slice)
            .unwrap_or_default();
        match self.filter.op {
            FilterOp::Set => !values.is_empty(),
            FilterOp::Empty => values.is_empty(),
            FilterOp::IsNot => !values.iter().any(|v| self.compare(v, FilterOp::Is)),
            op => values.iter().any(|v| self.compare(v, op)),
        }
    }
    fn compare(&self, field: &FieldValue, op: FilterOp) -> bool {
        let Reading::Value { value, .. } = &field.reading else {
            return false;
        };
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
}
impl SortValue {
    fn compare(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Text(a), Self::Text(b)) => a.cmp(b),
            (Self::Number(a), Self::Number(b)) => a.partial_cmp(b).expect("finite readings"),
            (Self::Checkbox(a), Self::Checkbox(b)) => a.cmp(b),
            (Self::Timestamp(a), Self::Timestamp(b)) => a.cmp(b),
            _ => unreachable!("a sort key has one field kind"),
        }
    }
}
fn sort_value(row: &QueryRow, key: &SortKey) -> Option<SortValue> {
    Some(match key.by {
        SortBy::Title => SortValue::Text(row.block.block.text.to_lowercase()),
        SortBy::Created => SortValue::Timestamp(row.block.block.created_at),
        SortBy::Updated => SortValue::Timestamp(row.block.block.updated_at),
        SortBy::Field => {
            let value = &row.values.get(key.field.as_deref()?)?.first()?.reading;
            match value {
                Reading::Problem { .. } => return None,
                Reading::Value { value, .. } => match value {
                    ReadingValue::Text(text) => SortValue::Text(text.to_lowercase()),
                    ReadingValue::Number(n) => SortValue::Number(*n),
                    ReadingValue::Checkbox(b) => SortValue::Checkbox(*b),
                },
            }
        }
    })
}
