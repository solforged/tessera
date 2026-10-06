import type { DateRange, TaskQuery, TaskStatus } from '../api/types';
import { copyQuery, typeQuery } from '../table/query';
import { parseTaskDate } from './date-input';
import { createTaskQuery } from './query';

export interface TaskQueryLineContext {
  context_date: string;
  resolveType(title: string): string | null;
  typeTitle(id: string): string | null;
  resolveProject(title: string): string | null;
  projectTitle(id: string): string | null;
  /** Preserve field chips and source settings that the line does not edit. */
  baseQuery?: TaskQuery;
}
export interface TaskQueryLineError { term: string; message: string; start: number; end: number }
export interface TaskQueryLineTerm { term: string; start: number; end: number; error?: string }
const statuses: Record<TaskStatus, true> = { todo: true, doing: true, waiting: true, done: true, cancelled: true };

/** Keep source offsets, quoted date fragments and wiki titles together. */
export function taskQueryLineTerms(text: string): TaskQueryLineTerm[] {
  const terms: TaskQueryLineTerm[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index]!)) { index++; continue; }
    const start = index;
    let quoted = false;
    let reference = false;
    while (index < text.length) {
      const char = text[index]!;
      if (char === '\\') { index += Math.min(2, text.length - index); continue; }
      if (!quoted && !reference && text.startsWith('[[', index)) { reference = true; index += 2; continue; }
      if (reference && text.startsWith(']]', index)) { reference = false; index += 2; continue; }
      if (!reference && char === '"') quoted = !quoted;
      if (!quoted && !reference && /\s/.test(char)) break;
      index++;
    }
    terms.push({ term: text.slice(start, index), start, end: index, ...(quoted || reference ? { error: quoted ? 'Close the double quote.' : 'Close the title with ]].' } : {}) });
  }
  return terms;
}

