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
        _ => Err(validation(format!("unknown setting: {key}"))),
    }
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
        let name: Option<String> = self
            .conn
            .prepare_cached("SELECT value FROM settings WHERE key = 'time_zone'")?
            .query_row([], |row| row.get(0))
            .optional()?;
        match name {
            Some(name) => TimeZone::get(&name).map_err(|error| validation(error.to_string())),
            None => Ok(TimeZone::system()),
        }
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

fn date_in_zone(now_ms: i64, zone: TimeZone) -> Result<String> {
    let instant =
        Timestamp::from_millisecond(now_ms).map_err(|error| validation(error.to_string()))?;
    Ok(instant.to_zoned(zone).date().to_string())
}
