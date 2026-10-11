import { For, Show } from 'solid-js';
import type { ApiClient } from '../api/client';
import type { Backlink, LibraryPerson, LibraryRow, ReadingState } from '../api/types';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { formatProgress } from './query';
import { SourceCover } from './SourceCover';

const roleLabels: Record<LibraryPerson['role'], string | null> = { author: null, editor: 'Editor', translator: 'Translator' };
const stateLabels: Record<ReadingState, string | null> = { inbox: null, reading: 'Reading', finished: 'Finished', abandoned: 'Abandoned' };

/**
 * A source names its authors, editors and translators in creator fields, each value a block holding only a link to
 * the person's page. Only a page with such backlinks asks the library for works. `creatorLinks` are the backlinks
 * the works account for, so they are not counted or listed again as references.
 */
export async function loadWorks(api: ApiClient, pageId: string, backlinks: readonly Backlink[]): Promise<{ rows: LibraryRow[]; creatorLinks: Set<string> }> {
  const linkOnly = (text: string) => text.trim() === `[[${pageId}]]` || text.trim().startsWith(`[[${pageId}|`);
  if (!backlinks.some(item => linkOnly(item.source.text))) return { rows: [], creatorLinks: new Set() };
  const { rows: listed } = await api.library({ people: [pageId], sort: 'year', direction: 'asc', limit: null });
  // Oldest first, undated works after the dated ones.
  const rows = [...listed.filter(row => row.published), ...listed.filter(row => !row.published)];
  const works = new Set(rows.map(row => row.page.id));
  return { rows, creatorLinks: new Set(backlinks.filter(item => works.has(item.page.id) && linkOnly(item.source.text)).map(item => item.source.id)) };
}

/** The sources a person wrote, edited or translated, as a small shelf on their page, oldest first. */
export function PersonWorks(props: { pageId: string; rows: LibraryRow[]; onOpen(target: OpenTarget, beside: boolean): void }) {
  return <section class="related-sections person-works" aria-label="Works">
    <h3 class="outline-highlights-label">Works <span>{props.rows.length}</span></h3>
    <div class="person-works-shelf" role="list"><For each={props.rows}>{row => {
      // A person can hold several roles on one source; the strongest one names it.
      const role = () => roleLabels[row.people.find(person => person.id === props.pageId)?.role ?? 'author'];
      const apparatus = () => [row.published?.slice(0, 4), role(), row.progress > 0 && row.source.state === 'reading' ? formatProgress(row.progress) : stateLabels[row.source.state]].filter(Boolean).join(' · ');
      return <div role="listitem"><Button class="person-work" onClick={event => props.onOpen({ kind: 'page', pageId: row.page.id }, event.shiftKey)}>
        <SourceCover row={row} siglum={row.source.siglum} />
        <span class="person-work-title">{row.page.text}</span>
        <Show when={apparatus()}><span class="person-work-apparatus">{apparatus()}</span></Show>
      </Button></div>;
    }}</For></div>
  </section>;
}
