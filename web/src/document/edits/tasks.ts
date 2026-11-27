import { ulid } from 'ulid';
import type { TaskState } from '../../api/types';
import { fieldEntryId } from '../../core/field-entry';
import { newTask } from '../../model/tasks';
import { sameState } from '../types';
import type { Edit } from '../contract';
import type { DocumentInternals } from './internals';
import type { EditSession } from './session';

function hasPendingRecurringCompletion(doc: DocumentInternals, id: string): boolean {
  return doc.host
    .commands(doc.pageId)
    .some(command =>
      command.actions.some(action => action.kind === 'completeTask' && action.id === id && action.previous.repeater),
    );
}

export function editBulkTask(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'bulkTask' }>,
): void {
  const { actions } = session;
  const targets = [...new Set(edit.ids)];
  if (!targets.length) return;
  for (const id of targets) {
    if (hasPendingRecurringCompletion(doc, id))
      throw new Error('Wait for the recurring completion before changing this task.');
  }
  for (const id of targets) {
    const block = doc.snapshot(id);
    const state = doc.capabilities(id);
    const baseRevision = block.revision;
    let currentTask: TaskState | null = state.task ? (JSON.parse(JSON.stringify(state.task)) as TaskState) : null;
    if (edit.status === null) {
      if (!currentTask) continue;
      session.removeCapabilityTags(id, 'task');
      actions.push({ kind: 'task', id, value: null, previous: currentTask, baseRevision });
      continue;
    }
    if (edit.status === 'done') {
      if (!edit.completedOn) throw new Error('A completion date is required.');
      if (currentTask?.status === 'done' && !currentTask.repeater) continue;
      if (!currentTask?.status) {
        const started: TaskState = { ...(currentTask ?? newTask()), status: 'todo', completed_on: null };
        actions.push({ kind: 'task', id, value: started, previous: currentTask, baseRevision });
        currentTask = started;
      }
      if (edit.patch) {
        const patched: TaskState = { ...currentTask, ...edit.patch };
        if (!sameState(currentTask, patched)) {
          actions.push({ kind: 'task', id, value: patched, previous: currentTask, baseRevision });
          currentTask = patched;
        }
      }
      if (edit.stopWork && edit.stopWork.block_id === id) {
        if (edit.stopWork.ended_at !== null || edit.stopWork.reversed)
          throw new Error('Refresh the running work session before completing.');
        const known = doc.work.get(edit.stopWork.id);
        if (known && known.revision >= edit.stopWork.revision && !sameState(known, edit.stopWork))
          throw new Error('The work session changed. Refresh before completing.');
        actions.push({
          kind: 'stopWork',
          id,
          session: { ...edit.stopWork },
          endedAt: Date.now(),
          note: edit.stopWork.note,
          baseRevision,
        });
      }
      actions.push({
        kind: 'completeTask',
        id,
        occurrenceId: ulid(),
        completedOn: edit.completedOn,
        previous: currentTask,
        baseRevision,
      });
      continue;
    }
    if (edit.status !== undefined) {
      if (!currentTask?.status && edit.status !== 'todo') {
        const started: TaskState = { ...(currentTask ?? newTask()), status: 'todo', completed_on: null };
        actions.push({ kind: 'task', id, value: started, previous: currentTask, baseRevision });
        currentTask = started;
      }
      const next: TaskState = {
        ...(currentTask ?? newTask()),
        ...(edit.patch ?? {}),
        status: edit.status,
        completed_on: null,
      };
      if (!sameState(currentTask, next))
        actions.push({ kind: 'task', id, value: next, previous: currentTask, baseRevision });
      continue;
    }
    if (edit.patch) {
      const next: TaskState = { ...(currentTask ?? newTask()), ...edit.patch };
      if (!sameState(currentTask, next))
        actions.push({ kind: 'task', id, value: next, previous: currentTask, baseRevision });
    }
  }
}

