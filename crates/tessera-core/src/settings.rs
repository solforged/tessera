use jiff::{Timestamp, tz::TimeZone};
use rusqlite::OptionalExtension;

use crate::storage::validation;
use crate::{Notebook, Result, Setting, SettingsView};

pub(crate) fn validate_setting(key: &str, value: &str) -> Result<()> {
    match key {
        "time_zone" => {
            TimeZone::get(value).map_err(|_| validation("time_zone must be an IANA time zone"))?;
            Ok(())
        }
        "vim" if matches!(value, "true" | "false") => Ok(()),
        "vim" => Err(validation("vim must be true or false")),
        "confirm_view_delete" if matches!(value, "true" | "false") => Ok(()),
        "confirm_view_delete" => Err(validation("confirm_view_delete must be true or false")),
        "library_creator_targets" | "task_field_template" if value == "true" => Ok(()),
        "today_template" => validate_today_template(value),
        _ => Err(validation(format!("unknown setting: {key}"))),
    }
}

/// Today's sections in order. Plan, Research and Highlights are generated; Notes
/// always shows; every other section is written into the day's outline.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TodayTemplate {
    sections: Vec<TodaySection>,
    capture: String,
    links: String,
    // Read only to check its shape.
    #[serde(rename = "tiles")]
    _tiles: TodayTiles,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TodaySection {
    id: String,
    name: String,
    on: bool,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct TodayTiles {
    agenda: bool,
    review: bool,
    reading: bool,
}

const TODAY_BUILT_IN: [&str; 6] = [
    "plan",
    "inbox",
    "reading",
    "notes",
    "research",
    "highlights",
];
const TODAY_GENERATED: [&str; 3] = ["plan", "research", "highlights"];

fn validate_today_template(value: &str) -> Result<()> {
    let template: TodayTemplate = serde_json::from_str(value)
        .map_err(|error| validation(format!("today_template is not a template: {error}")))?;
    let mut ids = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();
    for section in &template.sections {
        let name = section.name.trim();
        if section.id.is_empty() || section.id.len() > 64 {
            return Err(validation(
                "today_template section ids must be 1 to 64 bytes",
            ));
        }
        if name.is_empty() || name.chars().count() > 80 || name.contains(['\n', '\r']) {
            return Err(validation(
                "today_template section names must be one line of 1 to 80 characters",
            ));
        }
        if !ids.insert(section.id.as_str()) || !names.insert(name.to_lowercase()) {
            return Err(validation(
                "today_template sections must have distinct ids and names",
            ));
        }
    }
    if let Some(missing) = TODAY_BUILT_IN.iter().find(|id| !ids.contains(**id)) {
        return Err(validation(format!(
            "today_template is missing the {missing} section"
        )));
    }
    if !template
        .sections
        .iter()
        .any(|section| section.id == "notes" && section.on)
    {
        return Err(validation("today_template must keep Notes on"));
    }
    let written = |id: &str| !TODAY_GENERATED.contains(&id) && id != "notes";
    if !template
        .sections
        .iter()
        .any(|section| section.id == template.capture && section.on && written(&section.id))
    {
        return Err(validation(
            "today_template must capture into a written section that is on",
        ));
    }
    if !matches!(template.links.as_str(), "link" | "source") {
        return Err(validation("today_template links must be link or source"));
    }
    Ok(())
}

impl Notebook {
    pub fn settings(&self) -> Result<Vec<Setting>> {
        Ok(self
            .conn
            .prepare_cached("SELECT key, value, revision, updated_at FROM settings ORDER BY key")?
            .query_map([], |row| {
                Ok(Setting {
                    key: row.get(0)?,
                    value: row.get(1)?,
                    revision: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// An unset notebook uses the service host's local zone, discovered by
    /// Jiff from the operating system. Jiff falls back to UTC if unavailable.
    fn time_zone(&self) -> Result<TimeZone> {
        time_zone(&self.conn)
    }

    /// Calendar date in the notebook zone at a Unix millisecond timestamp.
    pub fn today(&self, now_ms: i64) -> Result<String> {
        date_in_zone(now_ms, self.time_zone()?)
    }

    pub fn settings_view(&self, now_ms: i64) -> Result<SettingsView> {
        let zone = self.time_zone()?;
        Ok(SettingsView {
            settings: self.settings()?,
            time_zone: zone.iana_name().unwrap_or("UTC").to_owned(),
            today: date_in_zone(now_ms, zone)?,
        })
    }
}

pub(crate) fn time_zone(conn: &rusqlite::Connection) -> Result<TimeZone> {
    let name: Option<String> = conn
        .prepare_cached("SELECT value FROM settings WHERE key = 'time_zone'")?
        .query_row([], |row| row.get(0))
        .optional()?;
    match name {
        Some(name) => TimeZone::get(&name).map_err(|error| validation(error.to_string())),
        None => Ok(TimeZone::system()),
    }
}

pub(crate) fn today_in_connection(conn: &rusqlite::Connection, now_ms: i64) -> Result<String> {
    date_in_zone(now_ms, time_zone(conn)?)
}

pub(crate) fn date_in_zone(now_ms: i64, zone: TimeZone) -> Result<String> {
    let instant =
        Timestamp::from_millisecond(now_ms).map_err(|error| validation(error.to_string()))?;
    Ok(instant.to_zoned(zone).date().to_string())
}
