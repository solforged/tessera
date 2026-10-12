import { ulid } from 'ulid';
import type { Block } from '../api/types';
import type { NotebookClient } from '../document/contract';

/** Target membership is read from the model, not inferred from a page's title. */
export async function instancePages(notebook: NotebookClient, targets: readonly string[]): Promise<Block[]> {
  if (!targets.length) return notebook.roots().filter(page => page.kind === 'page' && !page.archived);
  const pages = new Map<string, Block>();
  await Promise.all(targets.map(async type => {
    let offset = 0;
    while (true) {
      const result = await notebook.api.query({ type, text: null, filters: [], sort: [], limit: 2000, offset });
      for (const row of result.rows) {
        const page = row.block.block;
        if (page.kind === 'page' && !page.archived) pages.set(page.id, page);
      }
      offset += result.rows.length;
      if (!result.rows.length || offset >= result.total) break;
    }
  }));
  return [...pages.values()].sort((a, b) => a.text.localeCompare(b.text));
}

/** Creation and filing travel together, including when the picker is used offline. */
export async function createInstance(notebook: NotebookClient, title: string, typeTitle?: string): Promise<Block> {
  const id = ulid();
  await notebook.commit([
    { op: 'create_page', id, title: title.trim() },
    ...(typeTitle ? [{ op: 'add_type' as const, id, base_revision: 1, title: typeTitle }] : []),
  ], 'Create linked page');
  return notebook.api.block(id);
}
