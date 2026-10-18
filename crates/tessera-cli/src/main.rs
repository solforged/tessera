mod check;
mod install;
mod mcp;
mod sync;

use std::path::PathBuf;

use anyhow::Context;
use clap::{Parser, Subcommand};
use tessera_core::Notebook;

/// Tessera: a local-first outline workstation.
#[derive(Parser)]
#[command(version)]
struct Cli {
    /// Workshop directory. Defaults to the workshop last opened from the app's
    /// switcher, or $XDG_DATA_HOME/tessera/workshops/main.
    #[arg(
        long = "workshop",
        value_name = "WORKSHOP",
        global = true,
        env = "TESSERA_WORKSHOP"
    )]
    notebook: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the workshop's identity and schema as JSON, creating it if missing.
    Info,
    /// Queue files or HTTP URLs in the running workshop service.
    Add {
        #[arg(required = true)]
        inputs: Vec<String>,
        #[arg(long)]
        wait: bool,
    },
    /// Export source fields as BibTeX or CSL JSON, or highlights as Markdown.
    Export {
        #[arg(long, default_value = "bibtex", value_parser = ["bibtex", "csl", "markdown"])]
        format: String,
        source_ids: Vec<String>,
        /// Export a saved library view by name instead of source IDs.
        #[arg(long, conflicts_with = "source_ids")]
        view: Option<String>,
    },
    /// Serve the running workshop to agents as a Model Context Protocol
    /// server on stdin and stdout.
    Mcp,
    /// Serve the workshop and the browser editor on loopback.
    Serve {
        #[arg(long, default_value_t = tessera_service::DEFAULT_PORT)]
        port: u16,
        /// Authenticated sync listener; defaults to the editor port plus one.
        #[arg(long)]
        sync_port: Option<u16>,
        /// Built browser editor directory, e.g. web/dist.
        #[arg(long)]
        assets: Option<PathBuf>,
        /// Also allow this browser origin, e.g. http://127.0.0.1:5173 for Vite.
        #[arg(long)]
        dev_origin: Option<String>,
    },
    /// Install the local service as a macOS launch agent. Stops the old
    /// service, backs up the workshop, and waits for this build to answer.
    Install {
        #[arg(long, default_value_t = tessera_service::DEFAULT_PORT, value_parser = clap::value_parser!(u16).range(1..))]
        port: u16,
        #[arg(long)]
        allow_debug: bool,
        /// Previous executable to restore the backup with and reinstall if
        /// this build does not answer.
        #[arg(long)]
        rollback: Option<PathBuf>,
    },
    /// Remove the macOS launch agent without deleting the workshop.
    Uninstall,
    /// Back up a workshop while its service is running.
    Backup { dest: PathBuf },
    /// Restore a backup into an offline workshop.
    Restore {
        src: PathBuf,
        #[arg(long)]
        force: bool,
    },
    /// Check the database file, the derived tables and the model's rules,
    /// and print per-table hashes as JSON. Exits with status 1 when a problem
    /// remains. Goes through the running service when one owns the workshop.
    Check {
        /// Replace the derived tables with freshly derived rows, as one change
        /// by the `check` client. Authored text and review history are never written.
        #[arg(long)]
        repair: bool,
    },
    /// Push this replica's changes to its hub and pull the hub's, or manage
    /// the replica. While a service owns the workshop, sync, status and
    /// conflicts go through that service; pins need it stopped.
    Sync {
        #[command(subcommand)]
        command: Option<sync::SyncCommand>,
    },
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .init();
    let cli = Cli::parse();
    let explicit_notebook = cli.notebook.is_some();
    if !explicit_notebook && matches!(cli.command, Command::Serve { .. }) {
        tessera_service::migration::migrate_layout()?;
    }
    let registry = tessera_service::notebooks::Registry::platform();
    let notebook = match cli.notebook {
        Some(path) => path,
        None => registry
            .as_ref()
            .context("no workshop directory; pass --workshop")?
            .startup(),
    };
    match cli.command {
        Command::Info => {
            let info = Notebook::open(&notebook)?.info()?;
            println!("{}", serde_json::to_string_pretty(&info)?);
        }
        Command::Add { inputs, wait } => {
            tokio::runtime::Runtime::new()?.block_on(add(&notebook, inputs, wait))?;
        }
        Command::Export {
            format,
            source_ids,
            view,
        } => {
            tokio::runtime::Runtime::new()?.block_on(export(
                &notebook,
                &format,
                &source_ids,
                view.as_deref(),
            ))?;
        }
        Command::Mcp => {
            tokio::runtime::Runtime::new()?.block_on(mcp::serve(&notebook))?;
        }
        Command::Serve {
            port,
            sync_port,
            assets,
            dev_origin,
        } => {
            let runtime = tokio::runtime::Runtime::new()?;
            let restart = runtime.block_on(tessera_service::serve(tessera_service::Config {
                notebook,
                port,
                sync_port,
                assets: assets.clone(),
                dev_origin: dev_origin.clone(),
                registry,
                follows_registry: !explicit_notebook,
                agent_path: None,
                backup_store: tessera_service::paths::backups_dir(),
            }))?;
            if let Some(restart) = restart {
                return reopen(restart, explicit_notebook, assets, dev_origin);
            }
        }
        Command::Install {
            port,
            allow_debug,
            rollback,
        } => {
            install::install(
                &notebook,
                explicit_notebook,
                port,
                allow_debug,
                rollback.as_deref(),
            )?;
        }
        Command::Uninstall => install::uninstall()?,
        Command::Backup { dest } => {
            let manifest = tessera_core::backup(&notebook, dest)?;
            println!("{}", serde_json::to_string_pretty(&manifest)?);
        }
        Command::Restore { src, force } => {
            let info = tessera_core::restore(src, &notebook, force)?;
            println!("{}", serde_json::to_string_pretty(&info)?);
        }
        Command::Sync { command } => sync::run(&notebook, command)?,
        Command::Check { repair } => check::run(&notebook, repair)?,
    }
    Ok(())
}

