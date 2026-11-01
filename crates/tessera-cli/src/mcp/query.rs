//! `tessera_query`: list types, fields and saved views, or run a typed
//! query, naming fields instead of their IDs.

use std::collections::HashMap;

use anyhow::Context;
use serde_json::Value;
use tessera_core::{
    Direction, FieldDefinition, FieldValue, FieldsView, Filter, FilterOp, Query, QueryResult,
    QueryRow, Reading, ReadingValue, SortBy, SortKey, TypeInfo, View,
};

use super::cards::type_id;
use super::render::{location, name, one_line};
use super::{Api, Session, Titles, choice, integer, limit, string};

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
        let source = string(arguments, "source")?;
        let mut query = match (string(arguments, "type")?, string(arguments, "view")?) {
            (None, None) if source.is_none() => {
                unused(
                    arguments,
                    &["text", "filters", "sort", "direction", "limit", "offset"],
                    "without source, type or view; give one of them to query, or leave these \
                     out to list types, fields and saved views",
                )?;
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
        if let Some(source) = source {
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
        if let Some(key) = sort_key(arguments, &definitions)? {
            query.sort = vec![key];
        }
        query.limit = Some(limit(arguments, "limit", 50, 500)?);
        if let Some(offset) = integer(arguments, "offset")? {
            query.offset = usize::try_from(offset)
                .ok()
                .context("offset must be 0 or more")?;
        }
        let result: QueryResult = api.post("/api/query", &query).await?;
        if result.rows.is_empty() {
            return Ok(match result.total {
                0 => "No atoms match.".into(),
                total => format!(
                    "{total} atoms match, so offset {} is past the end; give an offset below {total}.",
                    query.offset
                ),
            });
        }
        let names: HashMap<&str, &str> = definitions
            .iter()
            .copied()
            .chain(&result.fields)
            .map(|field| (field.id.as_str(), field.name.as_str()))
            .collect();
        let titles = Titles::load(&api, result.rows.iter().flat_map(row_texts)).await?;
        let mut text = format!(
            "{} of {} atoms, from offset {}:\n",
            result.rows.len(),
            result.total,
            query.offset
        );
        for row in &result.rows {
            text.push_str(&row_line(row, &result.columns, &names, &titles));
        }
        Ok(text)
    }
}

/// One row: its block's text and place, its attributes, and its field values
/// with the value block IDs that edit them. Without columns, it shows every
/// field the row has.
fn row_line(
    row: &QueryRow,
    columns: &[String],
    names: &HashMap<&str, &str>,
    titles: &Titles,
) -> String {
    let mut text = format!(
        "- {} (block {}) {}",
        titles.show(&one_line(&row.block.block.text)),
        row.block.block.id,
        location(&row.block.page)
    );
    // Task fields also come keyed by their field IDs, repeating `@status` and
    // the other task attributes.
    for (key, values) in &row.attributes {
        if key.starts_with('@') && !values.is_empty() {
            let shown: Vec<_> = values
                .iter()
                .map(|value| {
                    let text = titles.show(&one_line(&value.text));
                    match &value.reading {
                        Reading::Value {
                            target: Some(target),
                            ..
                        } => format!("{text} ({target})"),
                        _ => text,
                    }
                })
                .collect();
            text.push_str(&format!("; {key}: {}", shown.join(", ")));
        }
    }
    let keys: Vec<&String> = if columns.is_empty() {
        row.values.keys().collect()
    } else {
        columns.iter().collect()
    };
    let values: Vec<_> = keys
        .into_iter()
        .filter_map(|column| {
            let values = row.values.get(column).filter(|values| !values.is_empty())?;
            let shown: Vec<_> = values
                .iter()
                .map(|value| format!("{} (value {})", titles.show(&value_text(value)), value.id))
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
    text
}

/// The block and field texts a row prints, which may link pages by ID.
fn row_texts(row: &QueryRow) -> impl Iterator<Item = &str> {
    let values = row.values.values().flatten().flat_map(|value| {
        let reading = match &value.reading {
            Reading::Value {
                value: ReadingValue::Text(text),
                ..
            } => Some(text.as_str()),
            _ => None,
        };
        std::iter::once(value.text.as_str()).chain(reading)
    });
    std::iter::once(row.block.block.text.as_str())
        .chain(
            row.attributes
                .values()
                .flatten()
                .map(|value| value.text.as_str()),
        )
        .chain(values)
}

/// Refuses the arguments among `keys` that a call gives but would not use,
/// saying `when` they go unused. An empty array counts as not given.
pub(super) fn unused(arguments: &Value, keys: &[&str], when: &str) -> anyhow::Result<()> {
    let given: Vec<&str> = keys
        .iter()
        .copied()
        .filter(|key| match arguments.get(key) {
            None | Some(Value::Null) => false,
            Some(Value::Array(items)) => !items.is_empty(),
            Some(_) => true,
        })
        .collect();
    match given.as_slice() {
        [] => Ok(()),
        [key] => anyhow::bail!("{key} is not used {when}."),
        [first @ .., last] => anyhow::bail!("{} and {last} are not used {when}.", first.join(", ")),
    }
}

/// Tags with their fields, field definitions with kinds, and saved views.
async fn overview(api: &Api, fields: &FieldsView) -> anyhow::Result<String> {
    let types: Vec<TypeInfo> = api.get("/api/types").await?;
    let views: Vec<View> = api.get("/api/views").await?;
    let names: HashMap<&str, &str> = fields
        .fields
        .iter()
        .map(|field| (field.definition.id.as_str(), field.definition.name.as_str()))
        .collect();
    let mut text = String::from("Tags:\n");
    if types.is_empty() {
        text.push_str("- None yet; #tag in atom text makes one.\n");
    }
    for info in &types {
        text.push_str(&format!(
            "- {} (tag {}): {} members",
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
        text.push_str("- None yet; `Name:: value` in atom text makes one.\n");
    }
    for field in &fields.fields {
        text.push_str(&format!(
            "- {} (field {}): {}, on {} atoms",
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

/// The `sort` and `direction` arguments as a sort key. A direction is checked
/// even when it cannot apply, and refused without sort.
fn sort_key(
    arguments: &Value,
    definitions: &[&FieldDefinition],
) -> anyhow::Result<Option<SortKey>> {
    let direction: Option<Direction> = string(arguments, "direction")?
        .map(|direction| choice(direction, "direction", "asc or desc"))
        .transpose()?;
    let Some(sort) = string(arguments, "sort")? else {
        unused(arguments, &["direction"], "without sort")?;
        return Ok(None);
    };
    let (by, field) = match sort.to_lowercase().as_str() {
        "title" => (SortBy::Title, None),
        "created" => (SortBy::Created, None),
        "updated" => (SortBy::Updated, None),
        _ => (SortBy::Field, Some(field_id(definitions, sort)?)),
    };
    Ok(Some(SortKey {
        by,
        field,
        direction: direction.unwrap_or(Direction::Asc),
    }))
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
            Ok(Filter {
                or_empty: super::boolean(filter, "or_empty")?.unwrap_or(false),
                field: field_id(definitions, field)?,
                op: op(string(filter, "op")?.unwrap_or("is"))?,
                value: string(filter, "value")?.map(str::to_owned),
            })
        })
        .collect()
}

/// A filter operator by name, from those the tool's schema lists. The core's
/// before, after and overlaps compare year spans only, and match nothing on
/// other fields.
fn op(name: &str) -> anyhow::Result<FilterOp> {
    Ok(match name {
        "is" => FilterOp::Is,
        "is_not" => FilterOp::IsNot,
        "contains" => FilterOp::Contains,
        "gt" => FilterOp::Gt,
        "gte" => FilterOp::Gte,
        "lt" => FilterOp::Lt,
        "lte" => FilterOp::Lte,
        "set" => FilterOp::Set,
        "empty" => FilterOp::Empty,
        _ => anyhow::bail!("op must be {OPS}, not {name:?}"),
    })
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
    use std::collections::HashMap;

    use serde_json::json;
    use tessera_core::{Direction, FilterOp, QueryRow, SortBy};

    use super::super::Titles;

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

    #[test]
    fn filters_take_only_the_operators_the_schema_lists() {
        for op in ["before", "after", "overlaps", "present", "IS"] {
            let error = super::filters(
                &json!({"filters": [{"field": "@created", "op": op, "value": "today"}]}),
                &[],
            )
            .unwrap_err();
            assert!(error.to_string().starts_with("op must be is,"), "{error:#}");
        }
        let filters = super::filters(
            &json!({"filters": [
                {"field": "@title", "value": "Seneca"},
                {"field": "@created", "op": "lte", "value": "-3d"}
            ]}),
            &[],
        )
        .unwrap();
        assert_eq!(
            (filters[0].op, filters[1].op),
            (FilterOp::Is, FilterOp::Lte)
        );
    }

    #[test]
    fn direction_is_checked_and_needs_sort() {
        let sort = |arguments: serde_json::Value| super::sort_key(&arguments, &[]);
        assert!(sort(json!({"sort": "title", "direction": "sideways"})).is_err());
        assert!(sort(json!({"direction": "sideways"})).is_err());
        assert!(sort(json!({"direction": "desc"})).is_err());
        assert_eq!(sort(json!({"direction": null})).unwrap(), None);
        let key = sort(json!({"sort": "Title", "direction": "desc"}))
            .unwrap()
            .unwrap();
        assert_eq!((key.by, key.direction), (SortBy::Title, Direction::Desc));
    }

    #[test]
    fn unused_arguments_are_named_and_absent_ones_are_not() {
        let unused = |arguments: serde_json::Value| {
            super::unused(&arguments, &["text", "filters", "sort"], "here")
                .map_err(|error| error.to_string())
        };
        assert_eq!(
            unused(json!({"text": null, "filters": [], "limit": 3})),
            Ok(())
        );
        let error = unused(json!({"text": "", "filters": [{"field": "Stage"}], "sort": "title"}))
            .unwrap_err();
        assert!(
            ["text", "filters", "sort"]
                .iter()
                .all(|key| error.contains(key)),
            "{error}"
        );
    }

    #[test]
    fn rows_show_fields_by_name_once_and_links_by_title() {
        let block = |id: &str, text: &str| {
            json!({
                "id": id, "kind": "block", "parent_id": null, "page_id": "01M69SDR0PAFT5N3E0VJV2SN00",
                "text": text, "heading": null, "archived": false, "revision": 1,
                "created_at": 0, "updated_at": 0,
            })
        };
        let reading = |text: &str| json!({"ok": true, "value": text, "target": null});
        let row: QueryRow = serde_json::from_value(json!({
            "block": {
                "block": block(
                    "01M69SDR0PAFT5N3E0VJV2SN01",
                    "Call [[01M69SDR0PH6G034X86TSBHMVY]] about the tiles",
                ),
                "page": block("01M69SDR0PAFT5N3E0VJV2SN00", "Renovation"),
            },
            "values": {
                "01M69SDQZNP4C3JYP9GGSVQY2H": [{
                    "id": "01M69SDR0PAFT5N3E0VJV2SN02", "text": "Budding", "reading": reading("Budding"),
                }],
            },
            "attributes": {
                "@status": [{"text": "todo", "reading": reading("todo")}],
                "4QRRNZC7NTQX8N70SJE8PRRWJB": [{"text": "todo", "reading": reading("todo")}],
            },
        }))
        .unwrap();
        let titles = Titles(HashMap::from([(
            "01M69SDR0PH6G034X86TSBHMVY".to_owned(),
            "Hana Okafor".to_owned(),
        )]));
        let names = HashMap::from([("01M69SDQZNP4C3JYP9GGSVQY2H", "Stage")]);
        let line = super::row_line(&row, &[], &names, &titles);
        assert!(
            line.starts_with("- Call [[Hana Okafor]] about the tiles (block "),
            "{line}"
        );
        assert_eq!(line.matches("todo").count(), 1, "{line}");
        assert!(!line.contains("4QRRNZC7NTQX8N70SJE8PRRWJB"), "{line}");
        assert!(
            line.ends_with(": Stage: Budding (value 01M69SDR0PAFT5N3E0VJV2SN02)\n"),
            "{line}"
        );
    }
}
