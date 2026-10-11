import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import type { NoteKind } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { IndexViewState, OpenTarget } from '../shell/contract';
import { typeQuery } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { noteKindIcon } from './kinds';
import { groupKindIndex } from './finding-aid';
import './notes.css';

interface IndexPaneProps {
  kindKey: string;
  /** The kind as the sidebar index last read it; absent while loading or once the kind has no notes. */
  kind: NoteKind | undefined;
  view: IndexViewState;
  notebook: NotebookClient;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: IndexViewState): void;
}

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

/** A kind's finding aid: notes and alternate names filed together under their initial letters. */
export function IndexPane(props: IndexPaneProps) {
  const [version, setVersion] = createSignal(0);
  createEffect(() => {
    props.notebook.changeSequence();
    const timer = setTimeout(() => setVersion(value => value + 1), 300);
    onCleanup(() => clearTimeout(timer));
  });
  const [index] = createResource(() => [props.kindKey, version()] as const, ([key]) => props.notebook.api.kindNotes(key));
  const groups = createMemo(() => groupKindIndex(index.latest));
  let scroll!: HTMLDivElement;
  requestAnimationFrame(() => { if (scroll) scroll.scrollTop = props.view.scroll; });
  const jump = (letter: string) => scroll.querySelector(`[data-letter="${letter}"]`)?.scrollIntoView({ block: 'start' });

  return <div ref={scroll} class="index-pane" role="region" tabIndex={0} aria-label={`${props.kind?.plural ?? 'Index'} index`} onFocusIn={props.onActivate} onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })}>
    <div class="index-sheet">
      <p class="index-eyebrow">Index</p>
      <div class="index-head">
        <h1><Icon name={noteKindIcon(props.kindKey)} />{props.kind?.plural ?? 'Index'}</h1>
        <Show when={index.latest}>{list => <span class="index-tally">{list().notes.length} {list().notes.length === 1 ? 'note' : 'notes'}</span>}</Show>
        <Show when={props.kind?.type_id}>{typeId => <Button icon="table" onClick={event => props.onOpen({ kind: 'table', typeId: typeId(), viewId: null, query: typeQuery(typeId()) }, event.shiftKey)}>Table</Button>}</Show>
      </div>
      <Show when={index.error}><p class="error" role="alert">Couldn’t load this index · {index.error instanceof Error ? index.error.message : String(index.error)}</p></Show>
      <Show when={index.latest} fallback={<Show when={!index.error}><p class="empty-state" role="status">Loading notes…</p></Show>}>
        <Show when={groups().length} fallback={<p class="empty-state">No notes of this kind yet.</p>}>
          <nav class="index-letters" aria-label="Jump to letter">
            <For each={LETTERS}>{letter => <button type="button" disabled={!groups().some(group => group.letter === letter)} onClick={() => jump(letter)}>{letter}</button>}</For>
          </nav>
          <div class="index-columns">
            <For each={groups()}>{group => <section class="index-group" data-letter={group.letter} aria-label={group.letter}>
              <h2><span>{group.letter}</span><span class="section-rule" /><span class="index-group-count">{group.noteCount || ''}</span></h2>
              <For each={group.entries}>{entry => entry.kind === 'note'
                ? <button type="button" class="index-entry" title={entry.note.title} onClick={event => props.onOpen({ kind: 'page', pageId: entry.note.id }, event.shiftKey)}>{entry.note.title}</button>
                : <div class="index-entry index-cross-reference">
                  <span class="index-alias">{entry.reference.alias}</span>{', '}<span class="index-see">see</span>{' '}
                  <For each={entry.reference.targets}>{(target, targetIndex) => <>
                    <Show when={targetIndex()}>{'; '}</Show>
                    <button type="button" class="index-see-target" title={`${target.title} · Shift to open beside`} onClick={event => props.onOpen({ kind: 'page', pageId: target.id }, event.shiftKey)}>{target.title}</button>
                  </>}</For>
                </div>
              }</For>
            </section>}</For>
          </div>
        </Show>
      </Show>
    </div>
  </div>;
}
