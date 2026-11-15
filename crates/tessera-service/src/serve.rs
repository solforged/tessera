use std::net::Ipv4Addr;
use std::path::PathBuf;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use tessera_core::{Notebook, NotebookOwnership};

use crate::daily_backup;
use crate::notebooks;
use crate::router::routers;
use crate::security::validate_dev_origin;

pub struct Config {
    /// Notebook directory; created if missing.
    pub notebook: PathBuf,
    pub port: u16,
    /// Separate authenticated sync listener; defaults to the editor port plus one.
    pub sync_port: Option<u16>,
    /// Override embedded browser assets with a built directory (`web/dist`).
    pub assets: Option<PathBuf>,
    /// Extra allowed browser origin for the Vite dev server.
    pub dev_origin: Option<String>,
    /// Known notebooks for the in-app switcher; without it the service cannot switch.
    pub registry: Option<notebooks::Registry>,
    /// The notebook came from the registry rather than `--workshop`, so a switch also changes
    /// which notebook later starts open.
    pub follows_registry: bool,
    /// Machine-local provider settings; defaults to the registry's sibling `agent.json`.
    pub agent_path: Option<PathBuf>,
    /// Shared backup store; absent when this host does not provide backups.
    pub backup_store: Option<PathBuf>,
}

/// A switch the service drained for: restart on `notebook` at the ports it had bound.
pub struct Restart {
    pub notebook: PathBuf,
    pub port: u16,
    pub sync_port: u16,
}

/// Hold exclusive notebook ownership, bind loopback, and drain on termination. Returns the
/// restart a notebook switch asked for, after draining and releasing this notebook.
pub async fn serve(config: Config) -> anyhow::Result<Option<Restart>> {
    if let Some(origin) = &config.dev_origin {
        validate_dev_origin(origin).map_err(anyhow::Error::msg)?;
    }
    let dir = config.notebook.clone();
    let requested_port = config.port;
    let (notebook, mut ownership) = tokio::task::spawn_blocking(move || {
        let ownership = NotebookOwnership::acquire(&dir, requested_port)?;
        apply_pending_restore(&ownership, &dir)?;
        let notebook = Notebook::open(&dir)
            .with_context(|| format!("cannot open workshop {}", dir.display()))?;
        Ok::<_, anyhow::Error>((notebook, ownership))
    })
    .await??;
    let shutdown = shutdown_signal().context("cannot register service shutdown signals")?;
    let path = notebook.info()?.path;
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, config.port))
        .await
        .context("cannot bind the local HTTP port")?;
    let port = listener.local_addr()?.port();
    let sync_port = config.sync_port.map(Ok).unwrap_or_else(|| {
        port.checked_add(1)
            .context("specify --sync-port when the editor port is 65535")
    })?;
    let sync_listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, sync_port))
        .await
        .context("cannot bind the local sync port")?;
    let sync_port = sync_listener.local_addr()?.port();
    ownership.record(Some(port))?;
    let (switch, mut switched) = tokio::sync::watch::channel(None);
    let agent_path = config.agent_path.or_else(|| {
        config
            .registry
            .as_ref()
            .map(|registry| registry.path.with_file_name("agent.json"))
    });
    let switcher = config
        .registry
        .map(|registry| notebooks::Switcher::new(registry, config.follows_registry, switch));
    let (app, sync_app, state) = routers(
        notebook,
        port,
        sync_port,
        config.assets,
        config.dev_origin,
        switcher,
        agent_path,
        config.backup_store,
    )
    .map_err(anyhow::Error::msg)?;
    let daily_backup = daily_backup::start(&state);
    tracing::info!(url = %format_args!("http://127.0.0.1:{port}"), "service listening");
    tracing::info!(url = %format_args!("http://127.0.0.1:{sync_port}"), "sync listening");
    tracing::info!(path = %path.display(), "workshop opened");
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let mut editor_stopped = stopped.clone();
    let mut sync_stopped = stopped;
    let servers = async {
        tokio::try_join!(
            axum::serve(listener, app).with_graceful_shutdown(async move {
                let _ = editor_stopped.wait_for(|stop| *stop).await;
            }),
            axum::serve(sync_listener, sync_app).with_graceful_shutdown(async move {
                let _ = sync_stopped.wait_for(|stop| *stop).await;
            }),
        )
    };
    // A service that cannot switch drops the sender; that switch never comes.
    let switch = async move {
        match switched.wait_for(Option::is_some).await {
            Ok(target) => target.clone(),
            Err(_) => std::future::pending().await,
        }
    };
    tokio::pin!(servers);
    let mut restart = None;
    tokio::select! {
        result = &mut servers => { result?; }
        () = shutdown => {
            let _ = stop.send(true);
            servers.await?;
        }
        target = switch => {
            let _ = stop.send(true);
            // Open change streams hold their connections; the restart ends them.
            match tokio::time::timeout(std::time::Duration::from_secs(5), &mut servers).await {
                Ok(result) => { result?; }
                Err(_) => tracing::warn!("connections still open after 5 s; switching anyway"),
            }
            restart = target.map(|notebook| Restart { notebook, port, sync_port });
        }
    }
    if let Some(task) = daily_backup {
        task.stop().await;
    }
    drop(ownership);
    tracing::info!("service stopped");
    Ok(restart)
}

#[derive(Deserialize, Serialize)]
struct PendingRestore {
    source: PathBuf,
    requested_at: i64,
}

fn apply_pending_restore(
    ownership: &NotebookOwnership,
    workshop: &std::path::Path,
) -> anyhow::Result<()> {
    let marker = workshop.join("restore.pending");
    let bytes = match std::fs::read(&marker) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let restored = (|| -> anyhow::Result<_> {
        let pending: PendingRestore = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(
            pending.source.is_absolute() && pending.source.join("manifest.json").is_file(),
            "the restore source must be an absolute backup directory with manifest.json"
        );
        let _: tessera_core::BackupManifest =
            serde_json::from_reader(std::fs::File::open(pending.source.join("manifest.json"))?)?;
        tessera_core::restore_with(ownership, &pending.source, workshop, true)?;
        Ok(pending)
    })();
    std::fs::remove_file(&marker)?;
    std::fs::File::open(workshop)?.sync_all()?;
    match restored {
        Ok(pending) => tracing::info!(
            source = %pending.source.display(),
            requested_at = pending.requested_at,
            "workshop restored from backup"
        ),
        Err(error) => {
            tracing::warn!(%error, "discarded an invalid pending restore; opening the workshop")
        }
    }
    Ok(())
}

pub(crate) fn write_pending_restore(
    workshop: &std::path::Path,
    source: PathBuf,
) -> std::io::Result<()> {
    use std::io::Write;

    let marker = workshop.join("restore.pending");
    let temporary = workshop.join("restore.pending.tmp");
    let result = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        serde_json::to_writer(
            &mut file,
            &PendingRestore {
                source,
                requested_at: tessera_core::now_ms(),
            },
        )?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        std::fs::rename(&temporary, marker)?;
        std::fs::File::open(workshop)?.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn shutdown_signal() -> std::io::Result<impl Future<Output = ()>> {
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    Ok(async move {
        #[cfg(unix)]
        let terminated = async move {
            let _ = terminate.recv().await;
        };
        #[cfg(not(unix))]
        let terminated = std::future::pending::<()>();
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    tracing::error!(%error, "Ctrl-C handler failed; draining service");
                }
            }
            () = terminated => {}
        }
        tracing::info!("service shutting down");
    })
}
