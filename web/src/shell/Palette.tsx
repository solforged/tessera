import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import { api } from '../api/client';
import type { Block, BlockInPage } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { Command, CommandRegistry, OpenTarget, PaneId } from './contract';

type Entry = { kind: 'hit'; hit: BlockInPage } | { kind: 'command'; command: Command };

/** One palette: text searches blocks, a leading `>` finds commands. Tab drills into the highlighted block's children. */
export function Palette(props: { pane: PaneId; mode: 'search' | 'commands'; commands: CommandRegistry; notebook: NotebookClient; onDismiss(): void; onRestoreFocus(): void; onOpen(target: OpenTarget, beside: boolean): void }) {
  const capturedCommands = props.commands.list().map(command => command.capture?.() ?? command);
  const [query, setQuery] = createSignal(props.mode === 'commands' ? '>' : '');
  const [debounced, setDebounced] = createSignal('');
  const [scopes, setScopes] = createSignal<BlockInPage[]>([]);
  const mode = () => query().startsWith('>') ? 'commands' : 'search';
  const text = () => mode() === 'commands' ? query().slice(1).trim() : query().trim();
  createEffect(() => {
    const value = text();
    const timer = setTimeout(() => { setDebounced(value); setScopes([]); }, 100);
    onCleanup(() => clearTimeout(timer));
  });
  const [hits] = createResource(() => mode() === 'search' ? debounced() : null, async q => q ? api.search(q) : props.notebook.roots().map(root => ({ block: root, page: root })));
  const scope = () => scopes().at(-1);
  const [scopedPage] = createResource(() => scope()?.page.id, id => api.page(id));
  const commands = createMemo(() => capturedCommands.filter(command => (!command.id.startsWith('outline.') || command.id.startsWith(`outline.${props.pane}.`)) && `${command.title} ${command.section}`.toLocaleLowerCase().includes(text().toLocaleLowerCase())));
  const entries = createMemo((): Entry[] => {
    if (mode() === 'commands') return commands().map(command => ({ kind: 'command', command }));
    if (text() !== debounced() || hits.loading) return [];
    const parent = scope();
    const rows = !parent ? (hits.error ? [] : hits() ?? [])
      : scopedPage.error ? []
        : (scopedPage()?.rows ?? []).filter(row => row.block.parent_id === parent.block.id).map(row => ({ block: row.block, page: parent.page }));
    return rows.map(hit => ({ kind: 'hit', hit }));
  });
  const drill = async (hit: BlockInPage): Promise<boolean> => {
    const page = await api.page(hit.page.id);
    if (!page.rows.some(row => row.block.parent_id === hit.block.id)) return false;
    setScopes(previous => [...previous, hit]);
    return true;
  };
  const up = () => setScopes(previous => previous.slice(0, -1));
  const open = (hit: BlockInPage, beside: boolean) => {
    props.onDismiss(); props.onOpen({ kind: 'page', pageId: hit.page.id, ...(hit.block.id !== hit.page.id ? { blockId: hit.block.id } : {}) }, beside);
  };
  const run = (command: Command) => {
    if (command.disabledReason?.()) return;
    props.onDismiss(); command.run();
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) props.onRestoreFocus();
    });
  };
  const busy = () => mode() === 'search' && (text() !== debounced() || hits.loading || scopedPage.loading);
  const error = () => {
    const reason = mode() === 'search' ? hits.error ?? scopedPage.error : undefined;
    return reason ? `Couldn't search · ${String(reason?.message)}` : undefined;
  };
  return <Picker<Entry> anchor={document.body} placement="top" label={mode() === 'search' ? 'Search notebook' : 'Find command'} class="palette" onDismiss={props.onDismiss}
    query={query()} onQuery={setQuery} placeholder={mode() === 'search' ? 'Search blocks, or type > for commands' : 'Find a command'}
    prefix={<Icon name={mode() === 'search' ? 'search' : 'command'} class="picker-prefix" />}
    status={<Show when={scope()}>{parent => <div class="scope-bar"><Icon name="up" /><BlockText text={parent().block.text} notebook={props.notebook} interactive={false} /><kbd>⇧Tab</kbd></div>}</Show>}
    items={entries()} key={entry => entry.kind === 'hit' ? entry.hit.block.id : entry.command.id}
    disabledReason={entry => entry.kind === 'command' ? entry.command.disabledReason?.() : undefined}
    onPick={(entry, event) => entry.kind === 'hit' ? open(entry.hit, event.shiftKey) : run(entry.command)}
    onKey={(event, entry) => {
      if (event.key !== 'Tab' || mode() !== 'search' || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (event.shiftKey) { if (!scopes().length) return false; up(); return true; }
      if (entry?.kind === 'hit') void drill(entry.hit);
      return true;
    }}
    busy={busy()} error={error()} empty={mode() === 'search' ? 'No results.' : 'No matching commands.'}
    row={(entry, selected) => entry.kind === 'hit'
      ? <HitRow hit={entry.hit} query={text()} notebook={props.notebook} selected={selected} />
      : <CommandRow command={entry.command} />} />;
}

function HitRow(props: { hit: BlockInPage; query: string; notebook: NotebookClient; selected: boolean }) {
  const ancestors = createMemo(() => {
    const result: Block[] = [];
    let parent = props.hit.block.parent_id;
    while (parent && parent !== props.hit.page.id) {
      const block = props.notebook.lookup(parent)();
      if (!block) break;
      result.unshift(block);
      parent = block.parent_id;
    }
    return result;
  });
  const isPage = () => props.hit.block.id === props.hit.page.id;
  return <>
    <Icon name={isPage() ? (props.hit.page.kind === 'journal' ? 'calendar' : 'page') : 'bullet'} />
    <span class="picker-text"><BlockText text={props.notebook.lookup(props.hit.block.id)()?.text ?? props.hit.block.text} notebook={props.notebook} interactive={false} highlight={props.query} /></span>
    <Show when={!isPage()}><span class="picker-meta">{props.notebook.lookup(props.hit.page.id)()?.text ?? props.hit.page.text}<For each={ancestors()}>{block => <> / <BlockText text={block.text} notebook={props.notebook} interactive={false} /></>}</For></span></Show>
    <Show when={props.selected}><kbd class="picker-hint">⇧↵ beside</kbd></Show>
  </>;
}

function CommandRow(props: { command: Command }) {
  return <>
    <span class="picker-text">{props.command.title}<Show when={props.command.disabledReason?.()}>{reason => <small> · {reason()}</small>}</Show></span>
    <span class="picker-meta">{props.command.section}</span>
    <Show when={props.command.keys?.length}><kbd>{props.command.keys!.join(' / ')}</kbd></Show>
  </>;
}
