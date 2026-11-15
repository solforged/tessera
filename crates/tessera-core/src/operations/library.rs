//! Sources, citations and library views.

use rusqlite::OptionalExtension;

use super::Engine;
use crate::{Operation, Result};

impl Engine<'_, '_> {
    pub(super) fn apply_library_source(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SetSource {
                id, base_revision, ..
            }
            | Operation::AttachSnapshot {
                id, base_revision, ..
            }
            | Operation::Cite {
                id, base_revision, ..
            }
            | Operation::Uncite {
                id, base_revision, ..
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                let activates = matches!(
                    operation,
                    Operation::SetSource {
                        source: Some(crate::library::SourceState {
                            citation_key: None,
                            ..
                        }),
                        ..
                    }
                ) && !self.tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sources WHERE block_id = ?1 AND active = 1)",
                    [id],
                    |row| row.get::<_, bool>(0),
                )?;
                let changed = crate::library_store::apply(self.tx, operation, self.now, self.seq)?;
                let removed = matches!(operation, Operation::SetSource { source: None, .. })
                    && self.remove_capability_tag(id, "source")?;
                if changed {
                    if !removed {
                        self.bump(&current, false)?;
                    }
                    self.capability_sources.insert(id.clone());
                    if activates {
                        self.activated_sources.insert(id.clone());
                    }
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_citation(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SetCitationTriage {
                id, base_revision, ..
            }
            | Operation::SetCitationRange {
                id, base_revision, ..
            }
            | Operation::SetCitationColor {
                id, base_revision, ..
            } => {
                let block_id: String = self
                    .tx
                    .query_row(
                        "SELECT block_id FROM citations WHERE id = ?1 AND active = 1",
                        [id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| crate::storage::not_found(id))?;
                let current = self.checked(&block_id, *base_revision, index, false)?;
                if crate::library_store::apply(self.tx, operation, self.now, self.seq)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(block_id);
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_library_view(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SaveLibraryView { .. } | Operation::DeleteLibraryView { .. } => {
                let revision =
                    crate::library_views::apply_view(self.tx, operation, self.now, index)?;
                self.library_views.insert(revision.id.clone(), revision);
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }
}
