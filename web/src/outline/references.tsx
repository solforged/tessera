import { Show, createMemo, createResource, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { Menu } from '../ui/Menu';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import type { NoteIndex } from '../api/types';
import { noteKindIcon } from '../notes/kinds';
import { Icon } from '../ui/Icon';
import { isPhone } from '../ui/phone';
import { typeHue } from './pill-hue';

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
  id?: string;
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
  const target = () => props.id ? props.notebook.lookup(props.id)() : undefined;
  const title = () => target()?.text || props.title || props.id || '';
  const unresolved = () => !!props.id && target() === null;
  const kind = createMemo(() => registry.error ? undefined : registry()?.kinds.find(kind => kind.tag && (props.id ? kind.type_id === props.id : kind.name.toLocaleLowerCase() === title().trim().toLocaleLowerCase())));
  // A phone's pill is the name in a hue of its own: no # and no kind glyph.
  const phone = isPhone();
  const label = () => <><Show when={!phone && kind()}>{value => <Icon name={noteKindIcon(value())} />}</Show>{props.children ?? `${phone ? '' : '#'}${title()}`}</>;
  const open = async (kind: 'table' | 'page') => {
    const id = props.id ?? await props.notebook.pageByTitle(props.title, false);
    if (id && !unresolved()) props.onOpen?.(kind === 'page' ? { kind: 'page', pageId: id } : { kind: 'table', typeId: id, viewId: null, query: { type: id, text: null, filters: [], sort: [], limit: null } }, true);
  };
  return <>
    <Show when={props.interactive !== false} fallback={<span class="outline-tag" classList={{ 'outline-reference-unresolved': unresolved() }} style={phone ? { '--pill-hue': typeHue(title()) } : undefined} data-source-start={props.start} data-source-end={props.end}>{label()}</span>}>
      <button type="button" class="outline-tag" classList={{ 'outline-reference-unresolved': unresolved() }} style={phone ? { '--pill-hue': typeHue(title()) } : undefined} data-source-start={props.start} data-source-end={props.end}
        onClick={event => { event.stopPropagation(); setAnchor(event.currentTarget); }}>{label()}</button>
    </Show>
    <Show when={anchor()}>{element => <Menu anchor={element()} label={`#${title()}`} onDismiss={() => { setAnchor(null); props.onRestoreFocus?.(); }} items={[
      { label: 'Open table', disabledReason: unresolved() ? 'This tag is unavailable.' : undefined, action: () => void open('table') },
      { label: 'Open tag', disabledReason: unresolved() ? 'This tag is unavailable.' : undefined, action: () => void open('page') },
      { label: 'Remove tag', disabledReason: props.onRemove ? undefined : 'From the text. Edit the #tag there to remove it.', action: () => props.onRemove?.() },
    ]} />}</Show>
  </>;
}
