import { Show } from 'solid-js';
import type { LibraryRow } from '../api/types';
import { ResourceImage } from './ResourceImage';

/** Coverless sources keep only their siglum, with the title in the caption. */
export function SourceCover(props: { row: LibraryRow; siglum: string }) {
  return <span class="library-cover" data-source-cover={props.row.page.id}>
    <Show when={props.row.cover} fallback={<span class="library-spine" aria-hidden="true">
      <span class="library-spine-siglum">{props.siglum}</span>
    </span>}>
      <ResourceImage snapshotId={props.row.source.current_snapshot_id ?? ''} href={props.row.cover!} alt="" loading="lazy" />
    </Show>
  </span>;
}
