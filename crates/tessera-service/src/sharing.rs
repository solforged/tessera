//! Tailscale Serve owns TLS; this module changes only Tessera's HTTPS port, and only while
//! that port is free, left behind by a service that has stopped, or already this service's own.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

pub(crate) const SERVE_PORT: u16 = 4319;

/// Said when another running service holds the HTTPS port.
const TAKEN: &str =
    "Another workshop on this Mac is already sharing over Tailscale. Turn its Sharing off first.";

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

/// What Tailscale Serve does with [`SERVE_PORT`] on this Mac.
#[derive(Debug, PartialEq, Eq)]
enum Mapping {
    /// Nothing is served on it.
    Free,
    /// It proxies to this service's own sync listener.
    Own,
    /// It proxies to another loopback listener, which may have stopped since: host and port.
    Local(String, u16),
    /// It serves something that is not a loopback proxy, so nothing says it is stale.
    Foreign,
}

/// The port's state as `tailscale serve status --json` reports it.
struct Serving {
    address: String,
    mapping: Mapping,
    /// HTTPS is enabled on the port and proxies to this service's own sync listener.
    on: bool,
}

/// The Serve command a Sharing switch change calls for.
#[derive(Debug, PartialEq, Eq)]
enum Plan {
    Publish,
    Withdraw,
    Nothing,
}

/// This device's tailnet name from `tailscale status --json`, plus the Serve port.
fn tailnet_address(status: &Value) -> Result<String, String> {
    if status["BackendState"].as_str() != Some("Running") {
        return Err("Tailscale is not logged in or running.".into());
    }
    let host = status["Self"]["DNSName"]
        .as_str()
        .filter(|name| !name.is_empty())
        .ok_or("Tailscale has no device address.")?
        .trim_end_matches('.');
    Ok(format!("{host}:{SERVE_PORT}"))
}

/// The host and port a loopback proxy target names.
fn loopback_target(proxy: &str) -> Option<(String, u16)> {
    let url = reqwest::Url::parse(proxy).ok()?;
    let host = url.host_str()?.trim_matches(['[', ']']);
    let loopback = host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !loopback {
        return None;
    }
    Some((host.to_owned(), url.port_or_known_default()?))
}

/// Read who serves `address` from `tailscale serve status --json`, for the service whose
/// sync listener is on `sync_port`.
fn classify(serve: &Value, address: String, sync_port: u16) -> Serving {
    let tcp = &serve["TCP"][SERVE_PORT.to_string()];
    let handlers = &serve["Web"][&address]["Handlers"];
    let mapping = match handlers["/"]["Proxy"].as_str() {
        Some(proxy) => match loopback_target(proxy) {
            Some((_, port)) if port == sync_port => Mapping::Own,
            Some((host, port)) => Mapping::Local(host, port),
            None => Mapping::Foreign,
        },
        None if tcp.is_null() && handlers.as_object().is_none_or(serde_json::Map::is_empty) => {
            Mapping::Free
        }
        None => Mapping::Foreign,
    };
    let on = mapping == Mapping::Own && tcp["HTTPS"].as_bool() == Some(true);
    Serving {
        address,
        mapping,
        on,
    }
}

async fn listening(host: &str, port: u16) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect((host, port)),
        )
        .await,
        Ok(Ok(_))
    )
}

/// Whether another running service holds the port. A proxy to a loopback port nothing listens
/// on is a mapping a stopped service left behind, and may be replaced.
async fn is_held(mapping: &Mapping) -> bool {
    match mapping {
        Mapping::Free | Mapping::Own => false,
        Mapping::Local(host, port) => listening(host, *port).await,
        Mapping::Foreign => true,
    }
}

/// What turning Sharing `on` or off does. Only a free, stale or own mapping is published over,
/// and only the own mapping is withdrawn: Serve's one HTTPS port is shared by every service
/// on this Mac.
fn plan(on: bool, mapping: &Mapping, held: bool) -> Result<Plan, &'static str> {
    match (on, mapping) {
        (true, _) if held => Err(TAKEN),
        (true, _) => Ok(Plan::Publish),
        (false, Mapping::Own) => Ok(Plan::Withdraw),
        (false, _) => Ok(Plan::Nothing),
    }
}

fn describe(serving: &Serving, held: bool) -> Sharing {
    Sharing {
        available: true,
        on: serving.on,
        url: Some(format!("https://{}", serving.address)),
        error: held.then(|| TAKEN.to_owned()),
    }
}

fn unavailable(error: String) -> Sharing {
    Sharing {
        available: false,
        on: false,
        url: None,
        error: Some(error),
    }
}

async fn inspect(binary: &Path, sync_port: u16) -> Result<(Serving, bool), String> {
    let address = tailnet_address(&json(binary, &["status", "--json"]).await?)?;
    let serve = json(binary, &["serve", "status", "--json"]).await?;
    let serving = classify(&serve, address, sync_port);
    let held = is_held(&serving.mapping).await;
    Ok((serving, held))
}

pub(crate) async fn status(sync_port: u16) -> Sharing {
    let Some(binary) = binary() else {
        return unavailable("Tailscale is not installed.".into());
    };
    match inspect(&binary, sync_port).await {
        Ok((serving, held)) => describe(&serving, held),
        Err(error) => unavailable(error),
    }
}

