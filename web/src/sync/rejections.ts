import { ulid } from 'ulid';
import { ApiError } from '../api/client';
import type { Operation, RejectedChange } from '../api/types';
import type { NotebookClient } from '../document/contract';

/** Recovery and settling are one acknowledged batch, with one batch to undo them. */
export async function settleRejection(notebook: NotebookClient, change: RejectedChange, copy: boolean): Promise<{ undo(): Promise<void> }> {
  const operations: Operation[] = [];
  const inserted: string[] = [];
  let pageId = change.page_id;
  if (copy) {
    let newDay = false;
    if (!pageId) {
      const date = notebook.todayDate();
      pageId = notebook.roots().find(root => root.kind === 'journal' && root.text === date)?.id ?? null;
      if (!pageId) {
        try { pageId = (await notebook.api.journal(date)).id; }
        catch (reason) {
          if (!(reason instanceof ApiError) || reason.status !== 404) throw reason;
          pageId = ulid(); newDay = true;
          operations.push({ op: 'create_journal', id: pageId, date });
        }
      }
    }
    const page = newDay ? null : await notebook.api.page(pageId);
    let after = page?.rows.filter(row => row.block.parent_id === pageId).at(-1)?.block.id ?? null;
    for (const text of change.texts) {
      const id = ulid(); inserted.push(id);
      operations.push({ op: 'insert', id, parent_id: pageId, after, text, heading: null });
      after = id;
    }
  }
  operations.push({ op: 'settle_sync_rejection', id: change.id, settled: true });
  const receipt = await notebook.commit(operations, copy ? 'Copy rejected text back' : 'Dismiss rejected change', pageId ? [pageId] : []);
  const inverse: Operation[] = [{ op: 'settle_sync_rejection', id: change.id, settled: false }];
  // Only delete blocks this command created, never edits made later in the page.
  for (const id of inserted.reverse()) {
    const revision = receipt.revisions.find(row => row.id === id)?.revision;
    if (revision === undefined) throw new Error('The copied text has no revision receipt.');
    inverse.push({ op: 'delete', id, base_revision: revision });
  }
  return { undo: async () => { await notebook.commit(inverse, copy ? 'Undo copying rejected text' : 'Undo dismissing rejected change', pageId ? [pageId] : []); } };
}