/// Start this executable again on the switched-to notebook, at the ports the old one had.
/// A service following the registry starts without `--workshop`, because the registry now
/// names the new notebook; on Unix the process image is replaced, keeping the PID launchd watches.
fn reopen(
    restart: tessera_service::Restart,
    explicit_notebook: bool,
    assets: Option<PathBuf>,
    dev_origin: Option<String>,
) -> anyhow::Result<()> {
    let mut command = std::process::Command::new(
        std::env::current_exe().context("cannot find this executable to reopen")?,
    );
    command.env_remove("TESSERA_WORKSHOP");
    if explicit_notebook {
        command.arg("--workshop").arg(&restart.notebook);
    }
    command
        .arg("serve")
        .arg("--port")
        .arg(restart.port.to_string())
        .arg("--sync-port")
        .arg(restart.sync_port.to_string());
    if let Some(assets) = assets {
        command.arg("--assets").arg(assets);
    }
    if let Some(origin) = dev_origin {
        command.arg("--dev-origin").arg(origin);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec()).context("cannot restart on the switched workshop")
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .context("cannot restart on the switched workshop")?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

async fn service(notebook: &std::path::Path) -> anyhow::Result<(reqwest::Client, String)> {
    let message = format!(
        "No service is running for {}. Start it with tessera --workshop {} serve.",
        notebook.display(),
        notebook.display()
    );
    let bytes = tokio::fs::read(notebook.join("service.lock"))
        .await
        .context(message.clone())?;
    let lock: serde_json::Value = serde_json::from_slice(&bytes).context(message.clone())?;
    let port = lock["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= u16::MAX as u64)
        .context(message.clone())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let base = format!("http://127.0.0.1:{port}");
    client
        .get(format!("{base}/api/notebook"))
        .send()
        .await
        .context(message.clone())?
        .error_for_status()
        .context(message)?;
    Ok((client, base))
}

async fn checked(response: reqwest::Response) -> anyhow::Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let text = response.text().await?;
    anyhow::bail!("Service returned {status}: {text}")
}

async fn tag_titles<'a>(
    client: &reqwest::Client,
    base: &str,
    ids: std::collections::BTreeSet<&'a str>,
) -> anyhow::Result<std::collections::HashMap<&'a str, String>> {
    let mut titles = std::collections::HashMap::new();
    for id in ids {
        let response = client.get(format!("{base}/api/blocks/{id}")).send().await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        let block: tessera_core::Block = checked(response).await?.json().await?;
        if block.kind == tessera_core::BlockKind::Page {
            titles.insert(id, block.text);
        }
    }
    Ok(titles)
}

