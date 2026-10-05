import type { IngestJob, LibraryQuery, LibraryRow, Operation, ReadingState } from '../api/types';
import type { LibraryViewState } from '../shell/contract';

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

export function recentJobs(jobs: readonly IngestJob[], now: number): IngestJob[] {
  return jobs.filter(job => job.created_at >= now - 24 * 60 * 60 * 1000 && job.state !== 'done');
}
