//! Tasks, projects, work sessions and task views.

use super::Engine;
use crate::{Operation, Result};

impl Engine<'_, '_> {
    pub(super) fn apply_task(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SetTask {
                id, base_revision, ..
            }
            | Operation::RestoreTaskState {
                id, base_revision, ..
            }
            | Operation::CompleteTask {
                id, base_revision, ..
            }
            | Operation::ReverseTaskCompletion {
                id, base_revision, ..
            }
            | Operation::SetProject {
                id, base_revision, ..
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                let changed = crate::task_store::apply(self.tx, operation, self.now, self.seq)?;
                let removed = match operation {
                    Operation::SetTask { task: None, .. } => {
                        self.remove_capability_tag(id, "task")?
                    }
                    Operation::SetProject { project: None, .. } => {
                        self.remove_capability_tag(id, "project")?
                    }
                    _ => false,
                };
                if changed {
                    if !removed {
                        self.bump(&current, false)?;
                    }
                    self.capability_sources.insert(id.clone());
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_work(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::StartWork {
                id, base_revision, ..
            }
            | Operation::StopWork {
                id, base_revision, ..
            }
            | Operation::EditWorkNote {
                id, base_revision, ..
            }
            | Operation::SetWorkSessionState {
                id, base_revision, ..
            } => {
                let current = self.checked(id, *base_revision, index, false)?;
                if let Some(session) =
                    crate::work_store::apply(self.tx, operation, self.now, self.seq, index)?
                {
                    self.bump(&current, false)?;
                    if matches!(
                        operation,
                        Operation::StartWork { .. }
                            | Operation::StopWork { .. }
                            | Operation::SetWorkSessionState { .. }
                    ) {
                        self.capability_sources.insert(id.clone());
                    }
                    self.work_sessions.insert(session.id.clone(), session);
                }
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }

    pub(super) fn apply_task_view(&mut self, operation: &Operation, index: usize) -> Result<()> {
        match operation {
            Operation::SaveTaskView { .. } | Operation::DeleteTaskView { .. } => {
                let revision = crate::task_query::apply_view(self.tx, operation, self.now, index)?;
                self.task_views.insert(revision.id.clone(), revision);
                Ok(())
            }
            _ => unreachable!("dispatched by variant"),
        }
    }
}
