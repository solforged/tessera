import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { RevisitAction, RevisitRow } from '../api/types';
import type { DocumentChange } from '../document/contract';
import { OutlinePane } from '../outline/OutlinePane';
import { BlockText } from '../outline/BlockText';
import { DatePicker } from '../tasks/DatePicker';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import type { ReviewPaneProps } from './ReviewPane';
import { changeRevisit, revisitKind } from './revisits';
import './revisits.css';

export function NotesReview(props: ReviewPaneProps & { rows: RevisitRow[]; error: string }) {
  const current = createMemo(() => props.rows.find(row => row.block.block.id === props.view.revisitId) ?? props.rows[0]);
  const [confirm, setConfirm] = createSignal<{ anchor: HTMLElement; row: RevisitRow; action: 'revisited' | 'keep_recurrent' }>();
  const [next, setNext] = createSignal<string | null>(null);
  const [picker, setPicker] = createSignal<{ anchor: HTMLElement; later: boolean; row: RevisitRow }>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [history, setHistory] = createSignal<DocumentChange>();
  const [undone, setUndone] = createSignal(false);
  createEffect(() => { if (current() && props.view.revisitId !== current()!.block.block.id) props.onViewChange({ ...props.view, revisitId: current()!.block.block.id }); });
  async function act(row: RevisitRow, action: RevisitAction, date: string | null) {
    setBusy(true); setError('');
    try {
      setHistory(await changeRevisit(props.notebook, row.block.block.id, action, date));
      setUndone(false); setConfirm(undefined);
      const after = props.rows.find(value => value.block.block.id !== row.block.block.id);
      props.onViewChange({ ...props.view, revisitId: after?.block.block.id });
    } catch (reason) { setError(String(reason)); throw reason; }
    finally { setBusy(false); }
  }
  async function travel() {
    const change = history(); if (!change) return;
    setBusy(true); setError('');
    try { await (undone() ? change.redo() : change.undo()); setUndone(value => !value); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const openConfirmation = (anchor: HTMLElement, row: RevisitRow, action: 'revisited' | 'keep_recurrent') => { setNext(row.proposed_on); setConfirm({ anchor, row, action }); };
  return <div class="notes-review">
    <header class="notes-review-heading"><h1>Questions and notes</h1><span>{props.rows.length} due</span>
      <Show when={history()}><Button disabled={busy()} onClick={() => { void travel(); }}>{undone() ? 'Redo revisit' : 'Undo revisit'}</Button></Show>
    </header>
    <Show when={props.error || error()}><p class="pane-error" role="alert">{props.error || error()}</p></Show>
    <Show when={props.rows.length} fallback={<p class="empty-state">No questions or notes to revisit.</p>}>
      <nav class="revisit-queue" aria-label="Due questions and notes"><For each={props.rows}>{row => <Button aria-pressed={current()?.block.block.id === row.block.block.id} disabled={busy()} onClick={() => props.onViewChange({ ...props.view, revisitId: row.block.block.id })}>
        <BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /><span class="revisit-meta">{revisitKind(row)} · {row.revisit_on}</span>
      </Button>}</For></nav>
      <Show when={current()}>{row => <div class="revisit-action-bar">
        <Button disabled={busy()} onClick={event => openConfirmation(event.currentTarget, row(), 'revisited')}>Revisited</Button>
        <Button disabled={busy()} onClick={event => setPicker({ anchor: event.currentTarget, later: true, row: row() })}>Later</Button>
        <Button disabled={busy()} onClick={() => { void act(row(), 'resolve', null).catch(() => {}); }}>Resolve</Button>
        <Show when={row().question_status}><Button disabled={busy()} onClick={event => openConfirmation(event.currentTarget, row(), 'keep_recurrent')}>Keep recurrent</Button></Show>
      </div>}</Show>
      <Show keyed when={current()?.block.block.id}>{id => {
        const row = props.rows.find(value => value.block.block.id === id)!;
        return <div class="revisit-outline"><OutlinePane pane={props.pane} pageId={row.block.page.id} notebook={props.notebook} active={props.active} onActivate={props.onActivate} onOpen={props.onOpen} vim={props.notebook.vim()} onVimMode={() => {}} commands={props.commands}
          view={{ zoom: row.block.block.kind === 'block' ? id : null, caret: null, scroll: null, folds: null, showArchived: false, depth: 'full' }} onViewChange={() => {}} /></div>;
      }}</Show>
    </Show>
    <Show keyed when={confirm()}>{state => <Popup anchor={state.anchor} label={state.action === 'revisited' ? 'Revisited' : 'Keep recurrent'} onDismiss={() => { if (!busy()) setConfirm(undefined); }}>
      <div class="revisit-confirm"><p>Next revisit</p><Button disabled={busy()} onClick={event => setPicker({ anchor: event.currentTarget, later: false, row: state.row })}>{next() ?? 'No revisit date'}</Button>
        <Button disabled={busy()} onClick={() => { void act(state.row, state.action, next()).catch(() => {}); }}>Confirm revisit</Button>
      </div>
    </Popup>}</Show>
    <Show keyed when={picker()}>{state => <DatePicker notebook={props.notebook} anchor={state.anchor} label="Set revisit date" presets="revisit" value={state.later ? state.row.revisit_on : next()} contextDate={props.notebook.todayDate()} onDismiss={() => setPicker(undefined)} onSelect={async value => { if (state.later) await act(state.row, 'later', value.date); else setNext(value.date); }} />}</Show>
  </div>;
}
