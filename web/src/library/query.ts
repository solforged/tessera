import type { Citation, HighlightRow, IngestJob, LibraryQuery, LibraryRow, Operation, ReadingState } from '../api/types';
import type { LibraryGroup, LibraryViewState } from '../shell/contract';
import { formatSourceValue } from '../outline/source';
import type { HighlightSection } from './highlights';

export function libraryQuery(view: Pick<LibraryViewState, 'tab' | 'text' | 'sort' | 'filters'>): LibraryQuery {
  return {
    states: view.tab === 'all' || view.tab === 'highlights' ? [] : [view.tab],
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
    const year = Number(row.published?.slice(0, 4));
    const value = group === 'author' ? person && { key: person.id ?? `name:${person.name}`, label: person.name, personId: person.id, order: (person.name.includes(',') ? person.name.split(',')[0]! : person.name.split(/\s+/).at(-1)!) + ' ' + person.name }
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
  return row.creators.join(', ') || row.site || '';
}

/** Whole percent, rounded down so a source never reads 100% before its last passage; a started source never reads as 0%. */
export function formatProgress(progress: number): string {
  return progress > 0 && progress < 0.01 ? '<1%' : `${Math.floor(progress * 100)}%`;
}

export function highlightLocation(citation: Pick<Citation, 'ordinal' | 'chapter_title'>, sections: readonly HighlightSection[]): string {
  if (citation.chapter_title) return citation.chapter_title;
  for (let index = sections.length - 1; index >= 0; index--) {
    if (sections[index]!.ordinal <= citation.ordinal) return sections[index]!.title;
  }
  return `¶${citation.ordinal + 1}`;
}

export function highlightMeta(row: Pick<HighlightRow, 'citation' | 'created_at'>, sections: readonly HighlightSection[], timeZone: string): string {
  // Civil dates read as ISO everywhere the apparatus shows them, like journal titles and task plans.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(row.created_at);
  const location = highlightLocation(row.citation, sections);
  const passage = `¶${row.citation.ordinal + 1}`;
  return `${location === passage ? passage : `${location} · ${passage}`} · ${date}`;
}

export function recentJobs(jobs: readonly IngestJob[], now: number): IngestJob[] {
  return jobs.filter(job => job.state !== 'done' || job.created_at >= now - 24 * 60 * 60 * 1000);
}

/** A completed job leaves once its source is in the notebook; the source's own row says the rest. */
export function visibleJobs(jobs: readonly IngestJob[], sourceIds: ReadonlySet<string>): IngestJob[] {
  return jobs.filter(job => job.state !== 'done' || !job.source_id || !sourceIds.has(job.source_id));
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
