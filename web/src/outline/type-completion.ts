import type { Block } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { completeNames, foldName } from './names';
import { cardMarks, parseCardText } from '../review/card-text';
import { matchFieldEntry } from '../table/query';
import { insideProtectedSyntax } from '../tasks/quick-date';

export interface TypeToken { from: number; to: number; query: string }

/** A type query starts at a whitespace boundary; a bare hash still belongs to heading syntax. */
export function typeTokenAt(text: string, caret: number): TypeToken | null {
  if (caret <= 0 || caret > text.length || text.startsWith('::') || matchFieldEntry(text)) return null;
  const from = text.lastIndexOf('#', caret - 1);
  if (from < 0 || from > 0 && !/\s/.test(text[from - 1]!) || insideProtectedSyntax(text, from)) return null;
  for (let open = text.indexOf('(('); open >= 0 && open < from; open = text.indexOf('((', open + 2)) {
    if (insideProtectedSyntax(text, open)) continue;
    let escapes = 0;
    for (let cursor = open - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) escapes++;
    if (escapes % 2) continue;
    const close = text.indexOf('))', open + 2);
    if (close < 0 || from < close + 2) return null;
    open = close;
  }
  const stops = /[\s#[\]`\\{}:]/u;
  const typed = text.slice(from + 1, caret);
  if (!typed || stops.test(typed)) return null;
  // A caret moved back into `#philo` still searches, and a choice replaces, the whole word.
  let to = caret;
  while (to < text.length && !stops.test(text[to]!)) to++;
  // A card block takes tags like any other; a cloze shields only its own span, including unfinished syntax.
  if (cardMarks(text).some(mark => mark.kind === 'cloze' && from >= mark.start && from < mark.end)) return null;
  if (parseCardText(text).problems.some(problem => from >= problem.start && from < problem.end)) return null;
  return { from, to, query: text.slice(from + 1, to) };
}

/** A type picker row: a page used as a type, or a built-in tag whose page the first use will make. */
export type TypeMatch = Block & { alias: string | null; icon: string | null };

/**
 * Pages used as types, then built-in tags that have no page yet; prose matches can never become tag spellings.
 * Every row carries its registry icon; a built-in without a page has an empty id and is chosen by title alone.
 */
export async function completeTypes(notebook: NotebookClient, query: string): Promise<{ rows: TypeMatch[]; canCreate: boolean }> {
  const [types, index] = await Promise.all([notebook.api.types(), notebook.api.noteIndex()]);
  const icons = new Map(index.kinds.filter(kind => kind.type_id).map(kind => [kind.type_id!, kind.icon]));
  const result = await completeNames(notebook, query, types.map(type => type.page));
  const key = foldName(query);
  const absent = index.kinds.filter(kind => kind.tag && !kind.type_id && (!key || foldName(kind.name).startsWith(key)) && !result.rows.some(({ page }) => foldName(page.text) === foldName(kind.name)));
  return {
    rows: [
      ...result.rows.map(({ page, alias }) => ({ ...page, alias, icon: icons.get(page.id) ?? null })),
      ...absent.map((kind): TypeMatch => ({ id: '', kind: 'page', parent_id: null, page_id: '', text: kind.name, heading: null, archived: false, revision: 0, created_at: 0, updated_at: 0, alias: null, icon: kind.icon })),
    ],
    canCreate: result.canCreate && !absent.some(kind => foldName(kind.name) === key),
  };
}

/** Match the inline tag grammar; titles containing spaces or punctuation use the bracketed spelling. */
export function typeSpelling(title: string): string {
  return /^[\p{L}\p{M}\p{N}_/-]+$/u.test(title) ? `#${title}` : `#[[${title}]]`;
}

/** A typed tag that already names the chosen type keeps the writer's spelling; only a different title replaces it. */
export function typeChoiceSpelling(query: string, title: string): string {
  return typeSpelling(query.toLocaleLowerCase() === title.toLocaleLowerCase() ? query : title);
}
