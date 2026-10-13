import { createMemo, createResource, For, Show, untrack } from 'solid-js';
import { Icon } from '../ui/Icon';
import { noteKindIcon } from './kinds';
import type { NotebookClient, PageDocument } from '../document/contract';
import { foldName } from '../outline/names';
import { fieldEntryId } from '../table/query';
import type { OpenTarget } from '../shell/contract';
import './note-header.css';

/** The kinds a note is filed under, in rubric capitals above its title; each opens that kind's index. */
export function NoteEyebrow(props: { pageId: string; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void }) {
  const [kinds] = createResource(() => [props.pageId, props.notebook.changeSequence()] as const, ([id]) => props.notebook.api.noteKinds(id));
  return <Show when={!kinds.error && kinds.latest?.length}>
    <p class="note-eyebrow"><For each={kinds.latest}>{(kind, index) => <>
      <Show when={index()}><span class="note-eyebrow-separator" aria-hidden="true">/</span></Show>
      <button type="button" title={`Open the ${kind.plural} index · Shift to open beside`} onClick={event => props.onOpen({ kind: 'index', key: kind.key }, event.shiftKey)}><Icon name={noteKindIcon(kind)} />{kind.plural}</button>
    </>}</For></p>
  </Show>;
}

/** Alternate names read from the open document, including unsaved value edits. */
export function NoteAliases(props: { doc: PageDocument; notebook: NotebookClient; onEdit(entry: string): void }) {
  const [fields] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.fields());
  const fieldId = createMemo(() => {
    if (fields.error) return undefined;
    return fields.latest?.fields.find(field => {
      if (foldName(field.name) !== 'aliases') return false;
      const block = props.notebook.lookup(field.id)();
      return block !== null && !block?.archived;
    })?.id;
  });
  const entry = createMemo(() => {
    const id = fieldId();
    if (!id) return undefined;
    const doc = props.doc;
    doc.archivedVersion();
    const children = doc.outline.children(doc.pageId);
    // As with Gloss, entry identity follows structure, not every prose keystroke.
    return untrack(() => children.find(child => {
      const block = doc.block(child);
      return block && !block.archived && fieldEntryId(block.text) === id;
    }));
  });
  const aliases = createMemo(() => {
    const id = entry();
    if (!id) return [];
    const result: string[] = [];
    for (const child of props.doc.outline.children(id)) {
      const block = props.doc.block(child);
      if (!block || block.archived) continue;
      const text = block.text.trim();
      if (text) result.push(text);
    }
    return result;
  });
  return <Show when={aliases().length}>
    <p class="note-aliases"><button type="button" aria-label="Edit aliases" onClick={() => props.onEdit(entry()!)}><span class="note-aliases-label">Also</span>{' '}
      <For each={aliases()}>{(alias, index) => <>
        <Show when={index()}><span class="note-aliases-separator" aria-hidden="true"> · </span></Show>
        <span>{alias}</span>
      </>}</For>
    </button></p>
  </Show>;
}

/** The note's apparatus line under its title: a short mark from its ID and the day it was created, in the notebook's time zone. */
export function NoteLine(props: { pageId: string; notebook: NotebookClient }) {
  const root = createMemo(() => props.notebook.roots().find(block => block.id === props.pageId));
  return <Show when={root()}>{page => <p class="note-line">
    <span class="note-mark" title={page().id}>{page().id.slice(-10).toLowerCase()}</span>
    <span>Created {new Intl.DateTimeFormat('en-CA', { timeZone: props.notebook.settings()?.time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(page().created_at)}</span>
  </p>}</Show>;
}
