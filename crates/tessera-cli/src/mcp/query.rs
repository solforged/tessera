//! `tessera_query`: list types, fields and saved views, or run a typed
//! query, naming fields instead of their IDs.

use std::collections::HashMap;

use anyhow::Context;
use serde_json::Value;
use tessera_core::{
    Direction, FieldDefinition, FieldValue, FieldsView, Filter, FilterOp, Query, QueryResult,
    Reading, ReadingValue, SortBy, SortKey, TypeInfo, View,
};

use super::cards::type_id;
use super::render::{location, name, one_line};
use super::{Api, Session, choice, integer, limit, string};

const OPS: &str = "is, is_not, contains, gt, gte, lt, lte, set or empty";

impl Session<'_> {
    pub(super) async fn query(&self, arguments: &Value) -> anyhow::Result<String> {
        let api = self.api().await?;
        let fields: FieldsView = api.get("/api/fields").await?;
        let definitions: Vec<&FieldDefinition> = fields
            .fields
            .iter()
            .map(|field| &field.definition)
            .collect();
        let mut query = match (string(arguments, "type")?, string(arguments, "view")?) {
            (None, None) if string(arguments, "source")?.is_none() => {
                return overview(&api, &fields).await;
            }
            (None, None) => Query::default(),
            (Some(_), Some(_)) => anyhow::bail!("Give type or view, not both."),
            (Some(wanted), None) => Query {
                r#type: Some(type_id(&api, wanted).await?),
                text: None,
                filters: Vec::new(),
                sort: Vec::new(),
                limit: None,
                offset: 0,
                ..Default::default()
            },
            (None, Some(wanted)) => {
                let views: Vec<View> = api.get("/api/views").await?;
                views
                    .into_iter()
                    .find(|view| view.id == wanted || view.name.eq_ignore_ascii_case(wanted))
                    .with_context(|| format!("No saved view is named {wanted:?}."))?
                    .query
            }
        };
        if let Some(source) = string(arguments, "source")? {
            query.source = Some(choice(
                source,
                "source",
                "notes, questions, positions, sources, tasks or highlights",
            )?);
        }
        if let Some(text) = string(arguments, "text")? {
            query.text = Some(text.to_owned());
        }
        query.filters.extend(filters(arguments, &definitions)?);
        if let Some(sort) = string(arguments, "sort")? {
            let direction = match string(arguments, "direction")? {
                None => Direction::Asc,
                Some(direction) => choice(direction, "direction", "asc or desc")?,
            };
            let (by, field) = match sort.to_lowercase().as_str() {
                "title" => (SortBy::Title, None),
                "created" => (SortBy::Created, None),
                "updated" => (SortBy::Updated, None),
                _ => (SortBy::Field, Some(field_id(&definitions, sort)?)),
            };
            query.sort = vec![SortKey {
                by,
                field,
                direction,
            }];
        }
        query.limit = Some(limit(arguments, "limit", 50, 500)?);
        if let Some(offset) = integer(arguments, "offset")? {
            query.offset = usize::try_from(offset).context("offset must be 0 or more")?;
        }
        let result: QueryResult = api.post("/api/query", &query).await?;
        let names: HashMap<&str, &str> = result
            .fields
            .iter()
            .map(|field| (field.id.as_str(), field.name.as_str()))
            .collect();
        if result.rows.is_empty() {
            return Ok("No blocks match.".into());
        }
        let mut text = format!(
            "{} of {} blocks, from offset {}:\n",
            result.rows.len(),
            result.total,
            query.offset
        );
        for row in &result.rows {
            text.push_str(&format!(
                "- {} (block {}) {}",
                one_line(&row.block.block.text),
                row.block.block.id,
                location(&row.block.page)
            ));
            for (key, values) in &row.attributes {
                if !values.is_empty() {
                    text.push_str(&format!(
                        "; {key}: {}",
                        values
                            .iter()
                            .map(|value| {
                                match &value.reading {
                                    Reading::Value {
                                        target: Some(target),
                                        ..
                                    } => format!("{} ({target})", one_line(&value.text)),
                                    _ => one_line(&value.text),
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
            }
            let values: Vec<_> = result
                .columns
                .iter()
                .filter_map(|column| {
                    let values = row.values.get(column).filter(|values| !values.is_empty())?;
                    let shown: Vec<_> = values
                        .iter()
                        .map(|value| format!("{} (value {})", value_text(value), value.id))
                        .collect();
                    Some(format!(
                        "{}: {}",
                        names.get(column.as_str()).unwrap_or(&column.as_str()),
                        shown.join(", ")
                    ))
                })
                .collect();
            if !values.is_empty() {
                text.push_str(": ");
                text.push_str(&values.join("; "));
            }
            text.push('\n');
        }
        Ok(text)
    }
}

/// Types with their fields, field definitions with kinds, and saved views.
async fn overview(api: &Api, fields: &FieldsView) -> anyhow::Result<String> {
    let types: Vec<TypeInfo> = api.get("/api/types").await?;
    let views: Vec<View> = api.get("/api/views").await?;
    let names: HashMap<&str, &str> = fields
        .fields
        .iter()
        .map(|field| (field.definition.id.as_str(), field.definition.name.as_str()))
        .collect();
    let mut text = String::from("Types:\n");
    if types.is_empty() {
        text.push_str("- None yet; #Tag in block text makes one.\n");
    }
    for info in &types {
        text.push_str(&format!(
            "- {} (type page {}): {} members",
            info.page.text, info.page.id, info.members
        ));
        if !info.fields.is_empty() {
            let shown: Vec<_> = info
                .fields
                .iter()
                .map(|id| *names.get(id.as_str()).unwrap_or(&id.as_str()))
                .collect();
            text.push_str(&format!("; fields {}", shown.join(", ")));
        }
        if info.card_templates > 0 {
            text.push_str(&format!("; {} card templates", info.card_templates));
        }
        text.push('\n');
    }
    text.push_str("Fields:\n");
    if fields.fields.is_empty() {
        text.push_str("- None yet; `Name:: value` in block text makes one.\n");
    }
    for field in &fields.fields {
        text.push_str(&format!(
            "- {} (field {}): {}, on {} blocks",
            field.definition.name,
            field.definition.id,
            name(field.definition.kind),
            field.owners
        ));
        if !field.definition.options.is_empty() {
            let options: Vec<_> = field
                .definition
                .options
                .iter()
                .map(|option| option.text.as_str())
                .collect();
            text.push_str(&format!("; options {}", options.join(", ")));
        }
        text.push('\n');
    }
    if !views.is_empty() {
        text.push_str("Saved views:\n");
        for view in &views {
            text.push_str(&format!("- {} (view {})\n", view.name, view.id));
        }
    }
    Ok(text)
}

/// A field definition's ID from its name or ID, ignoring case.
fn field_id(definitions: &[&FieldDefinition], wanted: &str) -> anyhow::Result<String> {
    if wanted.starts_with('@') {
        return Ok(wanted.to_owned());
    }
    definitions
        .iter()
        .find(|field| field.id == wanted || field.name.eq_ignore_ascii_case(wanted))
        .map(|field| field.id.clone())
        .with_context(|| {
            format!("No field is named {wanted:?}; tessera_query without type lists fields.")
        })
}

/// The `filters` argument, `[{field, op, value}]` with fields by name.
pub(super) fn filters(
    arguments: &Value,
    definitions: &[&FieldDefinition],
) -> anyhow::Result<Vec<Filter>> {
    let Some(filters) = arguments.get("filters").filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let filters = filters.as_array().context("filters must be an array")?;
    filters
        .iter()
        .map(|filter| {
            let field = string(filter, "field")?.context("each filter needs a field")?;
            let op = string(filter, "op")?.unwrap_or("is");
            let op: FilterOp = choice(op, "op", OPS)?;
            anyhow::ensure!(op != FilterOp::Present, "op must be {OPS}, not \"present\"");
            Ok(Filter {
                or_empty: super::boolean(filter, "or_empty")?.unwrap_or(false),
                field: field_id(definitions, field)?,
                op,
                value: string(filter, "value")?.map(str::to_owned),
            })
        })
        .collect()
}

/// A value's reading, or its text with the problem that kept it unread.
fn value_text(value: &FieldValue) -> String {
    match &value.reading {
        Reading::Value { value: reading, .. } => match reading {
            ReadingValue::Text(text) => one_line(text),
            ReadingValue::Number(number) => number.to_string(),
            ReadingValue::Checkbox(checked) => checked.to_string(),
            ReadingValue::Span(_) => one_line(&value.text),
        },
        Reading::Problem { problem, .. } => format!("{} ({problem})", one_line(&value.text)),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn attribute_filters_preserve_instance_ids_and_empty_option() {
        let id = "01M4RZJX98EF6B3WZHPRT2F68S";
        let filters = super::filters(
            &serde_json::json!({"filters": [
                {"field": "@holder", "value": id},
                {"field": "@last_assessed", "op": "lt", "value": "-30d", "or_empty": true}
            ]}),
            &[],
        )
        .unwrap();
        assert_eq!(filters[0].value.as_deref(), Some(id));
        assert!(filters[1].or_empty);
    }
}
