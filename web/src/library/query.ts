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

export function sourceByline(row: Pick<LibraryRow, 'creators' | 'published'>): string {
  return [row.creators.join(', '), row.published?.slice(0, 4)].filter(Boolean).join(' · ');
}

/** Whole percent; a started source never reads as 0%. */
export function formatProgress(progress: number): string {
  return progress > 0 && progress < 0.01 ? '<1%' : `${Math.round(progress * 100)}%`;
}

export function highlightLocation(citation: Pick<Citation, 'ordinal'>, sections: readonly HighlightSection[]): string {
  for (let index = sections.length - 1; index >= 0; index--) {
    if (sections[index]!.ordinal <= citation.ordinal) return sections[index]!.title;
  }
  return `¶${citation.ordinal + 1}`;
}

export function highlightMeta(row: Pick<HighlightRow, 'citation' | 'created_at'>, sections: readonly HighlightSection[], timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'short', day: 'numeric' }).format(row.created_at);
  return `${highlightLocation(row.citation, sections)} · ${date}`;
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
    name: job.state === 'done' ? titles.get(job.source_id ?? '') ?? job.name : job.name,
    state: job.state === 'done' ? 'added' : job.state,
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