/// Turn Sharing on or off for the service whose sync listener is on `sync_port`. A refusal is
/// a sentence for the person: another service already holds the port.
pub(crate) async fn set(sync_port: u16, on: bool) -> Result<Sharing, String> {
    let Some(binary) = binary() else {
        return Ok(status(sync_port).await);
    };
    let (serving, held) = match inspect(&binary, sync_port).await {
        Ok(read) => read,
        Err(error) => return Ok(unavailable(error)),
    };
    let mut sharing = describe(&serving, held);
    let https = format!("--https={SERVE_PORT}");
    let target = format!("http://127.0.0.1:{sync_port}");
    let args = match plan(on, &serving.mapping, held)? {
        Plan::Nothing => return Ok(sharing),
        Plan::Publish => vec!["serve", "--bg", &https, &target],
        Plan::Withdraw => vec!["serve", &https, "off"],
    };
    match command(&binary, &args).await {
        Ok(_) => Ok(status(sync_port).await),
        Err(error) => {
            sharing.error = Some(error);
            Ok(sharing)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ADDRESS: &str = "hyperion.ussuri.ts.net:4319";

    fn mapped(proxy: &str) -> Value {
        json!({
            "TCP": {"4319": {"HTTPS": true}},
            "Web": {"hyperion.ussuri.ts.net:4319": {"Handlers": {"/": {"Proxy": proxy}}}},
        })
    }

    fn mapping(serve: &Value, sync_port: u16) -> Mapping {
        classify(serve, ADDRESS.into(), sync_port).mapping
    }

    #[test]
    fn the_tailnet_address_needs_a_running_tailscale() {
        let running = json!({
            "BackendState": "Running",
            "Self": {"DNSName": "hyperion.ussuri.ts.net."},
        });
        assert_eq!(tailnet_address(&running).unwrap(), ADDRESS);
        assert!(tailnet_address(&json!({"BackendState": "Stopped"})).is_err());
        let nameless = json!({"BackendState": "Running", "Self": {"DNSName": ""}});
        assert!(tailnet_address(&nameless).is_err());
    }

    #[test]
    fn the_port_is_read_as_free_own_local_or_foreign() {
        assert_eq!(mapping(&json!({}), 4321), Mapping::Free);
        let empty = json!({"Web": {"hyperion.ussuri.ts.net:4319": {"Handlers": {}}}});
        assert_eq!(mapping(&empty, 4321), Mapping::Free);

        let own = classify(&mapped("http://127.0.0.1:4321"), ADDRESS.into(), 4321);
        assert_eq!(own.mapping, Mapping::Own);
        assert!(own.on);
        for proxy in ["http://127.0.0.1:4321/", "http://localhost:4321"] {
            assert_eq!(mapping(&mapped(proxy), 4321), Mapping::Own);
        }

        let other = classify(&mapped("http://127.0.0.1:4319"), ADDRESS.into(), 4321);
        assert_eq!(other.mapping, Mapping::Local("127.0.0.1".into(), 4319));
        assert!(!other.on);
        let ipv6 = mapping(&mapped("http://[::1]:4319"), 4321);
        assert_eq!(ipv6, Mapping::Local("::1".into(), 4319));

        // Nothing says a proxy to another machine, a TCP forward or a file is stale.
        for proxy in ["http://10.0.0.5:80", "not a url"] {
            assert_eq!(mapping(&mapped(proxy), 4321), Mapping::Foreign);
        }
        let forward = json!({"TCP": {"4319": {"TCPForward": "127.0.0.1:22"}}});
        assert_eq!(mapping(&forward, 4321), Mapping::Foreign);
        let text = json!({
            "TCP": {"4319": {"HTTPS": true}},
            "Web": {"hyperion.ussuri.ts.net:4319": {"Handlers": {"/": {"Text": "hello"}}}},
        });
        assert_eq!(mapping(&text, 4321), Mapping::Foreign);
    }

    #[test]
    fn sharing_is_only_published_over_a_mapping_no_running_service_holds() {
        let local = Mapping::Local("127.0.0.1".into(), 4319);
        assert_eq!(plan(true, &Mapping::Free, false), Ok(Plan::Publish));
        assert_eq!(plan(true, &Mapping::Own, false), Ok(Plan::Publish));
        // A stopped service's leftover mapping is replaced.
        assert_eq!(plan(true, &local, false), Ok(Plan::Publish));
        assert_eq!(plan(true, &local, true), Err(TAKEN));
        assert_eq!(plan(true, &Mapping::Foreign, true), Err(TAKEN));
    }

    #[test]
    fn sharing_is_only_withdrawn_from_the_services_own_mapping() {
        let local = Mapping::Local("127.0.0.1".into(), 4319);
        assert_eq!(plan(false, &Mapping::Own, false), Ok(Plan::Withdraw));
        assert_eq!(plan(false, &local, true), Ok(Plan::Nothing));
        assert_eq!(plan(false, &local, false), Ok(Plan::Nothing));
        assert_eq!(plan(false, &Mapping::Foreign, true), Ok(Plan::Nothing));
        assert_eq!(plan(false, &Mapping::Free, false), Ok(Plan::Nothing));
    }

    #[test]
    fn a_held_port_says_so_in_the_status_but_stays_available() {
        let serving = classify(&mapped("http://127.0.0.1:4319"), ADDRESS.into(), 4321);
        let sharing = describe(&serving, true);
        assert!(sharing.available);
        assert!(!sharing.on);
        assert_eq!(
            sharing.url.as_deref(),
            Some("https://hyperion.ussuri.ts.net:4319")
        );
        assert_eq!(sharing.error.as_deref(), Some(TAKEN));
        assert_eq!(describe(&serving, false).error, None);
    }

    #[tokio::test]
    async fn a_loopback_proxy_holds_the_port_only_while_something_listens() {
        assert!(!is_held(&Mapping::Free).await);
        assert!(!is_held(&Mapping::Own).await);
        assert!(is_held(&Mapping::Foreign).await);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mapping = Mapping::Local("127.0.0.1".into(), port);
        assert!(is_held(&mapping).await);
        drop(listener);
        assert!(!is_held(&mapping).await);
    }
}
