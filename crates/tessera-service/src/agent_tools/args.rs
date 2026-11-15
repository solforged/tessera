//! Reading a tool call's JSON arguments. A wrong type is an error that names
//! the argument, and null counts as left out, as it does for every tool.

use anyhow::Context;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

/// An optional string argument; present but not a string is an error.
pub fn string<'a>(arguments: &'a Value, key: &str) -> anyhow::Result<Option<&'a str>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => anyhow::bail!("{key} must be a string"),
    }
}

pub fn required(arguments: &Value, key: &str) -> anyhow::Result<String> {
    Ok(string(arguments, key)?
        .with_context(|| format!("{key} is required"))?
        .to_owned())
}

/// An optional integer argument; present but not an integer is an error. A
/// number with no fractional part counts, as it does in JSON Schema.
pub fn integer(arguments: &Value, key: &str) -> anyhow::Result<Option<i64>> {
    // 2^63, the first float past `i64::MAX`.
    const END: f64 = -(i64::MIN as f64);
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(
            value
                .as_i64()
                .or_else(|| {
                    value
                        .as_f64()
                        .filter(|number| number.fract() == 0.0 && (-END..END).contains(number))
                        .map(|number| number as i64)
                })
                .with_context(|| format!("{key} must be an integer"))?,
        )),
    }
}

/// An optional boolean argument; present but not a boolean is an error.
pub fn boolean(arguments: &Value, key: &str) -> anyhow::Result<Option<bool>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => anyhow::bail!("{key} must be a boolean"),
    }
}

/// A count argument from 1 to `max`, `default` when absent.
pub fn limit(arguments: &Value, key: &str, default: usize, max: usize) -> anyhow::Result<usize> {
    match integer(arguments, key)? {
        None => Ok(default),
        Some(value) if value >= 1 && value as u64 <= max as u64 => Ok(value as usize),
        Some(_) => anyhow::bail!("{key} must be from 1 to {max}"),
    }
}

/// A snake_case enum value from a string argument, naming the choices on error.
pub fn choice<T: DeserializeOwned>(value: &str, key: &str, choices: &str) -> anyhow::Result<T> {
    serde_json::from_value(json!(value))
        .with_context(|| format!("{key} must be {choices}, not {value:?}"))
}

/// Whether `arguments` gives `key` a value; null counts as left out.
pub fn given(arguments: &Value, key: &str) -> bool {
    arguments.get(key).is_some_and(|value| !value.is_null())
}

/// Refuses the arguments `tool` does not declare, which it would otherwise
/// ignore, naming those it takes.
pub fn undeclared(
    tool: &str,
    declared: &Map<String, Value>,
    arguments: &Value,
) -> anyhow::Result<()> {
    let unknown: Vec<&str> = arguments
        .as_object()
        .into_iter()
        .flat_map(Map::keys)
        .map(String::as_str)
        .filter(|key| !declared.contains_key(*key))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    let takes: Vec<&str> = declared.keys().map(String::as_str).collect();
    anyhow::bail!(
        "{tool} does not take {}; it takes {}.",
        listed(&unknown),
        listed(&takes)
    )
}

/// Names joined as prose: "a", "a and b", "a, b and c".
fn listed(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [first @ .., last] => format!("{} and {last}", first.join(", ")),
    }
}
