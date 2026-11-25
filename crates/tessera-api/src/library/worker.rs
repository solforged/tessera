/// Wakes the single persistent ingestion worker. Dropping its last handle stops it.
#[cfg(native)]
#[derive(Clone)]
pub struct Library(Arc<Control>);
#[cfg(native)]
struct Control {
    notify: Arc<Notify>,
    abort: tokio::task::AbortHandle,
}
#[cfg(native)]
impl Drop for Control {
    fn drop(&mut self) {
        self.abort.abort();
    }
}
#[cfg(native)]
impl Library {
    pub fn kick(&self) {
        self.0.notify.notify_one();
    }
    pub fn start(
        workshop: Arc<Mutex<Workshop>>,
        changes: broadcast::Sender<i64>,
        extractor: Extractor,
    ) -> Result<Self, String> {
        workshop.lock().resume_ingest().map_err(|e| e.to_string())?;
        let client = crate::tls_client_builder()?
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        let notify = Arc::new(Notify::new());
        let worker = Worker {
            workshop,
            changes,
            notify: notify.clone(),
            client,
            extractor,
        };
        let task = tokio::spawn(worker.run());
        Ok(Self(Arc::new(Control {
            notify,
            abort: task.abort_handle(),
        })))
    }
}
#[cfg(native)]
struct Worker {
    workshop: Arc<Mutex<Workshop>>,
    changes: broadcast::Sender<i64>,
    notify: Arc<Notify>,
    client: reqwest::Client,
    extractor: Extractor,
}
#[cfg(native)]
struct Failure {
    message: String,
    retryable: bool,
}
#[cfg(native)]
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self {
            message,
            retryable: false,
        }
    }
}
#[cfg(native)]
impl Worker {
    async fn access<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Workshop) -> tessera_core::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        let workshop = self.workshop.clone();
        tokio::task::spawn_blocking(move || {
            let mut n = workshop.lock();
            f(&mut n).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("The ingestion task stopped: {e}."))?
    }
    async fn run(self) {
        loop {
            // A Notify permit is retained if a request arrives while a job is running.
            let job = match self.access(|n| n.claim_ingest()).await {
                Ok(job) => job,
                Err(error) => {
                    tracing::error!(%error, "ingest worker could not claim a job");
                    return;
                }
            };
            if let Some(job) = job {
                tracing::info!(job_id = %job.id, attempt = job.attempts, "ingest job started");
                if let Err(error) = self.process(&job).await {
                    tracing::warn!(job_id = %job.id, error = %error.message, "ingest job failed");
                    let delay = if error.retryable {
                        match job.attempts {
                            1 => Some(30_000),
                            2 => Some(120_000),
                            3 => Some(600_000),
                            _ => None,
                        }
                    } else {
                        None
                    };
                    let retry_at = delay.map(|delay| now_ms() + delay);
                    if let Err(error) = self
                        .access(move |n| n.fail_ingest(&job.id, &error.message, retry_at))
                        .await
                    {
                        tracing::error!(%error, "ingest worker could not record failure");
                        return;
                    }
                } else {
                    tracing::info!(job_id = %job.id, "ingest job finished");
                }
                continue;
            }
            let next = match self.access(|n| n.next_ingest_at()).await {
                Ok(next) => next,
                Err(error) => {
                    tracing::error!(%error, "ingest worker could not schedule next job");
                    return;
                }
            };
            let delay = next
                .map(|next| Duration::from_millis((next - now_ms()).max(0) as u64))
                .unwrap_or(Duration::from_secs(86400));
            tokio::select! {_=self.notify.notified()=>{},_=tokio::time::sleep(delay)=>{}}
        }
    }
    async fn fetch(
        &self,
        url: &str,
        cap: usize,
        image: bool,
    ) -> Result<(Vec<u8>, String), Failure> {
        let url = reqwest::Url::parse(url)
            .map_err(|_| Failure::from("The source URL is not valid.".to_owned()))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(Failure::from(
                "Only HTTP and HTTPS resources are accepted.".to_owned(),
            ));
        }
        let network = |error: reqwest::Error| Failure {
            message: format!("The source could not be downloaded: {error}."),
            retryable: true,
        };
        let mut response = self.client.get(url).send().await.map_err(network)?;
        let status = response.status();
        if !status.is_success() {
            return Err(Failure {
                message: format!("The source server returned HTTP {status}."),
                retryable: status.is_server_error(),
            });
        }
        let media = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_owned();
        if image && !media.starts_with("image/") {
            return Err(Failure::from("The resource is not an image.".to_owned()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > cap as u64)
        {
            return Err(Failure::from(
                "The source exceeds the download size limit.".to_owned(),
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network)? {
            if bytes.len() + chunk.len() > cap {
                return Err(Failure::from(
                    "The source exceeds the download size limit.".to_owned(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((bytes, media))
    }
    async fn process(&self, job: &IngestJob) -> Result<(), Failure> {
        let (bytes, media) = match job.input_kind {
            IngestInput::Url => self.fetch(&job.input, 32 * 1024 * 1024, false).await?,
            IngestInput::File => {
                let hash = job.input.clone();
                (
                    self.access(move |n| n.read_object(&hash)).await?,
                    String::new(),
                )
            }
        };
        let extractor = self.extractor;
        let name = job.name.clone();
        let url = (job.input_kind == IngestInput::Url).then(|| job.input.clone());
        let workshop = self.workshop.clone();
        let (doc, sha) = tokio::task::spawn_blocking(move || {
            let sha = workshop
                .lock()
                .put_object(&bytes)
                .map_err(|e| e.to_string())?;
            let doc = extractor(&bytes, Some(&media), &name, url.as_deref())?;
            Ok::<_, String>((doc, sha))
        })
        .await
        .map_err(|e| format!("The source parser stopped: {e}."))??;
        let mut resources = Vec::new();
        if doc.format == SourceFormat::Article {
            let mut seen = std::collections::HashSet::new();
            for href in doc
                .passages
                .iter()
                .filter(|p| p.kind == PassageKind::Image)
                .filter_map(|p| p.resource.as_deref())
                .filter(|href| seen.insert(*href))
                .take(60)
            {
                if let Ok((bytes, media)) = self.fetch(href, 10 * 1024 * 1024, true).await {
                    let hash = self.access(move |n| n.put_object(&bytes)).await?;
                    resources.push((href.to_owned(), hash, media));
                }
            }
        }
        let job = job.clone();
        let changes = self.changes.clone();
        self.access(move |n| commit(n, &job, &doc, &sha, resources, &changes))
            .await?;
        Ok(())
    }
}

