import type { TaskState } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { TitleTargets } from '../outline/link-titles';
import { titleTargets, typedTitles, withLinkedTitles } from '../outline/link-titles';
import { foldName } from '../outline/names';
import { documentReady } from '../tasks/JournalAgenda';

/**
 * Appends one block to the end of today's journal, reusing a trailing empty block, and returns its ID. Hand-typed
 * `[[Title]]` names link as they would on leaving the block, except names already `picked` from a completion;
 * `task` makes the block a task with that plan.
 */
export async function appendToToday(notebook: NotebookClient, text: string, task: TaskState | null, picked: TitleTargets = new Map()): Promise<string> {
  const titles = typedTitles(text).filter(title => !picked.has(foldName(title)));
  const targets = new Map([...picked, ...titles.length ? await titleTargets(notebook, titles) : []]);
  const body = targets.size ? withLinkedTitles(text, targets) : text;
  const pageId = await notebook.journal(notebook.todayDate());
  const doc = notebook.open(pageId);
  try {
    await documentReady(doc);
    const last = doc.outline.children(pageId).at(-1);
    const reuse = last && !doc.block(last)?.text && !doc.block(last)?.task && !doc.outline.children(last).length ? last : null;
    let id = reuse;
    if (!id) {
      const inserted = doc.edit({ kind: 'insert', parentId: pageId, after: last ?? null });
      if (!inserted.ok) throw new Error(inserted.reason);
      id = inserted.created[0]!;
    }
    const written = task ? doc.edit({ kind: 'planTask', id, text: body, value: task }) : doc.edit({ kind: 'text', id, text: body });
    if (!written.ok) throw new Error(written.reason);
    await doc.flush();
    return id;
  } finally { doc.release(); }
}
