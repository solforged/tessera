import type { Citation, HighlightRow, IngestJob, LibraryQuery, LibraryRow, Operation, ReadingState } from '../api/types';
import type { LibraryViewState } from '../shell/contract';
import type { HighlightSection } from './highlights';

export function libraryQuery(view: Pick<LibraryViewState, 'tab' | 'text' | 'sort'>): LibraryQuery {
  return {
    states: view.tab === 'all' || view.tab === 'highlights' ? [] : [view.tab],
    text: view.text.trim() || null,
    sort: view.sort,
    direction: view.sort === 'title' ? 'asc' : 'desc',
  };
}

export function sourceStateOperation(row: LibraryRow, state: ReadingState): Operation {
  const { format, origin, match_key, citation_key } = row.source;
  return {
    op: 'set_source', id: row.page.id, base_revision: row.page.revision,
    source: { format, origin, match_key, citation_key, state },
  };
}

export function sourceByline(row: Pick<LibraryRow, 'creators' | 'site' | 'published'>): string {
  return [row.creators.join(', ') || row.site, row.published?.slice(0, 4)].filter(Boolean).join(' · ');
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

/** Completed sources already present in this view do not need a second row. */
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
