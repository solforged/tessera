//! Tailscale Serve owns TLS; this module changes only Tessera's HTTPS port.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

pub(crate) const SERVE_PORT: u16 = 4319;

#[derive(Serialize)]
pub(crate) struct Sharing {
    pub available: bool,
    pub on: bool,
    pub url: Option<String>,
    pub error: Option<String>,
}

fn binary() -> Option<PathBuf> {
    [
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]
    .into_iter()
    .map(PathBuf::from)
    .chain(
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|p| p.join("tailscale")),
    )
    .find(|path| path.is_file())
}

async fn command(binary: &Path, args: &[&str]) -> Result<String, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(binary)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Tailscale did not answer in time.".to_owned())?
    .map_err(|error| format!("Cannot run Tailscale: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Tailscale failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|error| format!("Cannot read Tailscale's answer: {error}"))
}

async fn json(binary: &Path, args: &[&str]) -> Result<Value, String> {
    serde_json::from_str(&command(binary, args).await?)
        .map_err(|error| format!("Cannot read Tailscale's status: {error}"))
}

async fn inspect(binary: &Path, sync_port: u16) -> Result<Sharing, String> {
    let status = json(binary, &["status", "--json"]).await?;
    if status["BackendState"].as_str() != Some("Running") {
        return Err("Tailscale is not logged in or running.".into());
    }
    let host = status["Self"]["DNSName"]
        .as_str()
        .filter(|name| !name.is_empty())
        .ok_or("Tailscale has no device address.")?
        .trim_end_matches('.');
    let serve = json(binary, &["serve", "status", "--json"]).await?;
    let address = format!("{host}:{SERVE_PORT}");
    let target = format!("http://127.0.0.1:{sync_port}");
    let on = serve["TCP"][SERVE_PORT.to_string()]["HTTPS"].as_bool() == Some(true)
        && serve["Web"][&address]["Handlers"]["/"]["Proxy"].as_str() == Some(target.as_str());
    Ok(Sharing {
        available: true,
        on,
        url: Some(format!("https://{address}")),
        error: None,
    })
}

pub(crate) async fn status(sync_port: u16) -> Sharing {
    let Some(binary) = binary() else {
        return Sharing {
            available: false,
            on: false,
            url: None,
            error: Some("Tailscale is not installed.".into()),
        };
    };
    inspect(&binary, sync_port)
        .await
        .unwrap_or_else(|error| Sharing {
            available: false,
            on: false,
            url: None,
            error: Some(error),
        })
}

pub(crate) async fn set(sync_port: u16, on: bool) -> Sharing {
    let Some(binary) = binary() else {
        return status(sync_port).await;
    };
    let mut sharing = match inspect(&binary, sync_port).await {
        Ok(sharing) => sharing,
        Err(error) => {
            return Sharing {
                available: false,
                on: false,
                url: None,
                error: Some(error),
            };
        }
    };
    let https = format!("--https={SERVE_PORT}");
    let target = format!("http://127.0.0.1:{sync_port}");
    let args = if on {
        vec!["serve", "--bg", &https, &target]
    } else {
        vec!["serve", &https, "off"]
    };
    match command(&binary, &args).await {
        Ok(_) => status(sync_port).await,
        Err(error) => {
            sharing.error = Some(error);
            sharing
        }
    }
}

pub(crate) async fn hub_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(name) = command(Path::new("/usr/sbin/scutil"), &["--get", "ComputerName"]).await
        && !name.trim().is_empty()
    {
        return name.trim().to_owned();
    }
    if let Ok(name) = command(Path::new("hostname"), &[]).await
        && !name.trim().is_empty()
    {
        return name.trim().to_owned();
    }
    std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".into())
}
