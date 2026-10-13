import { ulid } from 'ulid';
import { ApiError } from '../api/client';
import type { Operation, PageView } from '../api/types';
import type { CaptureIntent, NotebookClient } from '../document/contract';
import { titleTargets, typedTitles, withLinkedTitles } from '../outline/link-titles';
import { foldName } from '../outline/names';

/** Resolves a durable capture into one batch, including any new journal or reference targets. */
export async function captureOperations(notebook: NotebookClient, capture: CaptureIntent): Promise<{ operations: Operation[]; pageId: string }> {
  const operations: Operation[] = [];
  const picked = new Map(capture.picked);
  const titles = typedTitles(capture.text).filter(title => !picked.has(foldName(title)));
  const targets = new Map([...picked, ...await titleTargets(notebook, titles, async title => {
    const id = ulid();
    operations.push({ op: 'create_page', id, title });
    operations.push({ op: 'insert', id: ulid(), parent_id: id, after: null, text: '', heading: null });
    return id;
  })]);
  const text = targets.size ? withLinkedTitles(capture.text, targets) : capture.text;
  let pageId: string;
  let page: PageView | undefined;
  try {
    pageId = (await notebook.api.journal(capture.date)).id;
    page = await notebook.api.page(pageId);
  } catch (reason) {
    if (!(reason instanceof ApiError) || reason.status !== 404) throw reason;
    pageId = ulid();
    operations.push({ op: 'create_journal', id: pageId, date: capture.date });
  }
  const last = page?.rows.filter(row => row.block.parent_id === pageId).at(-1)?.block;
  const reuse = last && !last.text && !page?.capabilities?.find(value => value.block_id === last.id)?.task
    && !page?.rows.some(row => row.block.parent_id === last.id) ? last : null;
  const id = reuse?.id ?? ulid();
  if (reuse) operations.push({ op: 'edit_text', id, base_revision: reuse.revision, text });
  else operations.push({ op: 'insert', id, parent_id: pageId, after: last?.id ?? null, text, heading: null });
  if (capture.task) operations.push({ op: 'set_task', id, base_revision: reuse ? reuse.revision + 1 : 1, task: capture.task });
  return { operations, pageId };
}
