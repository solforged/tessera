use axum::{Json, extract::State};

use crate::error::ApiError;
use crate::run::run;
use crate::state::WorkshopState;
use tessera_core::CheckReport;

pub(crate) async fn check_notebook(
    State(state): State<WorkshopState>,
) -> Result<Json<CheckReport>, ApiError> {
    run(&state.notebook, |notebook| notebook.check(false))
        .await
        .map(Json)
}
/// Repair publishes its change like a batch, so open windows reload what it touched.
pub(crate) async fn repair_notebook(
    State(state): State<WorkshopState>,
) -> Result<Json<CheckReport>, ApiError> {
    let changes = state.changes.clone();
    run(&state.notebook, move |notebook| {
        let report = notebook.check(true)?;
        if let Some(seq) = report.repaired {
            let _ = changes.send(notebook.editor_change_cursor(seq)?);
        }
        Ok(report)
    })
    .await
    .map(Json)
}
