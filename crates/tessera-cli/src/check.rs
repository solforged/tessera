//! `tessera check`: verify a notebook, and repair its derived tables. While a
//! service owns the notebook the check goes through it, as `sync status` does.

use std::path::Path;

use anyhow::Context;
use tessera_core::{CheckReport, DATABASE_FILE, Notebook, NotebookOwnership};

pub(crate) fn run(notebook: &Path, repair: bool) -> anyhow::Result<()> {
    anyhow::ensure!(
        notebook.join(DATABASE_FILE).exists(),
        "{} holds no notebook",
        notebook.display()
    );
    let report = match NotebookOwnership::acquire(notebook, 0) {
        Ok(_ownership) => serde_json::to_value(Notebook::open(notebook)?.check(repair)?)?,
        Err(unowned) => {
            let unowned = anyhow::Error::from(unowned)
                .context("the notebook is owned by a service that did not answer");
            let (method, path) = if repair {
                (reqwest::Method::POST, "/api/check/repair")
            } else {
                (reqwest::Method::GET, "/api/check")
            };
            crate::sync::served(notebook, unowned, method, path)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    let report: CheckReport = serde_json::from_value(report).context("unexpected check report")?;
    if report.unresolved() {
        std::process::exit(1);
    }
    Ok(())
}
