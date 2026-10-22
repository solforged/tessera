import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { RevisitAction, RevisitRow } from '../api/types';
import type { DocumentChange, NotebookClient } from '../document/contract';
import { OutlinePane } from '../outline/OutlinePane';
import { BlockText } from '../outline/BlockText';
import { DatePicker } from '../tasks/DatePicker';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import type { CommandRegistry, OpenTarget, PaneId, RevisitsViewState } from '../shell/contract';
import { opensBeside } from '../shell/beside';
import { changeRevisit, createRevisits, revisitKind } from './revisits';
import './revisits.css';

interface RevisitsPaneProps {
  pane: PaneId;
  view: RevisitsViewState;
  notebook: NotebookClient;
  commands: CommandRegistry;
  active: boolean;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: RevisitsViewState): void;
}

export function NotesReview(props: RevisitsPaneProps) {
  const queue = createRevisits(props.notebook);
  const groups = createMemo(() => {
    const dates = new Map<string, RevisitRow[]>();
    for (const row of queue.rows()) {
      const rows = dates.get(row.revisit_on);
      if (rows) rows.push(row);
      else dates.set(row.revisit_on, [row]);
    }
    return [...dates].sort(([a], [b]) => a.localeCompare(b));
  });
  const current = createMemo(() => queue.rows().find(row => row.block.block.id === props.view.revisitId) ?? groups()[0]?.[1][0]);
  let pane!: HTMLDivElement;
  let restoredScroll = false;
  createEffect(() => {
    if (!queue.rows().length || restoredScroll) return;
    let frame = 0;
    const restore = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!pane.querySelector('.outline-pane') || pane.querySelector('[data-pane-pending]')) return;
        pane.scrollTop = props.view.scroll;
        restoredScroll = true;
        observer.disconnect();
      });
    };
    const observer = new MutationObserver(restore);
    observer.observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-pane-pending'] });
    restore();
    onCleanup(() => { cancelAnimationFrame(frame); observer.disconnect(); });
  });
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
      const after = groups().flatMap(([, rows]) => rows).find(value => value.block.block.id !== row.block.block.id);
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
  return <div ref={pane} class="notes-review" onScroll={() => { if (restoredScroll) props.onViewChange({ ...props.view, scroll: pane.scrollTop }); }}>
    <header class="notes-review-heading">
      <h1>Revisits<span>{queue.rows().length} due</span></h1>
      <Show when={history()}><Button disabled={busy()} onClick={() => { void travel(); }}>{undone() ? 'Redo revisit' : 'Undo revisit'}</Button></Show>
    </header>
    <Show when={queue.error() || error()}><p class="pane-error" role="alert">{queue.error() || error()}</p></Show>
    <Show when={queue.rows().length} fallback={<div class="revisit-empty">
      <p class="empty-state">Nothing to revisit. Set a Revisit date on a note or question and it appears here.</p>
      <Button onClick={event => props.onOpen({ kind: 'index', key: 'question' }, opensBeside(event))}>Open Questions</Button>
    </div>}>
      <nav class="revisit-queue" aria-label="Due revisits"><For each={groups()}>{([date, rows]) => <section class="revisit-date-group" aria-label={date}>
        <h2 class="revisit-section-head"><span>{date}</span><span class="section-rule" /><span class="revisit-group-count">{rows.length}</span></h2>
        <For each={rows}>{row => <Button aria-pressed={current()?.block.block.id === row.block.block.id} disabled={busy()} onClick={() => props.onViewChange({ ...props.view, revisitId: row.block.block.id })}>
          <BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /><span class="revisit-meta">{revisitKind(row)}</span>
        </Button>}</For>
      </section>}</For></nav>
      <Show when={current()}>{row => <div class="revisit-action-bar">
        <Button disabled={busy()} onClick={event => openConfirmation(event.currentTarget, row(), 'revisited')}>Revisited</Button>
        <Button disabled={busy()} onClick={event => setPicker({ anchor: event.currentTarget, later: true, row: row() })}>Later</Button>
        <Button disabled={busy()} onClick={() => { void act(row(), 'resolve', null).catch(() => {}); }}>Resolve</Button>
        <Show when={row().question_status}><Button disabled={busy()} onClick={event => openConfirmation(event.currentTarget, row(), 'keep_recurrent')}>Keep recurrent</Button></Show>
      </div>}</Show>
      <Show keyed when={current()?.block.block.id}>{id => {
        const row = queue.rows().find(value => value.block.block.id === id)!;
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
