//! `tessera sync`: keep a replica of a hub workshop. See `docs/sync.md`.

use std::path::Path;

use anyhow::Context;
use clap::Subcommand;
use serde_json::json;
use tessera_core::sync::Hub;
use tessera_core::{DATABASE_FILE, Workshop, WorkshopOwnership};
use tessera_service::sync_client::{HttpHub, Pairing};

#[derive(Subcommand)]
pub(crate) enum SyncCommand {
    /// Make the workshop directory a new replica of the hub at URL, e.g.
    /// http://127.0.0.1:4318.
    Clone {
        url: String,
        /// One-time code shown by the hub. Omit only for loopback editor clones.
        #[arg(long)]
        code: Option<String>,
        /// This device's name on the hub.
        #[arg(long, requires = "code")]
        name: Option<String>,
    },
    /// Show this replica's hub and unpushed changes. While a service owns the
    /// workshop, show the service's sync state, with the last sync and error.
    Status,
    /// List kept conflict text and changes the hub rejected, from the running
    /// service when there is one.
    Conflicts,
    /// Keep a source's original file and images on this replica without
    /// waiting for it to be opened. They arrive with the next sync.
    Pin { source_id: String },
    /// Stop keeping a source's files ahead of time.
    Unpin { source_id: String },
    /// List pinned sources.
    Pins,
    /// Clone the hub again into this replica's directory, after sending it
    /// everything the hub has not seen. Use it when the hub has retired this
    /// replica. Pins and fetched files stay; the old database is kept beside
    /// the new one.
    Reclone,
}

