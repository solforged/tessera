import { ulid } from 'ulid';
import { ApiError } from '../api/client';
import type { Operation, PageView } from '../api/types';
import type { CaptureIntent, NotebookClient } from '../document/contract';
import { titleTargets, typedTitles, withLinkedTitles } from '../outline/link-titles';
import { foldName } from '../outline/names';
import { findSectionHeading, sectionInsertAfter } from '../tasks/today-template';

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
  if (capture.targetPageId) {
    pageId = capture.targetPageId;
    page = await notebook.api.page(pageId);
  } else {
    try {
      pageId = (await notebook.api.journal(capture.date)).id;
      page = await notebook.api.page(pageId);
    } catch (reason) {
      if (!(reason instanceof ApiError) || reason.status !== 404) throw reason;
      pageId = ulid();
      operations.push({ op: 'create_journal', id: pageId, date: capture.date });
    }
  }
  // A Today section files the line as the heading's last child, writing a missing heading at its template place.
  let parentId = pageId;
  if (capture.section && !capture.targetPageId) {
    const roots = page?.rows.filter(row => row.block.parent_id === pageId && !row.block.archived).map(row => row.block) ?? [];
    const heading = findSectionHeading(roots, capture.section.name);
    if (heading) parentId = heading.id;
    else {
      parentId = ulid();
      operations.push({ op: 'insert', id: parentId, parent_id: pageId, after: sectionInsertAfter(roots, capture.section), text: capture.section.name, heading: 2 });
    }
  }
  const last = page?.rows.filter(row => row.block.parent_id === parentId).at(-1)?.block;
  const reuse = last && !last.text && !page?.capabilities?.some(value => value.block_id === last.id && (value.task || value.question || value.project || value.source))
    && !page?.rows.some(row => row.block.parent_id === last.id) ? last : null;
  const id = reuse?.id ?? ulid();
  if (reuse) operations.push({ op: 'edit_text', id, base_revision: reuse.revision, text });
  else operations.push({ op: 'insert', id, parent_id: parentId, after: last?.id ?? null, text, heading: null });
  if (capture.task) operations.push({ op: 'set_task', id, base_revision: reuse ? reuse.revision + 1 : 1, task: capture.task });
  if (capture.question) operations.push({ op: 'set_question', id, base_revision: (reuse ? reuse.revision + 1 : 1) + Number(!!capture.task), question: { unsettled: false, parked: false, accepted: null, review_on: null } });
  return { operations, pageId };
}
