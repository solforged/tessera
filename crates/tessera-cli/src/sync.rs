//! `tessera sync`: keep a replica of a hub notebook. See `docs/sync.md`.

use std::path::Path;

use anyhow::Context;
use clap::Subcommand;
use serde_json::json;
use tessera_core::sync::{
    CloneTicket, Hub, Pull, PushReceipt, PushedChange, SnapshotContent, UnloggedPull, UnloggedRows,
};
use tessera_core::{DATABASE_FILE, Notebook, NotebookOwnership, SCHEMA_VERSION};

use crate::checked;

const SCHEMA_HEADER: &str = "x-tessera-schema";
const TICKET_HEADER: &str = "x-tessera-clone";

#[derive(Subcommand)]
pub(crate) enum SyncCommand {
    /// Make the notebook directory a new replica of the hub at URL, e.g.
    /// http://127.0.0.1:4318.
    Clone { url: String },
    /// Show this replica's hub and unpushed changes.
    Status,
    /// List kept conflict text and changes the hub rejected.
    Conflicts,
    /// Keep a source's original file and images on this replica without
    /// waiting for it to be opened. They arrive with the next sync.
    Pin { source_id: String },
    /// Stop keeping a source's files ahead of time.
    Unpin { source_id: String },
    /// List pinned sources.
    Pins,
}

