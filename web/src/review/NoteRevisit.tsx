import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { NoteState, RevisitAction } from '../api/types';
import type { DocumentChange, NotebookClient } from '../document/contract';
import { DatePicker } from '../tasks/DatePicker';
import { Button } from '../ui/Button';
import { Menu } from '../ui/Menu';
import { changeRevisit, workingNote } from './revisits';
import './revisits.css';

export function NoteRevisit(props: { id: string; notebook: NotebookClient }) {
  const [note, setNote] = createSignal<NoteState>(workingNote());
  const [date, setDate] = createSignal<string | null>(null);
  const [changed, setChanged] = createSignal(false);
  const [menu, setMenu] = createSignal<HTMLElement>();
  const [picker, setPicker] = createSignal<HTMLElement>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [history, setHistory] = createSignal<DocumentChange>();
  const [undone, setUndone] = createSignal(false);
  createEffect(() => {
    const id = props.id; props.notebook.changeSequence();
    const controller = new AbortController();
    void props.notebook.api.capabilities(id, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setNote(value.note ?? workingNote());
      setChanged(value.note_changed ?? false);
      setDate(value.question ? value.question.state.review_on : value.note?.revisit_on ?? null);
    }, reason => { if (!controller.signal.aborted) setError(String(reason)); });
    onCleanup(() => controller.abort());
  });
  async function change(action: RevisitAction, next: string | null) {
    setBusy(true); setError('');
    try { setHistory(await changeRevisit(props.notebook, props.id, action, next)); setUndone(false); }
    catch (reason) { setError(String(reason)); throw reason; }
    finally { setBusy(false); }
  }
  async function travel() {
    const change = history(); if (!change) return;
    setBusy(true); setError('');
    try { await (undone() ? change.redo() : change.undo()); setUndone(value => !value); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const due = () => !note().resolved_at && !!date() && date()! <= props.notebook.todayDate();
  return <span class="note-revisit">
    <Button disabled={busy()} aria-haspopup="menu" data-due={due() ? '' : undefined} onClick={event => setMenu(event.currentTarget)}>{note().resolved_at ? 'Resolved' : date() ? `Revisit ${date()}` : 'Revisit'}</Button>
    <Show when={changed()}><span>Changed after resolution</span></Show>
    <Show when={history()}><Button disabled={busy()} onClick={() => { void travel(); }}>{undone() ? 'Redo revisit' : 'Undo revisit'}</Button></Show>
    <Show when={error()}><span class="error" role="alert">{error()}</span></Show>
    <Show keyed when={menu()}>{anchor => <Menu anchor={anchor} label="Note revisit" onDismiss={() => setMenu(undefined)} items={[
      { label: 'Set revisit date…', action: () => setPicker(anchor) },
      { label: note().resolved_at ? 'Reopen' : 'Resolve', action: () => { void change(note().resolved_at ? 'reopen' : 'resolve', null).catch(() => {}); } },
    ]} />}</Show>
    <Show keyed when={picker()}>{anchor => <DatePicker notebook={props.notebook} anchor={anchor} label="Set revisit date" presets="revisit" value={date()} contextDate={props.notebook.todayDate()} onDismiss={() => setPicker(undefined)} onSelect={value => change('later', value.date)} />}</Show>
  </span>;
}
