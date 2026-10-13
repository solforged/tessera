import type { Citation, HighlightRow, IngestJob, LibraryQuery, LibraryRow, Operation, ReadingState } from '../api/types';
import type { LibraryGroup, LibraryViewState } from '../shell/contract';
import { formatSourceValue } from '../outline/source';
import type { HighlightSection } from './highlights';
import { referenceValue } from '../outline/names';

export function libraryQuery(view: Pick<LibraryViewState, 'tab' | 'text' | 'sort' | 'filters' | 'collection'>): LibraryQuery {
  return {
    states: view.tab === 'all' || view.tab === 'highlights' || view.tab === 'collections' ? [] : [view.tab],
    collection_id: view.collection ?? null,
    text: view.text.trim() || null,
    sort: view.sort,
    direction: view.sort === 'title' || view.sort === 'author' ? 'asc' : 'desc',
    ...view.filters,
  };
}

export interface SourceGroup { key: string; label: string; personId: string | null; rows: LibraryRow[] }

const missingGroup: Record<Exclude<LibraryGroup, 'none'>, string> = { author: 'No author', decade: 'Undated', publisher: 'No publisher', language: 'No language' };

/**
 * Splits rows into groups, keeping each group's rows in their listed order. A source belongs to one group: by its
 * first author (else editor), its decade, publisher or language. Authors run A–Z by family name, decades newest
 * first, publishers and languages A–Z; sources without a value come last.
 */
export function groupSources(rows: readonly LibraryRow[], group: Exclude<LibraryGroup, 'none'>): SourceGroup[] {
  const groups = new Map<string, SourceGroup & { order: string | number }>();
  for (const row of rows) {
    const person = row.people.find(value => value.role === 'author') ?? row.people.find(value => value.role === 'editor');
    const name = person && referenceValue(person.name).name;
    const year = Number(row.published?.slice(0, 4));
    const value = group === 'author' ? person && name && { key: person.id ?? `name:${name}`, label: name, personId: person.id, order: (name.includes(',') ? name.split(',')[0]! : name.split(/\s+/).at(-1)!) + ' ' + name }
      : group === 'decade' ? (year > 0 ? { key: String(year - year % 10), label: `${year - year % 10}s`, personId: null, order: -(year - year % 10) } : undefined)
        : group === 'publisher' ? row.publisher && { key: row.publisher, label: row.publisher, personId: null, order: row.publisher }
          : row.language && { key: row.language, label: formatSourceValue('language', row.language), personId: null, order: formatSourceValue('language', row.language) };
    const entry = value || { key: '', label: missingGroup[group], personId: null, order: '' };
    let existing = groups.get(entry.key);
    if (!existing) { existing = { ...entry, rows: [] }; groups.set(entry.key, existing); }
    existing.rows.push(row);
  }
  return [...groups.values()]
    .sort((a, b) => (a.key === '') !== (b.key === '') ? (a.key === '' ? 1 : -1)
      : typeof a.order === 'number' && typeof b.order === 'number' ? a.order - b.order
        : String(a.order).localeCompare(String(b.order), undefined, { sensitivity: 'base' }))
    .map(({ order: _, ...value }) => value);
}

export function sourceStateOperation(row: LibraryRow, state: ReadingState): Operation {
  const { format, origin, match_key, citation_key } = row.source;
  return {
    op: 'set_source', id: row.page.id, base_revision: row.page.revision,
    source: { format, origin, match_key, citation_key, state },
  };
}

export function sourceByline(row: Pick<LibraryRow, 'creators' | 'site' | 'published'>): string {
  return row.creators.map(value => referenceValue(value).name).join(', ') || row.site || '';
}

/** Whole percent, rounded down so a source never reads 100% before its last passage; a started source never reads as 0%. */
export function formatProgress(progress: number): string {
  return progress > 0 && progress < 0.01 ? '<1%' : `${Math.floor(progress * 100)}%`;
}

export function highlightEmptyMessage(total: number | undefined, unprocessedOnly: boolean): string {
  if (total === 0) return 'Select text in the reader to add highlights.';
  return unprocessedOnly ? 'No unprocessed highlights.' : 'No matching highlights.';
}

export function highlightLocation(citation: Pick<Citation, 'ordinal' | 'chapter_title'>, sections: readonly HighlightSection[]): string {
  if (citation.chapter_title) return citation.chapter_title;
  for (let index = sections.length - 1; index >= 0; index--) {
    if (sections[index]!.ordinal <= citation.ordinal) return sections[index]!.title;
  }
  return `¶${citation.ordinal + 1}`;
}

