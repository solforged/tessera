import { For, Index, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { Block, IndexKind, NoteIndex, Shelf, View } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { indexKindTarget, kindLabel, noteKindIcon, shelves } from '../notes/kinds';
import { displayTitle } from '../outline/names';
import { createPageIcon } from '../outline/source';
import { knownNotebooks } from '../settings/notebooks';
import { NotebookSwitcher } from '../settings/NotebookSwitcher';
import { journalLabel } from '../tasks/relative-date';
import { Button } from '../ui/Button';
import { longPress, openContextMenu } from '../ui/context-menu';
import { Icon } from '../ui/Icon';
import { ListGroup, ListRow } from '../ui/List';
import type { MenuItem } from '../ui/Menu';
import type { OpenTarget } from './contract';

/** Pages open as rows; roots arrive as fresh objects whenever any root changes, so rows are keyed by id. */
function PageRows(props: { roots: Block[]; notebook: NotebookClient; onOpen(target: OpenTarget): void }) {
  const byId = createMemo(() => new Map(props.roots.map(root => [root.id, root])));
  const ids = createMemo(() => props.roots.map(root => root.id), undefined, { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) });
  return <For each={ids()}>{id => {
    const root = () => byId().get(id)!;
    const title = () => {
      const page = props.notebook.lookup(id)() ?? root();
      return page.kind === 'journal' ? journalLabel(page.text, props.notebook.todayDate()) : page.kind === 'page' ? displayTitle(page.text, target => props.notebook.lookup(target)) : page.text;
    };
    const icon = createPageIcon(props.notebook, root, () => true, 'today');
    return <ListRow push icon={icon()} data-open-page={id} data-open-label={title()} onClick={() => props.onOpen({ kind: 'page', pageId: id })}>{title()}</ListRow>;
  }}</For>;
}

/**
 * The phone's Index: every section is one grouped list, and every row pushes. A long press on a saved view opens its actions,
 * so no row carries a ··· of its own. Settings sits once, under Workshop, beside Fields.
 */
export function PhoneIndex(props: {
  notebook: NotebookClient;
  index: NoteIndex | undefined;
  /** Atoms due for revisit, shown at Revisits. */
  revisits: number;
  views: View[];
  pinned: Block[];
  recent: Block[];
  onOpen(target: OpenTarget): void;
  onOpenView(view: View): void;
  onNewView(anchor: HTMLElement): void;
  /** What a long press on a saved view offers. */
  viewMenu(view: View): MenuItem[];
  /** What a long press on the Questions row offers. */
  questionMenu(): MenuItem[];
  onError(reason: unknown): void;
}) {
  const populated = (kind: IndexKind) => !!(kind.count || kind.tagged_block_count);
  const shelved = createMemo(() => {
    const result: Partial<Record<Shelf, IndexKind[]>> = {};
    for (const kind of props.index?.kinds ?? []) if (populated(kind)) (result[kind.shelf] ??= []).push(kind);
    return result;
  });
  const empty = createMemo(() => (props.index?.kinds ?? []).filter(kind => !populated(kind)));
  const [emptyOpen, setEmptyOpen] = createSignal(false);
  // Kinds are rebuilt after each change; rows keep their place by position.
  const kindRow = (kind: () => IndexKind) => <ListRow push icon={noteKindIcon(kind())} count={populated(kind()) ? (kind().count || kind().tagged_block_count).toLocaleString() : undefined} data-kind-key={kind().key} onClick={() => props.onOpen(indexKindTarget(kind()))}>{kindLabel(kind())}</ListRow>;
  // A workshop menu is worth a control only when there is a second workshop to switch to.
  const switchable = () => (knownNotebooks()?.notebooks ?? []).filter(entry => entry.current || entry.available).length > 1;
  let root!: HTMLDivElement;
  onMount(() => onCleanup(longPress(root, ({ x, y }) => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('.list-row');
    if (!row) return;
    const view = props.views.find(value => value.id === row.dataset.viewId);
    if (view) openContextMenu({ source: row, label: `View actions: ${view.name}`, items: props.viewMenu(view) });
    else if (row.dataset.kindKey === 'question') openContextMenu({ source: row, label: 'Questions', items: props.questionMenu() });
  })));
  return <div ref={root} class="phone-index">
    <Show when={props.pinned.length}><ListGroup label="Pinned"><PageRows roots={props.pinned} notebook={props.notebook} onOpen={props.onOpen} /></ListGroup></Show>
    <For each={shelves}>{([shelf, label]) => <Show when={shelf === 'notes' || shelved()[shelf]?.length || shelf === 'loose' && empty().length}>
      <ListGroup label={label}>
        <Show when={shelf === 'notes'}>
          <ListRow push icon="history" count={props.revisits || undefined} label={`Revisits · ${props.revisits} to revisit`} onClick={() => props.onOpen({ kind: 'revisits' })}>Revisits</ListRow>
        </Show>
        <Index each={shelved()[shelf] ?? []}>{kindRow}</Index>
        <Show when={shelf === 'loose' && empty().length}>
          <ListRow icon="archive" count={empty().length} aria-expanded={emptyOpen()} onClick={() => setEmptyOpen(open => !open)}
            trailing={<span class="list-chev phone-index-fold" classList={{ open: emptyOpen() }}><Icon name="right" /></span>}>{empty().length === 1 ? 'Empty kind' : 'Empty kinds'}</ListRow>
          <Show when={emptyOpen()}><Index each={empty()}>{kindRow}</Index></Show>
        </Show>
      </ListGroup>
    </Show>}</For>
    <Show when={props.index?.spreads.length}>
      <ListGroup label="Spreads"><For each={props.index?.spreads}>{spread => <ListRow push icon="panes" onClick={() => props.onOpen({ kind: 'page', pageId: spread.id })}>{spread.title}</ListRow>}</For></ListGroup>
    </Show>
    <ListGroup label="Views" action={<Button kind="plain" icon="plus" onClick={event => props.onNewView(event.currentTarget)}>New view</Button>}>
      <Show when={props.views.length} fallback={<ListRow class="phone-index-note">No saved views yet</ListRow>}>
        <For each={props.views}>{view => <ListRow push icon="table" data-view-id={view.id} onClick={() => props.onOpenView(view)}>{view.name}</ListRow>}</For>
      </Show>
    </ListGroup>
    <ListGroup label="Recent">
      <Show when={props.recent.length} fallback={<ListRow class="phone-index-note">Atoms you open appear here</ListRow>}><PageRows roots={props.recent} notebook={props.notebook} onOpen={props.onOpen} /></Show>
    </ListGroup>
    <ListGroup label="Workshop" action={<Show when={switchable()}><NotebookSwitcher notebook={props.notebook} onOpen={props.onOpen} onError={props.onError} /></Show>}>
      <ListRow push icon="settings" onClick={() => props.onOpen({ kind: 'settings' })}>Settings</ListRow>
      <ListRow push icon="field" count={props.index?.fields.toLocaleString()} onClick={() => props.onOpen({ kind: 'fields' })}>Fields</ListRow>
    </ListGroup>
  </div>;
}
