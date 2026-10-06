use std::path::PathBuf;

use anyhow::Context;
use clap::{Parser, Subcommand};
use tessera_core::Notebook;

/// Tessera: a local-first outline workstation.
#[derive(Parser)]
#[command(version)]
struct Cli {
    /// Notebook directory. Defaults to the platform data directory.
    #[arg(long, global = true, env = "TESSERA_NOTEBOOK")]
    notebook: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the notebook's identity and schema as JSON, creating it if missing.
    Info,
    /// Queue files or HTTP URLs in the running notebook service.
    Add {
        #[arg(required = true)]
        inputs: Vec<String>,
        #[arg(long)]
        wait: bool,
    },
    /// Export source fields as BibTeX or CSL JSON.
    Export {
        #[arg(long, default_value = "bibtex", value_parser = ["bibtex", "csl"])]
        format: String,
        source_ids: Vec<String>,
        /// Export a saved library view by name instead of source IDs.
        #[arg(long, conflicts_with = "source_ids")]
        view: Option<String>,
    },
    /// Serve the notebook and the browser editor on loopback.
    Serve {
        #[arg(long, default_value_t = tessera_service::DEFAULT_PORT)]
        port: u16,
        /// Built browser editor directory, e.g. web/dist.
        #[arg(long)]
        assets: Option<PathBuf>,
        /// Also allow this browser origin, e.g. http://127.0.0.1:5173 for Vite.
        #[arg(long)]
        dev_origin: Option<String>,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let notebook = match cli.notebook {
        Some(path) => path,
        None => dirs::data_dir()
            .context("no platform data directory; pass --notebook")?
            .join("tessera")
            .join("notebook"),
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
        Command::Serve {
            port,
            assets,
            dev_origin,
        } => {
            tokio::runtime::Runtime::new()?.block_on(tessera_service::serve(
                tessera_service::Config {
                    notebook,
                    port,
                    assets,
                    dev_origin,
                },
            ))?;
        }
    }
    Ok(())
}

async fn service(notebook: &std::path::Path) -> anyhow::Result<(reqwest::Client, String)> {
    let message = format!(
        "No service is running for {}. Start it with tessera --notebook {} serve.",
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
                        println!("{}: {}", id, source.page.text);
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
