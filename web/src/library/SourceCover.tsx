import { Show } from 'solid-js';
import type { LibraryRow } from '../api/types';
import { isPhone } from '../ui/phone';
import { ResourceImage } from './ResourceImage';
import { sourceByline } from './query';

/** One of the six type hues, picked from the title so a book keeps its colour wherever it appears. */
function hueOf(title: string) {
  let sum = 0;
  for (const character of title) sum = (sum * 31 + character.charCodeAt(0)) % 6;
  return `var(--type-${sum + 1})`;
}

/**
 * Coverless sources keep only their siglum, with the title in the caption. On a phone they get a generated cover instead:
 * the title in Piazzolla italic on a wash of one type hue, framed by a hairline, the author in small capitals below.
 */
export function SourceCover(props: { row: LibraryRow; siglum: string; title?: string }) {
  const surname = () => sourceByline(props.row).split(' · ')[0]!.trim().split(/\s+/).pop() ?? '';
  const title = () => props.title ?? props.row.page.text;
  return <span class="library-cover" classList={{ 'library-cover-generated': !props.row.cover && isPhone() }} data-source-cover={props.row.page.id} style={!props.row.cover && isPhone() ? { '--hue': hueOf(title()) } : undefined}>
    <Show when={props.row.cover} fallback={<Show when={isPhone()} fallback={<span class="library-spine" aria-hidden="true">
      <span class="library-spine-siglum">{props.siglum}</span>
    </span>}>
      <span class="library-cover-title" aria-hidden="true">{title()}</span>
      <span class="library-cover-author" aria-hidden="true">{surname()}</span>
    </Show>}>
      <ResourceImage snapshotId={props.row.source.current_snapshot_id ?? ''} href={props.row.cover!} alt="" loading="lazy" />
    </Show>
  </span>;
}