pub(crate) fn run(notebook: &Path, command: Option<SyncCommand>) -> anyhow::Result<()> {
    let output = match command {
        Some(SyncCommand::Clone { url }) => serde_json::to_value(clone(notebook, &url)?)?,
        Some(SyncCommand::Status) => {
            let replica = open(notebook)?;
            serde_json::to_value(replica.notebook.sync_status()?)?
        }
        Some(SyncCommand::Conflicts) => {
            let replica = open(notebook)?;
            serde_json::to_value(replica.notebook.sync_conflicts()?)?
        }
        Some(SyncCommand::Pin { source_id }) => {
            let mut replica = open(notebook)?;
            replica.notebook.sync_pin(&source_id)?;
            serde_json::to_value(replica.notebook.sync_pins()?)?
        }
        Some(SyncCommand::Unpin { source_id }) => {
            let mut replica = open(notebook)?;
            replica.notebook.sync_unpin(&source_id)?;
            serde_json::to_value(replica.notebook.sync_pins()?)?
        }
        Some(SyncCommand::Pins) => {
            let replica = open(notebook)?;
            serde_json::to_value(replica.notebook.sync_pins()?)?
        }
        None => {
            let mut replica = open(notebook)?;
            let status = replica.notebook.sync_status()?.with_context(|| {
                format!(
                    "{} is not a replica; run tessera sync clone <url>",
                    notebook.display()
                )
            })?;
            let mut hub = HttpHub::new(&status.hub_url)?;
            serde_json::to_value(replica.notebook.sync_with(&mut hub)?)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

/// A replica opened while no service owns its directory.
struct Replica {
    notebook: Notebook,
    _ownership: NotebookOwnership,
}

fn open(notebook: &Path) -> anyhow::Result<Replica> {
    let ownership = NotebookOwnership::acquire(notebook, 0)
        .context("stop the service using this notebook before syncing it from the command line")?;
    Ok(Replica {
        notebook: Notebook::open(notebook)?,
        _ownership: ownership,
    })
}

fn clone(notebook: &Path, url: &str) -> anyhow::Result<Option<tessera_core::sync::SyncStatus>> {
    let database = notebook.join(DATABASE_FILE);
    anyhow::ensure!(
        !database.exists(),
        "{} already holds a notebook; clone into a new directory",
        notebook.display()
    );
    let hub = HttpHub::new(url)?;
    let (ticket, bytes) = hub.runtime.block_on(async {
        let response = checked(
            hub.client
                .post(format!("{}/api/sync/clone", hub.base))
                .header(SCHEMA_HEADER, SCHEMA_VERSION)
                .send()
                .await?,
        )
        .await?;
        let ticket: CloneTicket = serde_json::from_str(
            response
                .headers()
                .get(TICKET_HEADER)
                .context("the hub sent no clone ticket")?
                .to_str()?,
        )?;
        anyhow::Ok((ticket, response.bytes().await?))
    })?;
    let _ownership = NotebookOwnership::acquire(notebook, 0)?;
    std::fs::write(&database, &bytes)?;
    let mut replica = Notebook::open(notebook)?;
    replica.sync_adopt(&hub.base, &ticket)?;
    Ok(replica.sync_status()?)
}

/// A hub reached over HTTP.
struct HttpHub {
    runtime: tokio::runtime::Runtime,
    client: reqwest::Client,
    base: String,
}

impl HttpHub {
    fn new(url: &str) -> anyhow::Result<Self> {
        Ok(Self {
            runtime: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .build()?,
            base: url.trim_end_matches('/').to_owned(),
        })
    }

    fn call<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> tessera_core::Result<T> {
        self.runtime
            .block_on(async {
                let response = self
                    .client
                    .post(format!("{}{path}", self.base))
                    .header(SCHEMA_HEADER, SCHEMA_VERSION)
                    .json(&body)
                    .send()
                    .await?;
                let response = checked(response).await?;
                if response.status() == reqwest::StatusCode::NO_CONTENT {
                    return Ok(serde_json::from_value(serde_json::Value::Null)?);
                }
                anyhow::Ok(response.json().await?)
            })
            .map_err(|error| self.failed(error))
    }

    fn failed(&self, error: anyhow::Error) -> tessera_core::Error {
        tessera_core::Error::Io(std::io::Error::other(format!(
            "hub {}: {error:#}",
            self.base
        )))
    }
}

impl Hub for HttpHub {
    fn push(
        &mut self,
        device: &str,
        changes: &[PushedChange],
    ) -> tessera_core::Result<Vec<PushReceipt>> {
        self.call(
            "/api/sync/push",
            json!({"device": device, "changes": changes}),
        )
    }

    fn pull(&mut self, device: &str, acknowledged: i64, after: i64) -> tessera_core::Result<Pull> {
        self.call(
            "/api/sync/pull",
            json!({"device": device, "acknowledged": acknowledged, "after": after}),
        )
    }

    fn missing_snapshots(&mut self, ids: &[String]) -> tessera_core::Result<Vec<String>> {
        let missing: serde_json::Value =
            self.call("/api/sync/snapshots/missing", json!({"ids": ids}))?;
        serde_json::from_value(missing["ids"].clone())
            .map_err(|error| tessera_core::Error::Io(std::io::Error::other(error)))
    }

    fn snapshot_content(&mut self, ids: &[String]) -> tessera_core::Result<Vec<SnapshotContent>> {
        self.call("/api/sync/snapshots/content", json!({"ids": ids}))
    }

    fn store_snapshots(&mut self, content: &[SnapshotContent]) -> tessera_core::Result<()> {
        self.call("/api/sync/snapshots", json!(content))
    }

    fn missing_objects(&mut self, shas: &[String]) -> tessera_core::Result<Vec<String>> {
        let missing: serde_json::Value =
            self.call("/api/sync/objects/missing", json!({"ids": shas}))?;
        serde_json::from_value(missing["ids"].clone())
            .map_err(|error| tessera_core::Error::Io(std::io::Error::other(error)))
    }

    fn object(&mut self, sha: &str) -> tessera_core::Result<Option<Vec<u8>>> {
        self.runtime
            .block_on(async {
                let response = self
                    .client
                    .get(format!("{}/api/sync/objects/{sha}", self.base))
                    .header(SCHEMA_HEADER, SCHEMA_VERSION)
                    .send()
                    .await?;
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    return Ok(None);
                }
                anyhow::Ok(Some(checked(response).await?.bytes().await?.to_vec()))
            })
            .map_err(|error| self.failed(error))
    }

    fn store_object(&mut self, sha: &str, bytes: &[u8]) -> tessera_core::Result<()> {
        self.runtime
            .block_on(async {
                let response = self
                    .client
                    .put(format!("{}/api/sync/objects/{sha}", self.base))
                    .header(SCHEMA_HEADER, SCHEMA_VERSION)
                    .body(bytes.to_vec())
                    .send()
                    .await?;
                checked(response).await?;
                anyhow::Ok(())
            })
            .map_err(|error| self.failed(error))
    }

    fn exchange_rows(
        &mut self,
        device: &str,
        rows: &UnloggedRows,
        after: i64,
    ) -> tessera_core::Result<UnloggedPull> {
        self.call(
            "/api/sync/rows",
            json!({"device": device, "rows": rows, "after": after}),
        )
    }
}
