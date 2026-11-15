//! Card templates, grades, holds and decks.

use super::{Engine, checks_shown_card};
use crate::{Operation, Result};

impl Engine<'_, '_> {
    pub(super) fn apply_transfer_card_key(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::TransferCardKey { source_id, .. } => {
                let revision =
                    crate::card_templates::transfer_key(self.tx, operation, self.now, index)?;
                self.cards.insert(revision.id.clone(), revision);
                self.card_sources.insert(source_id.clone());
                let current = self.live(source_id)?;
                self.record_revision(source_id, current.block.revision);
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_card_template(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::CreateCardTemplate { .. }
            | Operation::UpdateCardTemplate { .. }
            | Operation::SetCardTemplateApplied { .. }
            | Operation::DeleteCardTemplate { .. } => {
                let (type_id, revision) =
                    crate::card_templates::apply(self.tx, operation, self.now, index)?;
                self.template_types.insert(type_id);
                self.record_revision(&revision.id, revision.revision);
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_review(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::StartReviewSession { .. }
            | Operation::FinishReviewSession { .. }
            | Operation::GradeCard { .. }
            | Operation::UndoGrade { .. }
            | Operation::ResetCard { .. }
            | Operation::SetCardHeld { .. }
            | Operation::SaveDeck { .. }
            | Operation::DeleteDeck { .. } => {
                // A preceding text edit must invalidate stale shown definitions
                // before a grade, reset or hold checks the card's own revision.
                if checks_shown_card(operation) {
                    self.derive_cards()?;
                }
                let changes =
                    crate::review_store::apply(self.tx, operation, self.now, self.seq, index)?;
                for revision in changes.cards {
                    self.cards.insert(revision.id.clone(), revision);
                }
                for session in changes.sessions {
                    self.review_sessions.insert(session.id.clone(), session);
                }
                for revision in changes.decks {
                    self.decks.insert(revision.id.clone(), revision);
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }
}
