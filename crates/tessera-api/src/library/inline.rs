/// its requests are already serialized around the one workshop connection.
#[cfg(browser)]
#[derive(Clone)]
pub struct Library {
    workshop: Arc<Mutex<Workshop>>,
    changes: broadcast::Sender<i64>,
    extractor: Extractor,
}
#[cfg(browser)]
impl Library {
    /// Run every due job to completion before returning.
    pub fn kick(&self) {
        let mut n = self.workshop.lock();
        loop {
            let job = match n.claim_ingest() {
                Ok(Some(job)) => job,
                Ok(None) => return,
                Err(error) => {
                    tracing::error!(%error, "ingest could not claim a job");
                    return;
                }
            };
            if let Err(message) = self.process(&mut n, &job) {
                tracing::warn!(job_id = %job.id, error = %message, "ingest job failed");
                if let Err(error) = n.fail_ingest(&job.id, &message, None) {
                    tracing::error!(%error, "ingest could not record failure");
                    return;
                }
            }
        }
    }
    fn process(&self, n: &mut Workshop, job: &IngestJob) -> Result<(), String> {
        if job.input_kind != IngestInput::File {
            return Err("The browser demo can only add uploaded EPUB files.".to_owned());
        }
        let bytes = n.read_object(&job.input).map_err(|e| e.to_string())?;
        let doc = (self.extractor)(&bytes, None, &job.name, None)?;
        commit(n, job, &doc, &job.input, Vec::new(), &self.changes).map_err(|e| e.to_string())
    }
    pub fn start(
        workshop: Arc<Mutex<Workshop>>,
        changes: broadcast::Sender<i64>,
        extractor: Extractor,
    ) -> Result<Self, String> {
        workshop.lock().resume_ingest().map_err(|e| e.to_string())?;
        let library = Self {
            workshop,
            changes,
            extractor,
        };
        library.kick();
        Ok(library)
    }
}

