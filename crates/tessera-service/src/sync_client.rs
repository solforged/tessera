//! Shared native replica transport for the CLI and in-process hosts.
use crate::sync::{SCHEMA_HEADER, TICKET_HEADER};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use tessera_core::sync::{
    CloneTicket, Hub, Pull, PushReceipt, PushedChange, SnapshotContent, UnloggedPull, UnloggedRows,
};
use tessera_core::{DATABASE_FILE, SCHEMA_VERSION};

#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct HubError {
    pub code: String,
    pub message: String,
}

/// Bundled roots deliberately bypass Android's uninitialized platform verifier.
fn client(key: Option<&str>) -> anyhow::Result<reqwest::Client> {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        SCHEMA_HEADER,
        reqwest::header::HeaderValue::from(SCHEMA_VERSION),
    );
    if let Some(key) = key {
        let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))?;
        value.set_sensitive(true);
        headers.insert(reqwest::header::AUTHORIZATION, value);
    }
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()?)
}

async fn checked(response: reqwest::Response) -> anyhow::Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    let error = body.get("error").unwrap_or(&body);
    let message = error["message"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| status.to_string());
    let code = error["code"]
        .as_str()
        .unwrap_or(if status == reqwest::StatusCode::UNAUTHORIZED {
            "unpaired"
        } else {
            "hub_unreachable"
        });
    // Older protocol endpoints expose these core validation errors without a
    // dedicated code. Normalize them at the shared transport boundary.
    let code = match code {
        "validation" if message.contains("schema") => "schema_mismatch",
        "validation" if message.contains("retired") => "retired",
        other => other,
    };
    Err(HubError {
        code: code.into(),
        message,
    }
    .into())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PairedHub {
    pub name: String,
    pub notebook_id: String,
    pub schema_version: u32,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Pairing {
    pub key: String,
    pub device: PairedDevice,
    pub hub: PairedHub,
}

/// Blocking protocol adapter. Construct and use on a blocking thread, never in
/// a Tokio async task: its small private runtime drives only network requests.
pub struct HttpHub {
    runtime: tokio::runtime::Runtime,
    client: reqwest::Client,
    pub base: String,
}
impl HttpHub {
    pub fn new(url: &str, key: Option<&str>) -> anyhow::Result<Self> {
        let url = reqwest::Url::parse(url)?;
        let loopback = url.host_str().is_some_and(|host| {
            host.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        });
        anyhow::ensure!(
            url.scheme() == "https"
                || url.scheme() == "http" && (loopback || url.host_str() == Some("localhost")),
            "sync requires HTTPS except on loopback"
        );
        anyhow::ensure!(
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "invalid hub URL"
        );
        Ok(Self {
            runtime: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?,
            client: client(key)?,
            base: url.as_str().trim_end_matches('/').into(),
        })
    }
    pub fn pair(&self, code: &str, name: &str) -> anyhow::Result<Pairing> {
        self.runtime.block_on(async {
            let result: Pairing = checked(
                self.client
                    .post(format!("{}/api/sync/pair", self.base))
                    .json(&json!({"code": code, "name": name}))
                    .send()
                    .await?,
            )
            .await?
            .json()
            .await?;
            if result.hub.schema_version != SCHEMA_VERSION {
                return Err(HubError {
                    code: "schema_mismatch".into(),
                    message: "Run the same Tessera version on both devices.".into(),
                }
                .into());
            }
            Ok(result)
        })
    }
    pub fn download(&self, notebook: &Path) -> anyhow::Result<(CloneTicket, PathBuf)> {
        let partial = notebook.join(format!("{DATABASE_FILE}.clone"));
        let result = self.runtime.block_on(async {
            let mut response = checked(
                self.client
                    .post(format!("{}/api/sync/clone", self.base))
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
            if ticket.schema_version != SCHEMA_VERSION {
                return Err(HubError {
                    code: "schema_mismatch".into(),
                    message: "Run the same Tessera version on both devices.".into(),
                }
                .into());
            }
            let mut file = tokio::fs::File::create(&partial).await?;
            while let Some(chunk) = response.chunk().await? {
                tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
            }
            file.sync_all().await?;
            anyhow::Ok(ticket)
        });
        match result {
            Ok(ticket) => Ok((ticket, partial)),
            Err(error) => {
                let _ = std::fs::remove_file(partial);
                Err(error)
            }
        }
    }
    fn call<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> tessera_core::Result<T> {
        self.runtime
            .block_on(async {
                let response = checked(
                    self.client
                        .post(format!("{}{path}", self.base))
                        .json(&body)
                        .send()
                        .await?,
                )
                .await?;
                if response.status() == reqwest::StatusCode::NO_CONTENT {
                    return Ok(serde_json::from_value(serde_json::Value::Null)?);
                }
                anyhow::Ok(response.json().await?)
            })
            .map_err(failed)
    }
}
fn failed(error: anyhow::Error) -> tessera_core::Error {
    // `io::Error::source` skips its payload, so keep the hub's code as the payload itself.
    tessera_core::Error::Io(match error.downcast::<HubError>() {
        Ok(hub) => std::io::Error::other(hub),
        Err(error) => std::io::Error::other(error),
    })
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
        #[derive(Deserialize)]
        struct Missing {
            ids: Vec<String>,
        }
        self.call::<Missing>("/api/sync/snapshots/missing", json!({"ids": ids}))
            .map(|m| m.ids)
    }
    fn snapshot_content(
        &mut self,
        ids: &[String],
        from: i64,
    ) -> tessera_core::Result<Vec<SnapshotContent>> {
        self.call(
            "/api/sync/snapshots/content",
            json!({"ids": ids, "from": from}),
        )
    }
    fn store_snapshots(&mut self, content: &[SnapshotContent]) -> tessera_core::Result<()> {
        self.call("/api/sync/snapshots", json!(content))
    }
    fn missing_objects(&mut self, shas: &[String]) -> tessera_core::Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Missing {
            ids: Vec<String>,
        }
        self.call::<Missing>("/api/sync/objects/missing", json!({"ids": shas}))
            .map(|m| m.ids)
    }
    fn object(&mut self, sha: &str) -> tessera_core::Result<Option<Vec<u8>>> {
        self.runtime
            .block_on(async {
                let response = self
                    .client
                    .get(format!("{}/api/sync/objects/{sha}", self.base))
                    .send()
                    .await?;
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    return Ok(None);
                }
                anyhow::Ok(Some(checked(response).await?.bytes().await?.to_vec()))
            })
            .map_err(failed)
    }
    fn store_object(&mut self, sha: &str, bytes: &[u8]) -> tessera_core::Result<()> {
        self.runtime
            .block_on(async {
                checked(
                    self.client
                        .put(format!("{}/api/sync/objects/{sha}", self.base))
                        .body(bytes.to_vec())
                        .send()
                        .await?,
                )
                .await?;
                anyhow::Ok(())
            })
            .map_err(failed)
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
    fn retire(&mut self, device: &str) -> tessera_core::Result<()> {
        self.call("/api/sync/retire", json!({"device": device}))
    }
}
