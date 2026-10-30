import { opensBeside, besideHint } from '../shell/beside';
import { createMemo, For, Show, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import type { FieldDefinition, NoteKind } from '../api/types';
import { Icon } from '../ui/Icon';
import { noteKindIcon } from './kinds';
import type { NotebookClient, PageDocument } from '../document/contract';
import { foldName } from '../outline/names';
import { fieldEntryId } from '../table/query';
import type { OpenTarget } from '../shell/contract';
import { calendarDate, civilDate } from '../tasks/relative-date';
import { isPhone } from '../ui/phone';
import './note-header.css';

/** The kinds a note is filed under, in rubric capitals above its title; each opens that kind's index. */
export function NoteEyebrow(props: { kinds: NoteKind[] | undefined; onOpen(target: OpenTarget, beside: boolean): void }) {
  return <Show when={props.kinds?.length}>
    <p class="note-eyebrow"><For each={props.kinds}>{(kind, index) => <>
      <Show when={index()}><span class="note-eyebrow-separator" aria-hidden="true">/</span></Show>
      <button type="button" title={`Open the ${kind.plural} index · ${besideHint}`} onClick={event => props.onOpen({ kind: 'index', key: kind.key }, opensBeside(event))}><Icon name={noteKindIcon(kind)} />{kind.plural}</button>
    </>}</For></p>
  </Show>;
}

/** Alternate names read from the open document, including unsaved value edits. */
export function NoteAliases(props: { doc: PageDocument; fields: FieldDefinition[]; onEdit(entry: string): void }) {
  const fieldId = createMemo(() => props.fields.find(field => foldName(field.name) === 'aliases')?.id);
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

/** The note's apparatus line under its title: the day it was created in the notebook's time zone, then any trailing controls such as Revisit. */
export function NoteLine(props: { pageId: string; notebook: NotebookClient; children?: JSX.Element }) {
  const root = createMemo(() => props.notebook.roots().find(block => block.id === props.pageId));
  const created = (at: number) => {
    const day = civilDate(at, props.notebook.settings()?.time_zone);
    return isPhone() ? calendarDate(day, props.notebook.todayDate()) : day;
  };
  return <Show when={root()}>{page => <p class="note-line">
    <span class="note-created">Created {created(page().created_at)}</span>
    {props.children}
  </p>}</Show>;
}
