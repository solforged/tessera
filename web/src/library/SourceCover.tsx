import { Show } from 'solid-js';
import type { LibraryRow } from '../api/types';
import { ResourceImage } from './ResourceImage';

/** A source's cover, or for a source without one a typeset spine: its siglum in gilt over the title. */
export function SourceCover(props: { row: LibraryRow; siglum: string }) {
  return <span class="library-cover">
    <Show when={props.row.cover} fallback={<span class="library-spine" aria-hidden="true">
      <span class="library-spine-siglum">{props.siglum}</span>
      <span class="library-spine-title">{props.row.page.text}</span>
    </span>}>
      <ResourceImage snapshotId={props.row.source.current_snapshot_id ?? ''} href={props.row.cover!} alt="" loading="lazy" />
    </Show>
  </span>;
}
