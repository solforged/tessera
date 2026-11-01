import type { Block } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { displayTitle, readableText } from './names';

/** Where a block sits: its root's tagless title, then its ancestors as a reader sees them. A descriptor card already names its parent, so it can omit it. */
export function blockTrail(block: Block, lookup: NotebookClient['lookup'], omitParent = false): string {
  if (block.kind !== 'block') return displayTitle(block.text, lookup) || (block.kind === 'journal' ? 'Journal' : 'Untitled atom');
  const ancestors: string[] = [];
  const seen = new Set<string>();
  let parent = block.parent_id;
  while (parent && parent !== block.page_id && !seen.has(parent)) {
    seen.add(parent);
    const ancestor = lookup(parent)();
    if (!ancestor) break;
    ancestors.unshift(readableText(ancestor.text, lookup) || 'Empty atom');
    parent = ancestor.parent_id;
  }
  const page = lookup(block.page_id)();
  const segments = [page ? displayTitle(page.text, lookup) || 'Untitled atom' : 'Loading atom…', ...ancestors];
  // Keep the page title when it is the parent: the source button needs a label.
  if (omitParent && segments.length > 1) segments.pop();
  return segments.join(' › ');
}
