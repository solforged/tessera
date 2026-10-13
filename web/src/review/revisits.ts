import { createEffect, createSignal, onCleanup } from 'solid-js';
import { ulid } from 'ulid';
import type { NoteState, RevisitAction, RevisitRow, RevisitSnapshot } from '../api/types';
import type { NotebookClient } from '../document/contract';

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

/** The same revision-checked inverse operation used by agent undo. */
export async function changeRevisit(notebook: NotebookClient, id: string, action: RevisitAction, nextOn: string | null) {
  let block = await notebook.api.block(id);
  const document = notebook.open(block.page_id);
  try { await document.flush(); } finally { document.release(); }
  block = await notebook.api.block(id);
  const capabilities = await notebook.api.capabilities(id);
  const state: RevisitSnapshot = { note: capabilities.note ?? workingNote(), question: capabilities.question?.state ?? null };
  const eventId = action === 'revisited' || action === 'keep_recurrent' ? ulid() : null;
  const result = await notebook.commit([{ op: 'revisit', id, base_revision: block.revision, action, next_on: nextOn, event_id: eventId }], 'Changed revisit', [block.page_id]);
  const revision = result.revisions.find(value => value.id === id)?.revision;
  return async () => {
    if (revision === undefined) return;
    await notebook.commit([{ op: 'restore_revisit', id, base_revision: revision, state, event_id: eventId }], 'Undid revisit', [block.page_id]);
  };
}

export function revisitKind(row: RevisitRow): string {
  return row.question_status === 'unsettled' ? 'Recurrent question' : row.question_status ? `${row.question_status.charAt(0).toUpperCase()}${row.question_status.slice(1)} question` : row.note.resolved_at ? 'Resolved note' : 'Note';
}
