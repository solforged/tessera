import { Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { Menu } from '../ui/Menu';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';


export function TypePill(props: {
  title: string;
  notebook: NotebookClient;
  onOpen?(target: OpenTarget, beside: boolean): void;
  onRemove?(): void;
  start?: number;
  end?: number;
  children?: JSX.Element;
}) {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const open = async () => {
    const id = await props.notebook.pageByTitle(props.title, false);
    if (id) props.onOpen?.({ kind: 'table', typeId: id, viewId: null, query: { type: id, text: null, filters: [], sort: [], limit: null } }, true);
  };
  return <>
    <button type="button" class="outline-tag" data-source-start={props.start} data-source-end={props.end}
      onClick={event => { event.stopPropagation(); setAnchor(event.currentTarget); }}>{props.children ?? `#${props.title}`}</button>
    <Show when={anchor()}>{element => <Menu anchor={element()} label={`#${props.title}`} onDismiss={() => setAnchor(null)} items={[
      { label: 'Open table', action: () => void open() },
      { label: 'Remove type', disabledReason: props.onRemove ? undefined : 'From the text. Edit the #tag there to remove it.', action: () => props.onRemove?.() },
    ]} />}</Show>
  </>;
}
