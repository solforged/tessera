import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { api } from '../api/client';
import type { Block, BlockInPage, Row } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import type { PopupAnchor } from '../ui/Popup';
import type { CommandRegistry, OpenTarget, PaneId } from './contract';

export function Palette(props: { anchor: PopupAnchor; pane: PaneId; mode: 'search' | 'commands'; commands: CommandRegistry; notebook: NotebookClient; onDismiss(): void; onRestoreFocus(): void; onOpen(target: OpenTarget, beside: boolean): void }) {
  const capturedCommands = props.commands.list().map(command => command.capture?.() ?? command);
  const [mode, setMode] = createSignal(props.mode);
  const [query, setQuery] = createSignal('');
  const [debounced, setDebounced] = createSignal('');
  const [selected, setSelected] = createSignal(0);
  const [scopes, setScopes] = createSignal<BlockInPage[]>([]);
  let content!: HTMLDivElement;
  let input!: HTMLInputElement;
  createEffect(() => {
    const value = query().trim();
    const timer = setTimeout(() => { setDebounced(value); setSelected(0); setScopes([]); }, 100);
    onCleanup(() => clearTimeout(timer));
  });
  const [hits] = createResource(debounced, async q => q ? api.search(q) : props.notebook.roots().map(root => ({ block: root, page: root })));
  const scope = () => scopes().at(-1);
  const [scopedPage] = createResource(() => scope()?.page.id, id => api.page(id));
  const entries = createMemo(() => {
    if (query().trim() !== debounced() || hits.loading) return [];
    const parent = scope();
    if (!parent) return hits.error ? [] : hits() ?? [];
    if (scopedPage.error) return [];
    return (scopedPage()?.rows ?? []).filter(row => row.block.parent_id === parent.block.id).map(row => ({ block: row.block, page: parent.page }));
  });
  const selectedHit = () => entries()[selected()];
  const [preview] = createResource(() => selectedHit()?.page.id, id => api.page(id));
  const commands = createMemo(() => capturedCommands.filter(command => (!command.id.startsWith('outline.') || command.id.startsWith(`outline.${props.pane}.`)) && `${command.title} ${command.section}`.toLocaleLowerCase().includes(query().toLocaleLowerCase())));
  createEffect(() => {
    selected(); mode(); entries().length; commands().length;
    queueMicrotask(() => {
      if (content?.isConnected) content.querySelector<HTMLElement>('.search-hit.selected, .command-result.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });
  const children = createMemo(() => {
    const hit = selectedHit();
    if (!hit || preview.error) return [];
    return (preview()?.rows ?? []).filter(row => row.block.parent_id === hit.block.id);
  });
  const ancestors = createMemo(() => {
    const hit = selectedHit();
    const page = preview.error ? undefined : preview();
    if (!hit || !page) return [];
    const blocks = new Map<string, Block>(page.rows.map(row => [row.block.id, row.block]));
    const result: Block[] = [];
    let parent = blocks.get(hit.block.id)?.parent_id;
    while (parent && parent !== page.root.id) {
      const block = blocks.get(parent); if (!block) break;
      result.unshift(block); parent = block.parent_id;
    }
    return result;
  });
  const previewRows = createMemo(() => {
    const hit = selectedHit();
    const page = preview.error ? undefined : preview();
    if (!hit || !page) return [];
    if (hit.block.id === page.root.id) return page.rows;
    const start = page.rows.findIndex(row => row.block.id === hit.block.id);
    if (start < 0) return [];
    let end = start + 1;
    while (end < page.rows.length && page.rows[end]!.depth > page.rows[start]!.depth) end++;
    return page.rows.slice(start, end);
  });
  const drill = () => {
    const hit = selectedHit();
    if (!hit || !children().length) return;
    setScopes(previous => [...previous, hit]); setSelected(0);
    queueMicrotask(() => { if (input.isConnected) input.focus({ preventScroll: true }); });
  };
  const up = () => {
    setScopes(previous => previous.slice(0, -1)); setSelected(0);
    queueMicrotask(() => { if (input.isConnected) input.focus({ preventScroll: true }); });
  };
  const open = (beside: boolean) => {
    const hit = selectedHit(); if (!hit) return;
    props.onDismiss(); props.onOpen({ pageId: hit.page.id, ...(hit.block.id !== hit.page.id ? { blockId: hit.block.id } : {}) }, beside);
  };
  const runCommand = (index: number) => {
    const command = commands()[index]; if (!command || command.disabledReason?.()) return;
    props.onDismiss(); command.run();
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) props.onRestoreFocus();
    });
  };
  return <Popup anchor={props.anchor} onDismiss={props.onDismiss} label="Search and Commands" width={800} class="palette">
    <div ref={content} onKeyDown={event => {
      if (event.isComposing) return;
      const target = event.target as HTMLElement;
      if (!target.closest('.palette-query, .search-hit, .command-result')) return;
      const count = mode() === 'search' ? entries().length : commands().length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); setSelected(index => count ? (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count : 0);
      } else if (event.key === 'Enter') {
        event.preventDefault(); if (mode() === 'search') open(event.shiftKey); else runCommand(selected());
      } else if (event.key === 'Tab' && mode() === 'search' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.shiftKey && scopes().length) { event.preventDefault(); up(); }
        else if (!event.shiftKey && children().length) { event.preventDefault(); drill(); }
      }
    }}>
      <div class="palette-modes" role="tablist" aria-label="Popup mode">
        <Button role="tab" aria-selected={mode() === 'search'} icon="search" onClick={() => { setMode('search'); setSelected(0); }}>Search <kbd>⌃⇧F</kbd></Button>
        <Button role="tab" aria-selected={mode() === 'commands'} icon="command" onClick={() => { setMode('commands'); setSelected(0); }}>Commands <kbd>⌃⇧P</kbd></Button>
      </div>
      <input ref={input} class="input palette-query" aria-label={mode() === 'search' ? 'Search notebook' : 'Find command'} placeholder={mode() === 'search' ? 'Search titles and block text…' : 'Find a command…'} value={query()} onInput={event => { setQuery(event.currentTarget.value); setSelected(0); }} />
      <Show when={mode() === 'commands'} fallback={<div class="search-layout">
        <div class="search-results" role="listbox" aria-label="Search results">
          <Show when={scopes().length}><div class="scope-bar"><Button icon="up" onClick={up}>Up <kbd>⇧Tab</kbd></Button><span><BlockText text={scope()?.block.text ?? ''} notebook={props.notebook} interactive={false} /></span></div></Show>
          <Show when={query().trim() !== debounced() || hits.loading || scopedPage.loading}><p class="empty-state">Searching…</p></Show>
          <Show when={hits.error || scopedPage.error}><p class="error" role="alert">Couldn’t search · {String((hits.error ?? scopedPage.error)?.message)}</p></Show>
          <For each={entries()}>{(hit, index) => <button type="button" role="option" aria-selected={index() === selected()} class={`search-hit ${index() === selected() ? 'selected' : ''}`} onFocus={() => setSelected(index())} onClick={() => setSelected(index())} onDblClick={() => open(false)}>
            <SearchBreadcrumb hit={hit} notebook={props.notebook} />
            <span><BlockText text={props.notebook.lookup(hit.block.id)()?.text ?? hit.block.text} notebook={props.notebook} interactive={false} highlight={query()} /></span>
          </button>}</For>
          <Show when={!hits.loading && !entries().length && !hits.error}><p class="empty-state">No results.</p></Show>
        </div>
        <section class="search-preview" aria-label="Outline preview">
          <Show when={selectedHit()}>{hit => <>
            <div class="preview-breadcrumb">{hit().page.text}<For each={ancestors()}>{block => <> / <BlockText text={block.text} notebook={props.notebook} interactive={false} /></>}</For></div>
            <div class="preview-actions"><Button icon="page" onClick={() => open(false)}>Open here <kbd>Enter</kbd></Button><Button icon="panes" onClick={() => open(true)}>Open beside <kbd>⇧Enter</kbd></Button><Button icon="down" disabled={!children().length} onClick={drill}>Children <kbd>Tab</kbd></Button></div>
            <Show when={preview.loading}><p class="empty-state">Loading preview…</p></Show>
            <Show when={preview.error}><p class="error">Couldn’t load preview.</p></Show>
            <Show when={hit().block.id === hit().page.id}><h3>{hit().page.text}</h3></Show>
            <Show keyed when={selectedHit()?.block.id}><OutlinePreview rows={previewRows()} query={query()} notebook={props.notebook} /></Show>
            <Show when={!preview.loading && !previewRows().length}><p class="empty-state">No child blocks.</p></Show>
          </>}</Show>
        </section>
      </div>}>
        <div class="command-list" role="listbox" aria-label="Commands">
          <For each={commands()}>{(command, index) => <button type="button" class={`command-result ${selected() === index() ? 'selected' : ''}`} role="option" aria-selected={selected() === index()} aria-disabled={!!command.disabledReason?.()} onFocus={() => setSelected(index())} onClick={() => runCommand(index())}>
            <span class="command-section">{command.section}</span><span class="command-name">{command.title}<Show when={command.disabledReason?.()}>{reason => <small>{reason()}</small>}</Show></span><kbd>{command.keys?.join(' / ')}</kbd>
          </button>}</For>
          <Show when={!commands().length}><p class="empty-state">No matching commands.</p></Show>
        </div>
      </Show>
    </div>
  </Popup>;
}

