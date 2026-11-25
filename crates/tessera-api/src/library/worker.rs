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
        let dir = {
            let n = workshop.lock();
            n.resume_ingest().map_err(|e| e.to_string())?;
            n.info().map_err(|e| e.to_string())?.path
        };
        let client = crate::tls_client_builder()?
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        let notify = Arc::new(Notify::new());
        let worker = Worker {
            dir,
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
    dir: std::path::PathBuf,
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
fn is_non_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || (octets[0] == 100 && (octets[1] & 0b1100_0000) == 0b0100_0000)
                || (octets[0] == 198 && matches!(octets[1], 18 | 19))
                || octets[0] >= 224
        }
        std::net::IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_non_public_ip(std::net::IpAddr::V4(mapped));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
        }
    }
}

#[cfg(native)]
fn is_non_public_url_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    let trimmed = host.trim_matches(['[', ']']);
    if let Ok(ip) = trimmed.parse::<std::net::IpAddr>() {
        return is_non_public_ip(ip);
    }
    let lower = trimmed.trim_end_matches('.').to_ascii_lowercase();
    lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
}

#[cfg(native)]
fn same_url_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

#[cfg(native)]
fn allow_article_image(href: &str, article_url: Option<&str>) -> bool {
    let Ok(image_url) = reqwest::Url::parse(href) else {
        return false;
    };
    if !matches!(image_url.scheme(), "http" | "https") {
        return false;
    }
    if !is_non_public_url_host(&image_url) {
        return true;
    }
    // Only allow a local image host when the article itself was fetched from
    // that exact local origin (such as a local preview server).
    article_url
        .and_then(|source| reqwest::Url::parse(source).ok())
        .is_some_and(|source| is_non_public_url_host(&source) && same_url_origin(&image_url, &source))
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
        forbid_private: bool,
    ) -> Result<(Vec<u8>, String), Failure> {
        let url = reqwest::Url::parse(url)
            .map_err(|_| Failure::from("The source URL is not valid.".to_owned()))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(Failure::from(
                "Only HTTP and HTTPS resources are accepted.".to_owned(),
            ));
        }
        if forbid_private {
            if is_non_public_url_host(&url) {
                return Err(Failure::from(
                    "Refused to fetch a non-public resource.".to_owned(),
                ));
            }
            let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
            let port = url.port_or_known_default().unwrap_or(80);
            let addrs = tokio::net::lookup_host((host, port))
                .await
                .map_err(|e| Failure {
                    message: format!("The source host could not be resolved: {e}."),
                    retryable: true,
                })?;
            let mut any = false;
            for addr in addrs {
                any = true;
                if is_non_public_ip(addr.ip()) {
                    return Err(Failure::from(
                        "Refused to fetch a non-public resource.".to_owned(),
                    ));
                }
            }
            if !any {
                return Err(Failure::from(
                    "The source host resolved to no addresses.".to_owned(),
                ));
            }
        }
        let network = |error: reqwest::Error| Failure {
            message: format!("The source could not be downloaded: {error}."),
            retryable: true,
        };
        let client = if forbid_private {
            // Do not follow a redirect from a public image URL onto a private host.
            crate::tls_client_builder()
                .map_err(Failure::from)?
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| Failure::from(e.to_string()))?
        } else {
            self.client.clone()
        };
        let mut response = client.get(url).send().await.map_err(network)?;
        if forbid_private
            && response
                .remote_addr()
                .is_some_and(|addr| is_non_public_ip(addr.ip()))
        {
            return Err(Failure::from(
                "Refused to fetch a non-public resource.".to_owned(),
            ));
        }
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
        let (bytes, media, pre_sha) = match job.input_kind {
            IngestInput::Url => {
                let (bytes, media) = self.fetch(&job.input, 32 * 1024 * 1024, false, false).await?;
                (bytes, media, None)
            }
            IngestInput::File => {
                let dir = self.dir.clone();
                let hash = job.input.clone();
                let bytes = tokio::task::spawn_blocking(move || {
                    tessera_core::read_object_in(&dir, &hash).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| format!("The ingestion task stopped: {e}."))??;
                (bytes, String::new(), Some(job.input.clone()))
            }
        };
        let extractor = self.extractor;
        let name = job.name.clone();
        let url = (job.input_kind == IngestInput::Url).then(|| job.input.clone());
        let dir = self.dir.clone();
        let (doc, sha, mut resources) = tokio::task::spawn_blocking(move || {
            let sha = match pre_sha {
                Some(sha) => sha,
                None => tessera_core::put_object_in(&dir, &bytes).map_err(|e| e.to_string())?,
            };
            let doc = extractor(&bytes, Some(&media), &name, url.as_deref())?;
            let mut resources = Vec::with_capacity(doc.resources.len());
            for resource in &doc.resources {
                let hash = tessera_core::put_object_in(&dir, &resource.bytes)
                    .map_err(|e| e.to_string())?;
                resources.push((
                    resource.href.clone(),
                    hash,
                    resource.media_type.clone(),
                ));
            }
            Ok::<_, String>((doc, sha, resources))
        })
        .await
        .map_err(|e| format!("The source parser stopped: {e}."))??;
        let source_url = (job.input_kind == IngestInput::Url).then_some(job.input.as_str());
        let source_is_local = source_url
            .and_then(|u| reqwest::Url::parse(u).ok())
            .is_some_and(|u| is_non_public_url_host(&u));
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
                if !allow_article_image(href, source_url) {
                    continue;
                }
                let forbid_private = !source_is_local;
                if let Ok((bytes, media)) =
                    self.fetch(href, 10 * 1024 * 1024, true, forbid_private).await
                {
                    let dir = self.dir.clone();
                    let hash = tokio::task::spawn_blocking(move || {
                        tessera_core::put_object_in(&dir, &bytes).map_err(|e| e.to_string())
                    })
                    .await
                    .map_err(|e| format!("The ingestion task stopped: {e}."))??;
                    resources.push((href.to_owned(), hash, media));
                }
            }
        }
        let job = job.clone();
        let changes = self.changes.clone();
        self.access(move |n| commit_staged(n, &job, &doc, &sha, &resources, &changes))
            .await?;
        Ok(())
    }
}

