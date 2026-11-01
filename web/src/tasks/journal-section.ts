import type { Block } from '../api/types';
import { foldName } from '../outline/names';
import { writtenSections } from './today-template';
import type { TodayTemplate } from './today-template';

/**
 * The journal section a block sits in, read as Today's layout reads it: the root heading above it that names a written
 * section, else Notes, which is every row outside those headings and is drawn on today. Other days with no such heading
 * are one outline, so the block is outside any section (`null`). `undefined` while an ancestor is still loading.
 */
export function journalSectionName(block: Block, page: Block, template: TodayTemplate, parent: (id: string) => Block | null | undefined, today: string): string | null | undefined {
  let root = block;
  for (let depth = 0; root.parent_id && root.parent_id !== page.id; depth++) {
    const above = depth < 64 ? parent(root.parent_id) : null;
    if (above === undefined) return undefined;
    if (above === null) return null;
    root = above;
  }
  const heading = root.heading ? writtenSections(template).find(section => foldName(section.name) === foldName(root.text)) : undefined;
  if (heading) return heading.name;
  return page.text === today ? template.sections.find(section => section.id === 'notes')?.name ?? 'Notes' : null;
}
