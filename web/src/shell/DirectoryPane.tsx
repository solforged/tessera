import { createEffect, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { DirectoryViewState } from '../core/contract';

export function DirectoryPane(props: {
  view: DirectoryViewState;
  atomCount?: number;
  ready: boolean;
  children: JSX.Element;
  onViewChange(view: DirectoryViewState): void;
}) {
  let root!: HTMLDivElement;
  let restored = false;
  const initialScroll = props.view.scroll;
  // Kinds and saved views arrive separately; restoring earlier would clamp the position to a short page.
  createEffect(() => {
    if (restored || !props.ready) return;
    const frame = requestAnimationFrame(() => {
      root.scrollTop = initialScroll;
      restored = true;
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  return (
    <div
      ref={root}
      class="directory-pane"
      tabIndex={-1}
      onScroll={event => {
        if (restored) props.onViewChange({ scroll: event.currentTarget.scrollTop });
      }}
    >
      <header class="directory-head">
        <p>
          {props.atomCount === undefined ? (
            'Loading…'
          ) : (
            <>
              <span class="fig">{props.atomCount.toLocaleString()}</span> {props.atomCount === 1 ? 'note' : 'notes'}
            </>
          )}
        </p>
        <h1>Index</h1>
      </header>
      {props.children}
    </div>
  );
}
