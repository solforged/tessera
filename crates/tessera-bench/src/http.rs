use std::path::Path;

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use tessera_core::{Batch, Committed, Notebook};

pub struct Http {
    base: String,
    client: reqwest::Client,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Http {
    pub async fn start(dir: &Path) -> Result<Self> {
        let notebook = Notebook::open(dir)?;
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let router =
            tessera_service::router(notebook, port, None, None).map_err(anyhow::Error::msg)?;
        let task = tokio::spawn(async move { axum::serve(listener, router).await });
        let client = reqwest::Client::builder().no_proxy().build()?;
        Ok(Self {
            base: format!("http://127.0.0.1:{port}"),
            client,
            task,
        })
    }

    pub async fn get<T: DeserializeOwned>(&self, route: &str) -> Result<T> {
        self.client
            .get(format!("{}{route}", self.base))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("decoding HTTP query JSON")
    }

    pub async fn apply(&self, batch: &Batch) -> Result<Committed> {
        self.client
            .post(format!("{}/api/batches", self.base))
            .json(batch)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("decoding HTTP commit JSON")
    }
}

impl Drop for Http {
    fn drop(&mut self) {
        self.task.abort();
    }
}