function SearchBreadcrumb(props: { hit: BlockInPage; notebook: NotebookClient }) {
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
  return <span class="hit-breadcrumb">{props.notebook.lookup(props.hit.page.id)()?.text ?? props.hit.page.text}<For each={ancestors()}>{block => <> / <BlockText text={block.text} notebook={props.notebook} interactive={false} /></>}</For></span>;
}

function OutlinePreview(props: { rows: Row[]; query: string; notebook: NotebookClient }) {
  let scroll!: HTMLDivElement;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() { return props.rows.length; },
    getScrollElement: () => scroll,
    getItemKey: index => props.rows[index]!.block.id,
    estimateSize: () => 32,
    overscan: 4,
  });
  return <div ref={scroll} class="preview-scroll" aria-label="Read-only outline">
    <div class="preview-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      <For each={virtualizer.getVirtualItems()}>{item => {
        const row = () => props.rows[item.index]!;
        return <div ref={element => virtualizer.measureElement(element)} data-index={item.index} class="preview-windowed-row" style={{ transform: `translateY(${item.start}px)` }}>
          <div class={`preview-row heading-${row().block.heading ?? 0}`} style={{ 'padding-left': `${Math.max(0, row().depth - (props.rows[0]?.depth ?? 0)) * 16}px` }}>
            <span aria-hidden="true">•</span><span><BlockText text={props.notebook.lookup(row().block.id)()?.text ?? row().block.text} notebook={props.notebook} interactive={false} highlight={props.query} /></span>
          </div>
        </div>;
      }}</For>
    </div>
  </div>;
}
