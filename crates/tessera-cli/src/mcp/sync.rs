//! `tessera_sync`: whether this notebook's edits have reached its hub.

use serde_json::Value;

use super::render::age;
use super::{Session, boolean};

impl Session<'_> {
    pub(super) async fn sync(&self, arguments: &Value) -> anyhow::Result<String> {
        let api = self.api().await?;
        let state: Value = if boolean(arguments, "now")?.unwrap_or(false) {
            api.post("/api/sync/run", &serde_json::json!({})).await?
        } else {
            api.get("/api/sync/state").await?
        };
        Ok(describe(&state, tessera_core::now_ms()))
    }
}

/// The service's `/api/sync/state` in a sentence or two.
fn describe(state: &Value, now: i64) -> String {
    let replica = &state["replica"];
    if replica.is_null() {
        return match state["role"].as_str() {
            Some("hub") => "This notebook is the hub other devices sync with.".into(),
            _ => "This notebook does not sync with any other device.".into(),
        };
    }
    let mut text = match (replica["hub_name"].as_str(), replica["hub_url"].as_str()) {
        (Some(name), _) => format!("This notebook is a copy of the notebook on {name}"),
        (None, Some(url)) => format!("This notebook is a copy of the notebook at {url}"),
        (None, None) => "This notebook is a copy of a hub's notebook".into(),
    };
    if let Some(device) = replica["device_name"].as_str() {
        text.push_str(&format!(", synced as {device}"));
    }
    text.push_str(". ");
    if replica["syncing"].as_bool() == Some(true) {
        text.push_str("A sync is running now. ");
    }
    match replica["synced_at"].as_i64() {
        Some(at) => text.push_str(&format!("Last synced {}. ", age(now - at))),
        None => text.push_str("It has not synced yet. "),
    }
    match replica["pending"].as_u64().unwrap_or(0) {
        0 => text.push_str("Every change made here has reached the hub."),
        1 => text.push_str("1 change made here has not reached the hub yet."),
        n => text.push_str(&format!(
            "{n} changes made here have not reached the hub yet."
        )),
    }
    if replica["last_error"]["code"].as_str() == Some("schema_mismatch") {
        if let (Some(local), Some(hub)) = (
            state["this_device"]["schema"].as_u64(),
            replica["hub_version"]["schema"].as_u64(),
        ) {
            let device = replica["device_name"].as_str().unwrap_or("This device");
            let hub_name = replica["hub_name"].as_str().unwrap_or("The hub");
            text.push_str(&format!(
                " {device} runs Tessera {} (schema {local}). {hub_name} runs Tessera {} (schema {hub}).",
                state["this_device"]["version"].as_str().unwrap_or("unknown"),
                replica["hub_version"]["version"].as_str().unwrap_or("unknown"),
            ));
            if local < hub {
                text.push_str(&format!(" Update {device}. It is behind the hub."));
            } else if hub < local {
                text.push_str(&format!(" Update {hub_name}. It is behind this device."));
            }
        } else if let Some(message) = replica["last_error"]["message"].as_str() {
            text.push_str(&format!(" The last sync failed: {message}."));
        }
    } else if let Some(message) = replica["last_error"]["message"].as_str() {
        text.push_str(&format!(" The last sync failed: {message}."));
    }
    if replica["retired"].as_bool() == Some(true) {
        text.push_str(
            " The hub retired this copy; run `tessera sync reclone` on this machine to fetch it again.",
        );
    }
    let kept = replica["kept_copies"].as_u64().unwrap_or(0);
    let rejected = replica["rejected"].as_u64().unwrap_or(0);
    if kept + rejected > 0 {
        text.push_str(&format!(
            " {kept} kept conflict copies and {rejected} changes the hub rejected; \
             `tessera sync conflicts` lists them."
        ));
    }
    text
}