export function editTaskWork(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<
    Edit,
    { kind: 'task' | 'planTask' | 'project' | 'completeTask' | 'startWork' | 'stopWork' | 'workNote' }
  >,
): void {
  const { actions } = session;
  const block = doc.snapshot(edit.id);
  const state = doc.capabilities(edit.id);
  if (hasPendingRecurringCompletion(doc, edit.id))
    throw new Error('Wait for the recurring completion before changing this task.');
  const baseRevision = block.revision;
  if (edit.kind === 'task' || edit.kind === 'planTask') {
    if (edit.value === null) session.removeCapabilityTags(edit.id, 'task');
    const value = edit.value === null ? null : JSON.parse(JSON.stringify(edit.value));
    if (value?.status === 'done' && state.task?.status !== 'done')
      throw new Error('Complete the task to record its occurrence.');
    if (!state.task && value && value.status !== null && value.status !== 'todo')
      throw new Error('A new task starts Todo.');
    if (!sameState(state.task, value))
      actions.push({ kind: 'task', id: edit.id, value, previous: state.task, baseRevision });
    if (edit.kind === 'planTask') {
      session.setText(block, edit.text);
      session.caret = { id: edit.id, offset: edit.text.length };
    }
  } else if (edit.kind === 'project') {
    if (edit.value === null) session.removeCapabilityTags(edit.id, 'project');
    const value = edit.value === null ? null : JSON.parse(JSON.stringify(edit.value));
    if (!sameState(state.project, value))
      actions.push({ kind: 'project', id: edit.id, value, previous: state.project, baseRevision });
  } else if (edit.kind === 'completeTask') {
    const task = state.task;
    if (!task?.status) throw new Error('Add #task before completing.');
    if (task.status === 'done' && !task.repeater) return;
    if (edit.stopWork) {
      if (edit.stopWork.block_id !== edit.id || edit.stopWork.ended_at !== null || edit.stopWork.reversed)
        throw new Error('Refresh the running work session before completing.');
      const known = doc.work.get(edit.stopWork.id);
      if (known && known.revision >= edit.stopWork.revision && !sameState(known, edit.stopWork))
        throw new Error('The work session changed. Refresh before completing.');
      actions.push({
        kind: 'stopWork',
        id: edit.id,
        session: { ...edit.stopWork },
        endedAt: Date.now(),
        note: edit.stopWork.note,
        baseRevision,
      });
    }
    actions.push({
      kind: 'completeTask',
      id: edit.id,
      occurrenceId: ulid(),
      completedOn: edit.completedOn,
      previous: task,
      baseRevision,
    });
  } else if (edit.kind === 'startWork') {
    const active = doc.host.runningWork();
    if (active) throw new Error('Stop the running work session before starting another.');
    actions.push({
      kind: 'startWork',
      id: edit.id,
      session: {
        id: ulid(),
        block_id: edit.id,
        started_at: edit.startedAt,
        ended_at: null,
        note: '',
        reversed: false,
        revision: 0,
      },
      baseRevision,
    });
  } else {
    if (edit.session.block_id !== edit.id) throw new Error('The work session belongs to another task.');
    const session = { ...edit.session };
    const known = doc.work.get(session.id);
    if (known && known.revision >= session.revision && !sameState(known, session))
      throw new Error('The work session changed. Refresh before editing it.');
    if (edit.kind === 'stopWork')
      actions.push({
        kind: 'stopWork',
        id: edit.id,
        session,
        endedAt: edit.endedAt,
        note: edit.note,
        baseRevision,
      });
    else if (session.note !== edit.note)
      actions.push({ kind: 'workNote', id: edit.id, session, note: edit.note, baseRevision });
  }
}

export function editTaskProject(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'taskProject' }>,
): void {
  const { actions } = session;
  if (!doc.block(edit.id)?.task) throw new Error('Task removed.');
  const entries = doc.outline
    .children(edit.id)
    .filter(id => !doc.block(id)?.archived && fieldEntryId(doc.block(id)?.text ?? '') === edit.fieldId);
  const remove = edit.projectId === null ? entries : entries.slice(1);
  for (const id of remove) {
    doc.guardHide(id);
    actions.push({ kind: 'delete', id });
  }
  if (edit.projectId !== null) {
    const entry =
      entries[0] ?? session.insert(edit.id, doc.outline.children(edit.id).at(-1) ?? null, `[[${edit.fieldId}]]`);
    const values = doc.outline.children(entry).filter(id => !doc.block(id)?.archived);
    const text = `[[${edit.projectId}]]`;
    if (values[0]) session.setText(doc.snapshot(values[0]), text);
    else session.insert(entry, null, text);
    for (const id of values.slice(1)) {
      doc.guardHide(id);
      actions.push({ kind: 'delete', id });
    }
  }
}
