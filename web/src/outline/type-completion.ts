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
  // Operators make the whole block a card; a cloze shields only its own span, including unfinished syntax.
  if (cardMarks(text).some(mark => mark.kind === 'operator' || from >= mark.start && from < mark.end)) return null;
  if (parseCardText(text).problems.some(problem => from >= problem.start && from < problem.end)) return null;
  return { from, to, query: text.slice(from + 1, to) };
}

/** Match the inline tag grammar; titles containing spaces or punctuation use the bracketed spelling. */
export function typeSpelling(title: string): string {
  return /^[\p{L}\p{N}_/-]+$/u.test(title) ? `#${title}` : `#[[${title}]]`;
}