function unquote(text: string): string {
  let value = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '\\' && index + 1 < text.length) {
      const next = text[++index]!;
      value += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
    } else if (char !== '"') value += char;
  }
  return value;
}
const titleValue = (text: string) => text.slice(2, -2).replace(/\\([\\\[\]"])/g, '$1');
const titleTerm = (title: string) => `[[${title.replace(/[\\\[\]]/g, '\\$&')}]]`;

function parseRange(text: string, contextDate: string): { range: DateRange | null; error?: string } {
  const edges = text.split('..');
  if (edges.length > 2 || !edges.some(edge => edge.trim())) return { range: null, error: 'Enter a date or a range with at least one date.' };
  const dates: (string | null)[] = [];
  for (const edge of edges) {
    if (!edge.trim()) { dates.push(null); continue; }
    const parsed = parseTaskDate(edge, contextDate);
    if (!parsed.ok) return { range: null, error: parsed.error };
    if (!parsed.date) return { range: null, error: 'Enter a date for the range.' };
    dates.push(parsed.date);
  }
  const range = { from: dates[0]!, through: edges.length === 1 ? dates[0]! : dates[1]! };
  if (range.from && range.through && range.from > range.through) return { range: null, error: 'The range must end on or after its start.' };
  return { range };
}

/** Parse synchronously from the pane's title caches; invalid terms never become source text. */
export function parseTaskQueryLine(text: string, ctx: TaskQueryLineContext): { query: TaskQuery; errors: TaskQueryLineError[] } {
  const query = createTaskQuery(ctx.context_date);
  const source = ctx.baseQuery?.source ? copyQuery(ctx.baseQuery.source) : typeQuery(null);
  source.type = null; source.text = null;
  const words: string[] = [];
  const errors: TaskQueryLineError[] = [];
  for (const item of taskQueryLineTerms(text)) {
    const fail = (message: string) => errors.push({ term: item.term, start: item.start, end: item.end, message });
    if (item.error) { fail(item.error); continue; }
    const raw = item.term;
    // A fully quoted term is text even when it looks like a predicate.
    if (raw.startsWith('"')) { words.push(unquote(raw)); continue; }
    const term = unquote(raw);
    if (term.startsWith('is:')) {
      const values = term.slice(3).split(',');
      if (values.some(value => !Object.hasOwn(statuses, value))) fail('Use todo, doing, waiting, done or cancelled after is:.');
      else query.filter.statuses = [...new Set(values as TaskStatus[])];
    } else if (term.startsWith('show:')) {
      const value = term.slice(5);
      if (value === 'open' || value === 'all') {
        query.filter.selection = value === 'open' ? 'unfinished' : 'all';
        query.filter.recent_days = ctx.baseQuery?.filter.recent_days ?? 7;
      }
      else if (value === 'recent' || value.startsWith('recent:')) {
        const days = value === 'recent' ? 7 : Number(value.slice(7));
        if (!/^recent(?::\d+)?$/.test(value) || !Number.isInteger(days) || days < 1 || days > 3660) fail('Use show:recent with 1 to 3660 days.');
        else { query.filter.selection = 'unfinished_or_recent'; query.filter.recent_days = days; }
      } else fail('Use show:open, show:recent:7 or show:all.');
    } else if (term.startsWith('priority:')) {
      const value = term.slice(9);
      if (value === 'high' || value === 'medium' || value === 'low') query.filter.priority = value;
      else fail('Use high, medium or low after priority:.');
    } else if (raw.startsWith('#')) {
      const value = raw.slice(1);
      const title = value.startsWith('[[') && value.endsWith(']]') ? titleValue(value) : unquote(value);
      const id = title ? ctx.resolveType(title) : null;
      if (!id) fail(`Unknown type: ${title || '(empty)'}.`);
      else source.type = id;
    } else if (raw.startsWith('[[')) {
      if (!raw.endsWith(']]')) { fail('Use [[Project title]] for a project.'); continue; }
      const title = titleValue(raw);
      const id = ctx.resolveProject(title);
      if (!id) fail(`Unknown project: ${title || '(empty)'}.`);
      else query.filter.project_id = id;
    } else if (term.startsWith('@') || term.startsWith('by:') || term.startsWith('due:')) {
      const scheduled = term.startsWith('@');
      const result = parseRange(term.slice(scheduled ? 1 : term.startsWith('by:') ? 3 : 4), ctx.context_date);
      if (result.error) fail(result.error);
      else query.filter[scheduled ? 'scheduled' : 'deadline'] = result.range;
    } else if (term.startsWith('limit:')) {
      const value = term.slice(6); const limit = Number(value);
      if (!/^\d+$/.test(value) || !Number.isInteger(limit) || limit < 1 || limit > 2000) fail('Use a result limit from 1 to 2000.');
      else query.limit = limit;
    } else words.push(term);
  }
  source.text = words.length ? words.join(' ') : null;
  query.source = source.type || source.text || source.filters.length || source.sort.length || source.limit !== null ? source : null;
  return { query, errors };
}

const formatRange = (range: DateRange) => range.from && range.from === range.through ? range.from : `${range.from ?? ''}..${range.through ?? ''}`;

/** Canonical absolute dates keep pane history and named views independent of when they are reopened. */
export function formatTaskQueryLine(query: TaskQuery, ctx: TaskQueryLineContext): string {
  const terms: string[] = [];
  if (query.filter.statuses.length) terms.push(`is:${query.filter.statuses.join(',')}`);
  if (query.filter.selection === 'unfinished') terms.push('show:open');
  else if (query.filter.selection === 'all') terms.push('show:all');
  else if (query.filter.recent_days !== 7) terms.push(`show:recent:${query.filter.recent_days}`);
  if (query.filter.priority) terms.push(`priority:${query.filter.priority}`);
  if (query.source?.type) {
    const title = ctx.typeTitle(query.source.type) ?? query.source.type;
    terms.push(/[\[\]"\\\s]/.test(title) ? `#${titleTerm(title)}` : `#${title}`);
  }
  if (query.filter.project_id) terms.push(titleTerm(ctx.projectTitle(query.filter.project_id) ?? query.filter.project_id));
  if (query.filter.scheduled) terms.push(`@${formatRange(query.filter.scheduled)}`);
  if (query.filter.deadline) terms.push(`by:${formatRange(query.filter.deadline)}`);
  if (query.limit !== null) terms.push(`limit:${query.limit}`);
  if (query.source?.text) {
    const text = query.source.text;
    terms.push(/\s|["\\]/.test(text) || /^(?:is:|show:|priority:|by:|due:|limit:|#|@|\[\[)/.test(text) ? JSON.stringify(text) : text);
  }
  return terms.join(' ');
}
