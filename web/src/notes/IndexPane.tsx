import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import type { NoteEntry, NoteKind } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { IndexViewState, OpenTarget } from '../shell/contract';
import { typeQuery } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { noteKindIcon } from './kinds';
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

/** A kind's finding aid: its notes by title, in columns under their initial letters, as a book's index. */
export function IndexPane(props: IndexPaneProps) {
  const [version, setVersion] = createSignal(0);
  createEffect(() => {
    props.notebook.changeSequence();
    const timer = setTimeout(() => setVersion(value => value + 1), 300);
    onCleanup(() => clearTimeout(timer));
  });
  const [notes] = createResource(() => [props.kindKey, version()] as const, ([key]) => props.notebook.api.kindNotes(key));
  // Letters group by the title's first letter without diacritics; anything else files under #.
  const groups = createMemo(() => {
    const result = new Map<string, NoteEntry[]>();
    for (const note of notes.latest ?? []) {
      const initial = note.title.normalize('NFD').charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(initial) ? initial : '#';
      result.set(letter, [...result.get(letter) ?? [], note]);
    }
    return [...result].sort(([a], [b]) => a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b));
  });
  let scroll!: HTMLDivElement;
  requestAnimationFrame(() => { if (scroll) scroll.scrollTop = props.view.scroll; });
  const jump = (letter: string) => scroll.querySelector(`[data-letter="${letter}"]`)?.scrollIntoView({ block: 'start' });

  return <div ref={scroll} class="index-pane" role="region" tabIndex={0} aria-label={`${props.kind?.plural ?? 'Index'} index`} onFocusIn={props.onActivate} onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })}>
    <div class="index-sheet">
      <p class="index-eyebrow">Index</p>
      <div class="index-head">
        <h1><Icon name={noteKindIcon(props.kindKey)} />{props.kind?.plural ?? 'Index'}</h1>
        <Show when={notes.latest}>{list => <span class="index-tally">{list().length} {list().length === 1 ? 'note' : 'notes'}</span>}</Show>
        <Show when={props.kind?.type_id}>{typeId => <Button icon="table" onClick={event => props.onOpen({ kind: 'table', typeId: typeId(), viewId: null, query: typeQuery(typeId()) }, event.shiftKey)}>Table</Button>}</Show>
      </div>
      <Show when={notes.error}><p class="error" role="alert">Couldn’t load this index · {notes.error instanceof Error ? notes.error.message : String(notes.error)}</p></Show>
      <Show when={notes.latest} fallback={<Show when={!notes.error}><p class="empty-state" role="status">Loading notes…</p></Show>}>
        <Show when={groups().length} fallback={<p class="empty-state">No notes of this kind yet.</p>}>
          <nav class="index-letters" aria-label="Jump to letter">
            <For each={LETTERS}>{letter => <button type="button" disabled={!groups().some(([key]) => key === letter)} onClick={() => jump(letter)}>{letter}</button>}</For>
          </nav>
          <div class="index-columns">
            <For each={groups()}>{([letter, entries]) => <section class="index-group" data-letter={letter} aria-label={letter}>
              <h2><span>{letter}</span><span class="section-rule" /><span class="index-group-count">{entries.length}</span></h2>
              <For each={entries}>{note => <button type="button" class="index-entry" title={note.title} onClick={event => props.onOpen({ kind: 'page', pageId: note.id }, event.shiftKey)}>{note.title}</button>}</For>
            </section>}</For>
          </div>
        </Show>
      </Show>
    </div>
  </div>;
}