/** The passage and the notebook date; the chapter is the heading the highlight sits under. */
export function highlightMeta(row: Pick<HighlightRow, 'citation' | 'created_at'>, timeZone: string): string {
  // Civil dates read as ISO everywhere the apparatus shows them, like journal titles and task plans.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(row.created_at);
  return `¶${row.citation.ordinal + 1} · ${date}`;
}

export interface HighlightChapter { title: string | null; rows: HighlightRow[] }

/** One source's highlights in reading order, split where the chapter changes; highlights before the first contents entry form an untitled run. */
export function highlightChapters(rows: readonly HighlightRow[]): HighlightChapter[] {
  const chapters: HighlightChapter[] = [];
  for (const row of [...rows].sort((a, b) => a.citation.ordinal - b.citation.ordinal || a.citation.start.offset - b.citation.start.offset)) {
    const title = row.citation.chapter_title ?? null;
    const last = chapters.at(-1);
    if (last?.title === title) last.rows.push(row);
    else chapters.push({ title, rows: [row] });
  }
  return chapters;
}

/** A highlighted contents heading already supplies its chapter's label. */
export function highlightChapterHeading(chapter: HighlightChapter): string | null {
  const first = chapter.rows[0];
  return first?.citation.quote.trim() === chapter.title?.trim() ? null : chapter.title;
}

/** Move forward through the current reading-order queue, wrapping only to find an unprocessed item. */
export function nextUnprocessedHighlight(rows: readonly HighlightRow[], id: string): string | null {
  const index = rows.findIndex(row => row.citation.id === id);
  if (index < 0) return rows.find(row => !row.processed)?.citation.id ?? null;
  for (let step = 1; step < rows.length; step++) {
    const row = rows[(index + step) % rows.length]!;
    if (!row.processed && row.citation.id !== id) return row.citation.id;
  }
  return null;
}

export function recentJobs(jobs: readonly IngestJob[], now: number): IngestJob[] {
  return jobs.filter(job => job.state !== 'done' || job.created_at >= now - 24 * 60 * 60 * 1000);
}

/** A completed job leaves once its source is in the notebook; the source's own row says the rest. */
export function visibleJobs(jobs: readonly IngestJob[], sourceIds: ReadonlySet<string>): IngestJob[] {
  return jobs.filter(job => job.state !== 'done' || !job.source_id || !sourceIds.has(job.source_id));
}

/** Keep a failed URL's host and final identifier, not just its shared prefix. */
export function importJobName(name: string): string {
  try {
    const url = new URL(name);
    if (!['http:', 'https:'].includes(url.protocol)) return name;
    const path = url.pathname.replace(/\/$/, '');
    const tail = path.slice(path.lastIndexOf('/') + 1);
    const identifier = url.hostname === 'doi.org' || url.hostname === 'dx.doi.org' ? path.slice(1) : tail;
    const label = `${url.host}/${identifier !== path.slice(1) ? '…/' : ''}${identifier || url.search}`;
    return label.length > 60 ? `${url.host}/…${(identifier || url.search).slice(-36)}` : label;
  } catch {
    return name;
  }
}

export function jobLabel(job: IngestJob, titles: ReadonlyMap<string, string>): { name: string; state: string; attempt: string | null } {
  return {
    name: (job.state === 'done' ? titles.get(job.source_id ?? '') ?? job.name : job.name).replace(/\.epub$/i, ''),
    state: job.state === 'done' ? 'Added' : job.state[0]!.toUpperCase() + job.state.slice(1),
    attempt: job.attempts > 1 ? `attempt ${job.attempts}` : null,
  };
}

export function retryTime(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp);
}

export function selectSources(ids: readonly string[], selected: ReadonlySet<string>, id: string, anchor: string | null, range: boolean): Set<string> {
  const next = new Set(selected);
  const start = anchor === null ? -1 : ids.indexOf(anchor), end = ids.indexOf(id);
  const targets = range && start >= 0 && end >= 0 ? ids.slice(Math.min(start, end), Math.max(start, end) + 1) : [id];
  const checked = !selected.has(id);
  for (const target of targets) { if (checked) next.add(target); else next.delete(target); }
  return next;
}