async fn add(notebook: &std::path::Path, inputs: Vec<String>, wait: bool) -> anyhow::Result<()> {
    use tessera_core::library::{IngestJob, IngestJobState, SourceView};
    let (client, base) = service(notebook).await?;
    let mut jobs = Vec::with_capacity(inputs.len());
    for input in inputs {
        let response = if input.starts_with("http://") || input.starts_with("https://") {
            client
                .post(format!("{base}/api/library/jobs"))
                .json(&serde_json::json!({"url":input}))
                .send()
                .await?
        } else {
            let path = std::path::Path::new(&input);
            let filename = path
                .file_name()
                .and_then(|s| s.to_str())
                .context("The filename is not valid UTF-8.")?;
            let bytes = tokio::fs::read(path)
                .await
                .with_context(|| format!("Cannot read {input}"))?;
            client
                .post(format!("{base}/api/library/uploads"))
                .header("Content-Type", "application/octet-stream")
                .header(
                    "X-Filename",
                    percent_encoding::utf8_percent_encode(
                        filename,
                        percent_encoding::NON_ALPHANUMERIC,
                    )
                    .to_string(),
                )
                .body(bytes)
                .send()
                .await?
        };
        let job: IngestJob = checked(response).await?.json().await?;
        println!("{}", job.id);
        jobs.push(job.id);
    }
    if wait {
        let mut failed = false;
        for id in jobs {
            loop {
                let job: IngestJob = checked(
                    client
                        .get(format!("{base}/api/library/jobs/{id}"))
                        .send()
                        .await?,
                )
                .await?
                .json()
                .await?;
                match job.state {
                    IngestJobState::Done => {
                        let source_id = job
                            .source_id
                            .context("The completed ingestion has no source.")?;
                        let source: SourceView = checked(
                            client
                                .get(format!("{base}/api/sources/{source_id}"))
                                .send()
                                .await?,
                        )
                        .await?
                        .json()
                        .await?;
                        let titles = tag_titles(
                            &client,
                            &base,
                            tessera_core::tag_tokens(&source.page.text)
                                .filter_map(|token| token.id)
                                .collect(),
                        )
                        .await?;
                        println!(
                            "{}: {}",
                            id,
                            tessera_core::render_tags(&source.page.text, |id| titles
                                .get(id)
                                .map(String::as_str))
                        );
                        break;
                    }
                    IngestJobState::Failed => {
                        eprintln!(
                            "{}: {}",
                            id,
                            job.error
                                .as_deref()
                                .unwrap_or("The source could not be ingested.")
                        );
                        failed = true;
                        break;
                    }
                    _ => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
                }
            }
        }
        anyhow::ensure!(!failed, "One or more ingestion jobs failed.");
    }
    Ok(())
}

async fn export(
    notebook: &std::path::Path,
    format: &str,
    ids: &[String],
    view: Option<&str>,
) -> anyhow::Result<()> {
    let (client, base) = service(notebook).await?;
    let request = if let Some(name) = view {
        let views: Vec<tessera_core::library::LibraryView> = checked(
            client
                .get(format!("{base}/api/library/views"))
                .send()
                .await?,
        )
        .await?
        .json()
        .await?;
        let mut matching = views.iter().filter(|view| view.name == name);
        let view = matching
            .next()
            .with_context(|| format!("Library view not found: {name}"))?;
        anyhow::ensure!(
            matching.next().is_none(),
            "More than one library view is named {name}"
        );
        client
            .post(format!("{base}/api/library/export"))
            .json(&serde_json::json!({ "format": format, "query": view.query }))
    } else {
        let mut request = client
            .get(format!("{base}/api/library/export"))
            .query(&[("format", format)]);
        if !ids.is_empty() {
            request = request.query(&[("ids", ids.join(","))]);
        }
        request
    };
    print!("{}", checked(request.send().await?).await?.text().await?);
    Ok(())
}
