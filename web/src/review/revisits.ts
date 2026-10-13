import { createEffect, createSignal, onCleanup } from 'solid-js';
import { ulid } from 'ulid';
import type { NoteState, RevisitAction, RevisitRow, RevisitSnapshot } from '../api/types';
import type { DocumentChange, NotebookClient } from '../document/contract';

export const workingNote = (): NoteState => ({ resolved_at: null, revisit_on: null, date_set_at: null });

export function createRevisits(notebook: NotebookClient) {
  const [rows, setRows] = createSignal<RevisitRow[]>([]);
  const [error, setError] = createSignal('');
  createEffect(() => {
    notebook.changeSequence(); const today = notebook.todayDate();
    const controller = new AbortController();
    void notebook.api.revisits(today, controller.signal).then(value => {
      if (!controller.signal.aborted) { setRows(value); setError(''); }
    }, reason => { if (!controller.signal.aborted) { setRows([]); setError(String(reason)); } });
    onCleanup(() => controller.abort());
  });
  return { rows, error };
}

/** Review advances across pages, so this history stays with the action, not the next page's outline. */
export async function changeRevisit(notebook: NotebookClient, id: string, action: RevisitAction, nextOn: string | null): Promise<DocumentChange | undefined> {
  let block = await notebook.api.block(id);
  const document = notebook.open(block.page_id);
  try { await document.flush(); } finally { document.release(); }
  block = await notebook.api.block(id);
  const capabilities = await notebook.api.capabilities(id);
  const state: RevisitSnapshot = { note: capabilities.note ?? workingNote(), question: capabilities.question?.state ?? null };
  let eventId = action === 'revisited' || action === 'keep_recurrent' ? ulid() : null;
  const result = await notebook.commit([{ op: 'revisit', id, base_revision: block.revision, action, next_on: nextOn, event_id: eventId }], 'Changed revisit', [block.page_id]);
  let revision = result.revisions.find(value => value.id === id)?.revision;
  if (revision === undefined) return;
  let applied = true;
  const travel = async (forward: boolean) => {
    if (applied === forward) return;
    const document = notebook.open(block.page_id);
    try { await document.flush(); } finally { document.release(); }
    const nextEventId = forward && (action === 'revisited' || action === 'keep_recurrent') ? ulid() : null;
    const committed = await notebook.commit([forward
      ? { op: 'revisit', id, base_revision: revision!, action, next_on: nextOn, event_id: nextEventId }
      : { op: 'restore_revisit', id, base_revision: revision!, state, event_id: eventId }],
    forward ? 'Redid revisit' : 'Undid revisit', [block.page_id]);
    revision = committed.revisions.find(value => value.id === id)?.revision ?? revision;
    if (forward) eventId = nextEventId;
    applied = forward;
  };
  return { undo: () => travel(false), redo: () => travel(true) };
}

export function revisitKind(row: RevisitRow): string {
  return row.question_status === 'unsettled' ? 'Recurrent question' : row.question_status ? `${row.question_status.charAt(0).toUpperCase()}${row.question_status.slice(1)} question` : row.note.resolved_at ? 'Resolved note' : 'Note';
}
