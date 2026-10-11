import { For, Show } from 'solid-js';
import type { Citation } from '../api/types';
import type { Chapter } from './book-map';
import './book-map.css';

/**
 * The whole book as one rule of chapter segments sized by length, filled to the reading point, with highlights as
 * dots above it. `at` and each highlight's `at` are character offsets; chapters come from `bookChapters`.
 */
export function BookMap(props: { chapters: readonly Chapter[]; length: number; at: number; highlights?: readonly { at: number; color: Citation['color'] }[]; large?: boolean; label?: string }) {
  const share = (at: number) => `${(Math.min(1, Math.max(0, at / (props.length || 1))) * 100).toFixed(2)}%`;
  return <div class="book-map" classList={{ 'book-map-large': props.large }} role="img" aria-label={props.label ?? `${Math.round(props.at / (props.length || 1) * 100)}% read`}>
    <For each={props.chapters}>{chapter => <span class="book-map-chapter" style={{ flex: `${chapter.end - chapter.start} 1 0` }}>
      <i style={{ width: `${Math.min(100, Math.max(0, (props.at - chapter.start) / (chapter.end - chapter.start) * 100))}%` }} />
    </span>}</For>
    <Show when={props.highlights?.length}><For each={props.highlights}>{mark => <b class={`book-map-mark highlight-color-${mark.color ?? 'none'}`} style={{ left: share(mark.at) }} />}</For></Show>
    <b class="book-map-here" style={{ left: share(props.at) }} />
  </div>;
}
