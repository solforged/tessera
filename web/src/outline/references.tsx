import { Show, createMemo, createResource, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { Menu } from '../ui/Menu';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import type { NoteIndex } from '../api/types';
import { noteKindIcon } from '../notes/kinds';
import { Icon } from '../ui/Icon';

// Rows in one change frame share the registry read, including the editor's widgets.
const registryReads = new WeakMap<NotebookClient, { sequence: number; promise: Promise<NoteIndex> }>();
export function readTagRegistry(notebook: NotebookClient): Promise<NoteIndex> {
  const sequence = notebook.changeSequence();
  const cached = registryReads.get(notebook);
  if (cached?.sequence === sequence) return cached.promise;
  const promise = notebook.api.noteIndex();
  registryReads.set(notebook, { sequence, promise });
  return promise;
}

export function TypePill(props: {
  title: string;
  notebook: NotebookClient;
  onOpen?(target: OpenTarget, beside: boolean): void;
  onRemove?(): void;
  onRestoreFocus?(): void;
  start?: number;
  end?: number;
  interactive?: boolean;
  children?: JSX.Element;
}) {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const [registry] = createResource(() => [props.notebook.changeSequence(), props.notebook.connection()] as const, () => readTagRegistry(props.notebook));
  const kind = createMemo(() => registry.error ? undefined : registry()?.kinds.find(kind => kind.tag && kind.name.toLocaleLowerCase() === props.title.trim().toLocaleLowerCase()));
  const label = () => <><Show when={kind()}>{value => <Icon name={noteKindIcon(value())} />}</Show>{props.children ?? `#${props.title}`}</>;
  const open = async (kind: 'table' | 'page') => {
    const id = await props.notebook.pageByTitle(props.title, false);
    if (id) props.onOpen?.(kind === 'page' ? { kind: 'page', pageId: id } : { kind: 'table', typeId: id, viewId: null, query: { type: id, text: null, filters: [], sort: [], limit: null } }, true);
  };
  return <>
    <Show when={props.interactive !== false} fallback={<span class="outline-tag" data-source-start={props.start} data-source-end={props.end}>{label()}</span>}>
      <button type="button" class="outline-tag" data-source-start={props.start} data-source-end={props.end}
        onClick={event => { event.stopPropagation(); setAnchor(event.currentTarget); }}>{label()}</button>
    </Show>
    <Show when={anchor()}>{element => <Menu anchor={element()} label={`#${props.title}`} onDismiss={() => { setAnchor(null); props.onRestoreFocus?.(); }} items={[
      { label: 'Open table', action: () => void open('table') },
      { label: 'Open tag', action: () => void open('page') },
      { label: 'Remove tag', disabledReason: props.onRemove ? undefined : 'From the text. Edit the #tag there to remove it.', action: () => props.onRemove?.() },
    ]} />}</Show>
  </>;
}
