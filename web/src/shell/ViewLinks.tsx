import { For } from 'solid-js';
import type { View } from '../api/types';
import { Button } from '../ui/Button';
import { opensBeside } from '../core/beside';

export function ViewLinks(props: {
  views: View[];
  pinned: boolean;
  activeId?: string;
  onOpen(view: View, beside: boolean): void;
  onPin(id: string): void;
}) {
  return (
    <For each={props.views}>
      {view => (
        <div class="sidebar-view">
          <Button
            class={`view-link ${view.id === props.activeId ? 'selected' : ''}`}
            icon="table"
            title={view.name}
            onClick={event => props.onOpen(view, opensBeside(event))}
          >
            <span>{view.name}</span>
          </Button>
          <Button
            class="view-pin"
            icon="pin"
            label={`${props.pinned ? 'Unpin' : 'Pin'} view ${view.name}`}
            aria-pressed={props.pinned}
            onClick={() => props.onPin(view.id)}
          />
        </div>
      )}
    </For>
  );
}
