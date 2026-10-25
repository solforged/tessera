import { ApiError } from '../api/client';
import type { Block, PageView } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { foldName } from '../outline/names';
import { readingRowSource, writtenSections } from '../tasks/today-template';
import type { TodayTemplate } from '../tasks/today-template';

/** Today's journal as the service has it, or null before anything is written there. */
export async function todayJournal(notebook: NotebookClient): Promise<PageView | null> {
  try {
    const { id } = await notebook.api.journal(notebook.todayDate());
    return await notebook.api.page(id);
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) return null;
    throw reason;
  }
}

/** The day's root headings for its written sections, heading id → section id; the first heading of each wins. */
function sectionHeadings(page: PageView, template: TodayTemplate): Map<string, string> {
  const byName = new Map(writtenSections(template).map(section => [foldName(section.name), section.id]));
  const headings = new Map<string, string>();
  const found = new Set<string>();
  for (const { block } of page.rows) {
    if (block.parent_id !== page.root.id || block.archived || !block.heading) continue;
    const section = byName.get(foldName(block.text));
    if (section && !found.has(section)) { found.add(section); headings.set(block.id, section); }
  }
  return headings;
}

/** Sources with a row under today's Reading, in outline order. */
export function readingSources(page: PageView, template: TodayTemplate): string[] {
  const reading = [...sectionHeadings(page, template)].find(([, section]) => section === 'reading')?.[0];
  if (!reading) return [];
  return page.rows.flatMap(({ block }) => {
    const source = block.parent_id === reading && !block.archived ? readingRowSource(block.text) : undefined;
    return source ? [source] : [];
  });
}

/** The newest lines written into today's sections, newest first; section headings and Reading's source rows are not lines. */
export function recentCaptures(page: PageView, template: TodayTemplate, limit = 3): Block[] {
  const headings = sectionHeadings(page, template);
  const blocks = new Map(page.rows.map(({ block }) => [block.id, block]));
  const inSection = (block: Block) => {
    for (let parent = block.parent_id; parent; parent = blocks.get(parent)?.parent_id ?? null) if (headings.has(parent)) return true;
    return false;
  };
  return page.rows.map(({ block }) => block)
    .filter(block => !block.archived && block.text.trim() && !headings.has(block.id) && !(readingRowSource(block.text) && headings.get(block.parent_id ?? '') === 'reading') && inSection(block))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}

/** A pasted address saved as a titled link, when the page's title is known. */
export function titledLink(url: string, title: string | null): string {
  return title ? `[${title.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()}](${url})` : url;
}