pub(crate) fn run(workshop: &Path, command: Option<SyncCommand>) -> anyhow::Result<()> {
    let output = match command {
        Some(SyncCommand::Clone { url, code, name }) => {
            serde_json::to_value(clone(workshop, &url, code.as_deref(), name.as_deref())?)?
        }
        Some(SyncCommand::Status) => match open(workshop) {
            Ok(replica) => serde_json::to_value(replica.workshop.sync_status()?)?,
            Err(unowned) => served(workshop, unowned, reqwest::Method::GET, "/api/sync/state")?,
        },
        Some(SyncCommand::Conflicts) => match open(workshop) {
            Ok(replica) => serde_json::to_value(replica.workshop.sync_conflicts()?)?,
            Err(unowned) => served(
                workshop,
                unowned,
                reqwest::Method::GET,
                "/api/sync/conflicts",
            )?,
        },
        Some(SyncCommand::Pin { source_id }) => {
            let mut replica = open(workshop)?;
            replica.workshop.sync_pin(&source_id)?;
            serde_json::to_value(replica.workshop.sync_pins()?)?
        }
        Some(SyncCommand::Unpin { source_id }) => {
            let mut replica = open(workshop)?;
            replica.workshop.sync_unpin(&source_id)?;
            serde_json::to_value(replica.workshop.sync_pins()?)?
        }
        Some(SyncCommand::Pins) => {
            let replica = open(workshop)?;
            serde_json::to_value(replica.workshop.sync_pins()?)?
        }
        Some(SyncCommand::Reclone) => reclone(workshop)?,
        None => {
            let mut replica = match open(workshop) {
                Ok(replica) => replica,
                Err(unowned) => {
                    let state = served(workshop, unowned, reqwest::Method::POST, "/api/sync/run")?;
                    println!("{}", serde_json::to_string_pretty(&state)?);
                    return Ok(());
                }
            };
            let status = replica.workshop.sync_status()?.with_context(|| {
                format!(
                    "{} is not a replica; run tessera sync clone <url>",
                    workshop.display()
                )
            })?;
            let credentials = replica.workshop.sync_hub_credentials()?;
            let mut hub = HttpHub::new(
                &status.hub_url,
                credentials.as_ref().and_then(|c| c.key.as_deref()),
            )?;
            let report = replica.workshop.sync_with(&mut hub)?;
            replica.workshop.sync_mark_synced()?;
            serde_json::to_value(report)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

/// A replica opened while no service owns its directory.
struct Replica {
    workshop: Workshop,
    _ownership: WorkshopOwnership,
}

fn open(workshop: &Path) -> anyhow::Result<Replica> {
    let ownership = WorkshopOwnership::acquire(workshop, 0)
        .context("stop the service using this workshop before syncing it from the command line")?;
    Ok(Replica {
        workshop: Workshop::open(workshop)?,
        _ownership: ownership,
    })
}

/// Ask the service that owns the workshop, when one is running, for a
/// route; without one, `unowned` is the error.
pub(crate) fn served(
    workshop: &Path,
    unowned: anyhow::Error,
    method: reqwest::Method,
    path: &str,
) -> anyhow::Result<serde_json::Value> {
    tokio::runtime::Runtime::new()?.block_on(async {
        let Ok(service) = crate::service(workshop).await else {
            return Err(unowned);
        };
        let response = service.request(method, path).send().await?;
        Ok(crate::checked(response).await?.json().await?)
    })
}

fn clone(
    workshop: &Path,
    url: &str,
    code: Option<&str>,
    name: Option<&str>,
) -> anyhow::Result<Option<tessera_core::sync::SyncStatus>> {
    let database = workshop.join(DATABASE_FILE);
    anyhow::ensure!(
        !database.exists(),
        "{} already holds a workshop; clone into a new directory",
        workshop.display()
    );
    let _ownership = WorkshopOwnership::acquire(workshop, 0)?;
    let pairing = code.map(|code| pair(url, code, name)).transpose()?;
    let hub = HttpHub::new(url, pairing.as_ref().map(|p| p.key.as_str()))?;
    let (ticket, partial) = hub.download(workshop)?;
    std::fs::rename(&partial, &database)?;
    let mut replica = Workshop::open(workshop)?;
    replica.sync_adopt(&hub.base, &ticket)?;
    if let Some(pairing) = pairing {
        replica.sync_set_hub_credentials(
            Some(&pairing.key),
            Some(&pairing.hub.name),
            Some(&pairing.device.name),
        )?;
    }
    // The clone is the hub's state as of now, so it counts as the first sync.
    replica.sync_mark_synced()?;
    Ok(replica.sync_status()?)
}

fn pair(url: &str, code: &str, name: Option<&str>) -> anyhow::Result<Pairing> {
    let default_name = std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .unwrap_or_else(|| "localhost".into());
    let hub = HttpHub::new(url, None)?;
    hub.pair(code, name.unwrap_or(default_name.trim()))
}

fn reclone(workshop: &Path) -> anyhow::Result<serde_json::Value> {
    let Replica {
        workshop: mut old,
        _ownership,
    } = open(workshop)?;
    let status = old.sync_status()?.with_context(|| {
        format!(
            "{} is not a replica; run tessera sync clone <url>",
            workshop.display()
        )
    })?;
    let credentials = old.sync_hub_credentials()?;
    let mut hub = HttpHub::new(
        &status.hub_url,
        credentials.as_ref().and_then(|c| c.key.as_deref()),
    )?;
    // A retired replica can still send, so nothing made here is lost.
    let sent = old.sync_send(&mut hub)?;
    let pins = old.sync_pins()?;
    let (ticket, partial) = hub.download(workshop)?;
    let previous = old.sync_install_clone(
        &partial,
        &hub.base,
        &ticket,
        "retired",
        credentials.as_ref(),
    )?;
    std::fs::remove_file(partial)?;
    hub.retire(&status.device_id)?;
    let mut replica = old;
    // A pinned source the hub deleted cannot be pinned again.
    let unpinned: Vec<String> = pins
        .into_iter()
        .filter(|source| replica.sync_pin(source).is_err())
        .collect();
    let synced = replica.sync_with(&mut hub)?;
    replica.sync_mark_synced()?;
    Ok(json!({
        "sent": sent,
        "synced": synced,
        "status": replica.sync_status()?,
        "previous": previous,
        "unpinned": unpinned,
    }))
}
