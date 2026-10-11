import { createMemo, createResource, For, Show } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import './note-header.css';

/** The kinds a note is filed under, in rubric capitals above its title; each opens that kind's index. */
export function NoteEyebrow(props: { pageId: string; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void }) {
  const [kinds] = createResource(() => [props.pageId, props.notebook.changeSequence()] as const, ([id]) => props.notebook.api.noteKinds(id));
  return <Show when={!kinds.error && kinds.latest?.length}>
    <p class="note-eyebrow"><For each={kinds.latest}>{(kind, index) => <>
      <Show when={index()}><span class="note-eyebrow-separator" aria-hidden="true">/</span></Show>
      <button type="button" title={`Open the ${kind.plural} index · Shift to open beside`} onClick={event => props.onOpen({ kind: 'index', key: kind.key }, event.shiftKey)}>{kind.name}</button>
    </>}</For></p>
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
