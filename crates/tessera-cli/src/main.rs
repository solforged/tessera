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
