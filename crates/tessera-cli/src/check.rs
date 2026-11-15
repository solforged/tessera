//! `tessera check`: verify a workshop, and repair its derived tables. While a
//! service owns the workshop the check goes through it, as `sync status` does.

use std::path::Path;

use anyhow::Context;
use tessera_core::{CheckReport, DATABASE_FILE, Workshop, WorkshopOwnership};

pub(crate) fn run(workshop: &Path, repair: bool) -> anyhow::Result<()> {
    anyhow::ensure!(
        workshop.join(DATABASE_FILE).exists(),
        "{} holds no workshop",
        workshop.display()
    );
    let report = match WorkshopOwnership::acquire(workshop, 0) {
        Ok(_ownership) => serde_json::to_value(Workshop::open(workshop)?.check(repair)?)?,
        Err(unowned) => {
            let unowned = anyhow::Error::from(unowned)
                .context("the workshop is owned by a service that did not answer");
            let (method, path) = if repair {
                (reqwest::Method::POST, "/api/check/repair")
            } else {
                (reqwest::Method::GET, "/api/check")
            };
            crate::sync::served(workshop, unowned, method, path)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    let report: CheckReport = serde_json::from_value(report).context("unexpected check report")?;
    if report.unresolved() {
        std::process::exit(1);
    }
    Ok(())
}
