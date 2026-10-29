import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
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
import { settleHeight } from './settle';
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
  /** The queue row just chosen. The outline remounts for its note and takes focus once loaded; the row keeps it. */
  let heldFocus: { button: HTMLElement; until: number } | null = null;
  function keepQueueFocus() {
    if (!heldFocus || performance.now() > heldFocus.until || !heldFocus.button.isConnected) { heldFocus = null; return; }
    heldFocus.button.focus({ preventScroll: true });
  }
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
    if (busy()) return;
    // The confirmation leaves while its row is still in the queue, so it never lingers where its button was.
    const reopen = confirm();
    setBusy(true); setError(''); setConfirm(undefined);
    try {
      setHistory(await changeRevisit(props.notebook, row.block.block.id, action, date));
      setUndone(false);
      const after = groups().flatMap(([, rows]) => rows).find(value => value.block.block.id !== row.block.block.id);
      props.onViewChange({ ...props.view, revisitId: after?.block.block.id });
    } catch (reason) { setError(String(reason)); if (reopen) setConfirm(reopen); throw reason; }
    finally { setBusy(false); }
  }
  async function travel() {
    const change = history(); if (!change || busy()) return;
    setBusy(true); setError('');
    try { await (undone() ? change.redo() : change.undo()); setUndone(value => !value); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const openConfirmation = (anchor: HTMLElement, row: RevisitRow, action: 'revisited' | 'keep_recurrent') => { setNext(row.proposed_on); setConfirm({ anchor, row, action }); };
  // Controls stay focusable while a revisit is written: `disabled` would drop focus to the page.
  const dis = (value: boolean) => value ? 'true' as const : undefined;
  const unless = (handler: (event: MouseEvent & { currentTarget: HTMLButtonElement }) => void) => (event: MouseEvent & { currentTarget: HTMLButtonElement }) => { if (!busy()) handler(event); };
  // The queue glides to its new height when a row leaves, and the action bar and outline ride with it.
  let queueNav: HTMLElement | undefined;
  let queueHeight = 0;
  function watchQueue(element: HTMLElement) {
    queueNav = element;
    const observer = new ResizeObserver(() => { queueHeight = element.offsetHeight; });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  }
  createEffect(on(() => queue.rows().length, () => { if (queueNav?.isConnected) settleHeight(queueNav, queueHeight); }, { defer: true }));
  // The outline for a newly chosen note loads out of sight, beside the one it replaces, which leaves once the new one has rows.
  const [outlines, setOutlines] = createSignal<Outline[]>([]);
  createEffect(on(() => current()?.block.block.id, id => {
    const row = current();
    if (!id || !row) { setOutlines([]); return; }
    const entry = { id, pageId: row.block.page.id, zoom: row.block.block.kind === 'block' ? id : null };
    setOutlines(previous => previous[0] ? [previous[0], entry] : [entry]);
  }));
  return <div ref={pane} class="notes-review" onKeyDown={event => { if (event.key === 'Tab') heldFocus = null; }} onScroll={() => { if (restoredScroll) props.onViewChange({ ...props.view, scroll: pane.scrollTop }); }}>
    <header class="notes-review-heading">
      <h1>Revisits<span>{queue.rows().length} due</span></h1>
      <Show when={history()}><Button aria-disabled={dis(busy())} onClick={unless(() => { void travel(); })}>{undone() ? 'Redo revisit' : 'Undo revisit'}</Button></Show>
    </header>
    <Show when={queue.error() || error()}><p class="pane-error" role="alert">{queue.error() || error()}</p></Show>
    <Show when={queue.rows().length} fallback={<div class="revisit-empty">
      <p class="empty-state">Nothing to revisit. Set a Revisit date on a note or question and it appears here.</p>
      <Button onClick={event => props.onOpen({ kind: 'index', key: 'question' }, opensBeside(event))}>Open Questions</Button>
    </div>}>
      <nav ref={watchQueue} class="revisit-queue" aria-label="Due revisits"><For each={groups()}>{([date, rows]) => <section class="revisit-date-group" aria-label={date}>
        <h2 class="revisit-section-head"><span>{date}</span><span class="section-rule" /><span class="revisit-group-count">{rows.length}</span></h2>
        <For each={rows}>{row => <Button aria-pressed={current()?.block.block.id === row.block.block.id} aria-disabled={dis(busy())} onClick={unless(event => { heldFocus = { button: event.currentTarget, until: performance.now() + 1500 }; props.onViewChange({ ...props.view, revisitId: row.block.block.id }); })}>
          <BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /><span class="revisit-meta">{revisitKind(row)}</span>
        </Button>}</For>
      </section>}</For></nav>
      <Show when={current()}>{row => <div class="revisit-action-bar">
        <Button aria-disabled={dis(busy())} onClick={unless(event => openConfirmation(event.currentTarget, row(), 'revisited'))}>Revisited</Button>
        <Button aria-disabled={dis(busy())} onClick={unless(event => setPicker({ anchor: event.currentTarget, later: true, row: row() }))}>Later</Button>
        <Button aria-disabled={dis(busy())} onClick={unless(() => { void act(row(), 'resolve', null).catch(() => {}); })}>Resolve</Button>
        <Show when={row().question_status}><Button aria-disabled={dis(busy())} onClick={unless(event => openConfirmation(event.currentTarget, row(), 'keep_recurrent'))}>Keep recurrent</Button></Show>
      </div>}</Show>
      <Show when={outlines().length}><div class="revisit-outlines"><For each={outlines()}>{(entry, index) => <OutlineFrame entering={outlines().length > 1 && index() === 1} onReady={() => setOutlines(list => list.includes(entry) ? [entry] : list)} onPointerDown={() => { heldFocus = null; }} onFocusIn={keepQueueFocus}>
        <OutlinePane pane={props.pane} pageId={entry.pageId} notebook={props.notebook} active={props.active} onActivate={props.onActivate} onOpen={props.onOpen} vim={props.notebook.vim()} onVimMode={() => {}} commands={props.commands}
          view={{ zoom: entry.zoom, caret: null, scroll: null, folds: null, showArchived: false, depth: 'full' }} onViewChange={() => {}} />
      </OutlineFrame>}</For></div></Show>
    </Show>
    <Show keyed when={confirm()}>{state => <Popup anchor={state.anchor} label={state.action === 'revisited' ? 'Revisited' : 'Keep recurrent'} onDismiss={() => { if (!busy()) setConfirm(undefined); }}>
      <div class="revisit-confirm"><p>Next revisit</p><Button disabled={busy()} onClick={event => setPicker({ anchor: event.currentTarget, later: false, row: state.row })}>{next() ?? 'No revisit date'}</Button>
        <Button disabled={busy()} onClick={() => { void act(state.row, state.action, next()).catch(() => {}); }}>Confirm revisit</Button>
      </div>
    </Popup>}</Show>
    <Show keyed when={picker()}>{state => <DatePicker notebook={props.notebook} anchor={state.anchor} label="Set revisit date" presets="revisit" value={state.later ? state.row.revisit_on : next()} contextDate={props.notebook.todayDate()} onDismiss={() => setPicker(undefined)} onSelect={async value => { if (state.later) await act(state.row, 'later', value.date); else setNext(value.date); }} />}</Show>
  </div>;
}

/** The note an outline shows, captured when it was chosen so it stays whole after its row leaves the queue. */
interface Outline { id: string; pageId: string; zoom: string | null }

/** Holds one note's outline. While `entering` it loads hidden, and reports ready once it has rows (or has settled empty). */
function OutlineFrame(props: { entering: boolean; onReady(): void; onPointerDown(): void; onFocusIn(): void; children: JSX.Element }) {
  let frame!: HTMLDivElement;
  createEffect(() => {
    if (!props.entering) return;
    let animation = 0, settle = 0;
    const check = () => {
      cancelAnimationFrame(animation);
      animation = requestAnimationFrame(() => {
        if (frame.querySelector('[data-pane-pending]')) return;
        if (frame.querySelector('.outline-row')) props.onReady();
        else if (frame.querySelector('.outline-pane[aria-busy="false"]') && !settle) settle = window.setTimeout(props.onReady, 250);
      });
    };
    const observer = new MutationObserver(check);
    observer.observe(frame, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-pane-pending', 'aria-busy'] });
    // A note that never reports readiness must not hold the old one on screen.
    const limit = window.setTimeout(props.onReady, 1500);
    check();
    onCleanup(() => { cancelAnimationFrame(animation); clearTimeout(settle); clearTimeout(limit); observer.disconnect(); });
  });
  return <div ref={frame} class="revisit-outline" classList={{ 'revisit-outline-entering': props.entering }} onPointerDown={props.onPointerDown} onFocusIn={props.onFocusIn}>{props.children}</div>;
}
