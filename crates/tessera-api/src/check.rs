use axum::{Json, extract::State};

use crate::error::ApiError;
use crate::run::{read, run};
use crate::state::WorkshopState;
use tessera_core::CheckReport;

pub(crate) async fn check_workshop(
    State(state): State<WorkshopState>,
) -> Result<Json<CheckReport>, ApiError> {
    read(&state, |workshop| workshop.check_snapshot())
        .await
        .map(Json)
}
/// Repair publishes its change like a batch, so open windows reload what it touched.
pub(crate) async fn repair_workshop(
    State(state): State<WorkshopState>,
) -> Result<Json<CheckReport>, ApiError> {
    let changes = state.changes.clone();
    run(&state.workshop, move |workshop| {
        let report = workshop.check(true)?;
        if let Some(seq) = report.repaired {
            let _ = changes.send(workshop.editor_change_cursor(seq)?);
        }
        Ok(report)
    })
    .await
    .map(Json)
}
