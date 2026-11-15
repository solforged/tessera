//! Sync settlement of kept copies and rejected changes.

use rusqlite::{OptionalExtension, params};

use super::Engine;
use crate::storage::{stored, validate_id, validation};
use crate::{Operation, Result};

impl Engine<'_, '_> {
    pub(super) fn apply_settle_sync_copy(
        &mut self,
        operation: &Operation,
        _index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SettleSyncCopy { id, settled } => {
                validate_id(id)?;
                let previous = self.tx.query_row(
                    "SELECT settled_at IS NOT NULL FROM sync_conflicts WHERE id = ?1 AND kind = 'copy'",
                    [id],
                    |row| row.get::<_, bool>(0),
                ).optional()?.ok_or_else(|| validation("unknown sync copy"))?;
                if previous != *settled {
                    self.tx.execute(
                        "UPDATE sync_conflicts SET settled_at = ?2 WHERE id = ?1",
                        params![id, settled.then_some(self.now)],
                    )?;
                    let current =
                        stored(self.tx, id)?.ok_or_else(|| validation("unknown sync copy atom"))?;
                    self.tx.execute(
                        "UPDATE blocks SET revision = revision + 1, updated_at = ?2 WHERE id = ?1",
                        params![id, self.now],
                    )?;
                    self.record_revision(id, current.block.revision + 1);
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_settle_sync_rejection(
        &mut self,
        operation: &Operation,
        _index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SettleSyncRejection { id, settled } => {
                validate_id(id)?;
                let previous = self.tx.query_row(
                    "SELECT settled_at IS NOT NULL FROM sync_conflicts WHERE id = ?1 AND kind = 'rejected'",
                    [id],
                    |row| row.get::<_, bool>(0),
                ).optional()?.ok_or_else(|| validation("unknown sync rejection"))?;
                if previous != *settled {
                    self.tx.execute(
                        "UPDATE sync_conflicts SET settled_at = ?2 WHERE id = ?1",
                        params![id, settled.then_some(self.now)],
                    )?;
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }
}
