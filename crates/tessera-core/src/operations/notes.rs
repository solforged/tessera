//! Relations, positions, spreads, revisits, quotes, images and questions.

use super::Engine;
use crate::storage::validation;
use crate::{BlockKind, Operation, Result};

impl Engine<'_, '_> {
    pub(super) fn apply_set_position(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SetPosition {
                id,
                base_revision,
                position,
            } => {
                crate::position_store::validate_source(self.tx, id)?;
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::position_store::set(self.tx, id, *position)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_relation(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SetRelation {
                id,
                base_revision,
                relation,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::relation_store::set(self.tx, id, *relation)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_spread(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SetSpread {
                id,
                base_revision,
                spread,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if current.block.kind != BlockKind::Page {
                    return Err(validation("Only a titled atom can be a spread."));
                }
                if crate::spreads::set(self.tx, id, *spread)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_revisit(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::Revisit {
                id, base_revision, ..
            }
            | Operation::RestoreRevisit {
                id, base_revision, ..
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::revisit_store::apply(self.tx, operation, self.now, self.seq)? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_quote(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SetQuote {
                id,
                base_revision,
                quote,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::quote_store::set(self.tx, &current.block, quote.as_ref())? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_image(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SetImage {
                id,
                base_revision,
                image,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::image_store::set(
                    self.tx,
                    self.object_dir,
                    self.local,
                    &current.block,
                    image.as_ref(),
                )? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                    self.card_sources.insert(id.clone());
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_occlusion(
        &mut self,
        operation: &Operation,
        index: usize,
    ) -> Result<()> {
        match operation {
            Operation::SetOcclusion {
                id,
                base_revision,
                occlusion,
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if crate::occlusion::set(self.tx, id, occlusion.as_ref())? {
                    self.bump(&current, false)?;
                    self.capability_sources.insert(id.clone());
                    self.card_sources.insert(id.clone());
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_set_question(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SetQuestion {
                id, base_revision, ..
            }
            | Operation::SetAssessment {
                id, base_revision, ..
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if matches!(
                    operation,
                    Operation::SetQuestion {
                        question: Some(_),
                        ..
                    }
                ) && current.block.kind == BlockKind::Journal
                {
                    return Err(validation("Make a non-journal atom a question."));
                }
                if matches!(
                    operation,
                    Operation::SetAssessment {
                        assessment: Some(_),
                        ..
                    }
                ) && current.block.kind != BlockKind::Block
                {
                    return Err(validation("Make an ordinary atom an answer."));
                }
                let revisit_before = if matches!(operation, Operation::SetQuestion { .. }) {
                    Some(crate::revisit_store::snapshot(self.tx, id)?)
                } else {
                    None
                };
                let today = crate::settings::today_in_connection(self.tx, self.now)?;
                let changed = crate::question_store::apply(self.tx, operation, &today)?;
                let removed = matches!(operation, Operation::SetQuestion { question: None, .. })
                    && self.remove_capability_tag(id, "question")?;
                if changed {
                    if let Some(before) = revisit_before {
                        crate::revisit_store::question_changed(self.tx, id, &before, self.now)?;
                    }
                    if !removed {
                        self.bump(&current, false)?;
                    }
                    self.capability_sources.insert(id.clone());
                    if matches!(
                        operation,
                        Operation::SetAssessment {
                            assessment: None,
                            ..
                        }
                    ) {
                        for owner in crate::question_store::withdraw_acceptance(self.tx, id)? {
                            let question = self.live(&owner)?;
                            self.bump(&question, false)?;
                            self.capability_sources.insert(owner);
                        }
                    }
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }
}
