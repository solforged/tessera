import { For, Show, createEffect, createMemo, createRoot, createSignal, createUniqueId, onCleanup, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import { ApiError } from '../api/client';
import type { Agenda, AgendaItem, TaskRow, WorkSession } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { statusIcons, statusLabels } from './TaskControls';
import { groupAgenda, isFinished, taskFacts } from './task-labels';
import './agenda.css';

export interface JournalAgendaProps {
  date: string;
  /** The journal root; its own tasks are already visible in the outline below. */
  pageId: string;
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}

const collapsedKey = 'tessera.journal-agenda.collapsed';
const JOURNAL_AGENDA_ROWS = 12;
// One device preference shared by every journal pane.
const [collapsed, setCollapsedSignal] = createRoot(() => createSignal((() => { try { return localStorage.getItem(collapsedKey) === '1'; } catch { return false; } })()));
const setCollapsed = (value: boolean) => {
  setCollapsedSignal(value);
  try { if (value) localStorage.setItem(collapsedKey, '1'); else localStorage.removeItem(collapsedKey); } catch { /* The preference lasts for this tab. */ }
};

export function JournalAgenda(props: JournalAgendaProps) {
  const id = createUniqueId();
  const [agenda, setAgenda] = createSignal<Agenda>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [refresh, setRefresh] = createSignal(0);
  createEffect(() => {
    const date = props.date;
    props.notebook.changeSequence(); refresh();
    let current = true;
    setLoading(true); setError('');
    if (untrack(agenda)?.date !== date) setAgenda(undefined);
    void props.notebook.api.agenda(date).then(value => {
      if (current) { setAgenda(value); setLoading(false); }
    }).catch(reason => {
      if (current) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    onCleanup(() => { current = false; });
  });
  const items = createMemo(() => agenda()?.items ?? []);
  // The day's own tasks are already in the outline below; they only change the empty wording.
  const here = createMemo(() => items().some(item => item.source.page.id === props.pageId && !item.reasons.includes('unplanned')));
  const summary = createMemo(() => {
    const { overdue, planned, done } = groupAgenda(items(), props.date, props.pageId);
    const open = overdue.length + planned.length;
    return [
      ...open ? [{ text: `${open} to do` }] : [],
      ...overdue.length ? [{ text: `${overdue.length} overdue`, late: true }] : [],
      ...done.length ? [{ text: `${done.length} done` }] : [],
    ];
  });
  return <section class="journal-agenda" aria-label="Agenda">
    <Button class="journal-agenda-toggle" aria-expanded={!collapsed()} aria-controls={id} onClick={() => setCollapsed(!collapsed())}>
      <span class="journal-section-name">Agenda</span><span class="section-rule" />
      <span class="agenda-summary">{loading() && !agenda() ? 'Loading…' : summary().length ? <For each={summary()}>{(part, index) => <>{index() ? ' · ' : ''}<span classList={{ 'agenda-late': !!part.late }}>{part.text}</span></>}</For> : here() ? 'Nothing else planned' : 'Nothing planned'}</span><Icon name="down" />
    </Button>
    <Show when={!collapsed()}><div id={id} class="journal-agenda-body" aria-busy={loading()}>
      <Show when={error()}><div class="agenda-error" role="alert"><span>{error()}</span><Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
      <AgendaSections items={items()} date={props.date} pageId={props.pageId} skipPageId={props.pageId} notebook={props.notebook} disabled={loading() || !!error()} cap={JOURNAL_AGENDA_ROWS} onOpen={props.onOpen} onChanged={() => setRefresh(value => value + 1)} />
    </div></Show>
  </section>;
}

/**
 * The agenda in the order a day is worked: Overdue, then the day's plans and work in progress, then collapsed Unplanned
 * and Done groups. The journal and the Agenda pane render the same sections.
 */
export function AgendaSections(props: {
  items: readonly AgendaItem[];
  date: string;
  /** Omit the source page label for rows from this page. */
  pageId?: string;
  /** Leave out rows from this page, such as the journal whose outline already shows them. */
  skipPageId?: string;
  notebook: NotebookClient;
  disabled?: boolean;
  /** Rows shown per group before Show N more. */
  cap?: number;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const groups = createMemo(() => groupAgenda(props.items, props.date, props.skipPageId));
  const [showUnplanned, setShowUnplanned] = createSignal(false);
  const [showDone, setShowDone] = createSignal(false);
  // Getters keep each group's rows mounted while the agenda refreshes, so a row's pending state survives.
  const rowProps = { get cap() { return props.cap; }, get date() { return props.date; }, get pageId() { return props.pageId; }, get notebook() { return props.notebook; }, get disabled() { return props.disabled; }, onOpen: (target: OpenTarget, beside: boolean) => props.onOpen(target, beside), onChanged: () => props.onChanged() };
  return <>
    <Show when={groups().overdue.length}>
      <AgendaHeading name="Overdue" count={groups().overdue.length} late />
      <CappedTaskRows rows={groups().overdue} {...rowProps} />
    </Show>
    <Show when={groups().planned.length}>
      <Show when={groups().overdue.length}><AgendaHeading name={props.date === props.notebook.todayDate() ? 'Today' : 'Planned'} count={groups().planned.length} /></Show>
      <CappedTaskRows rows={groups().planned} {...rowProps} />
    </Show>
    <Show when={groups().unplanned.length}>
      <AgendaHeading name="Unplanned" count={groups().unplanned.length} expanded={showUnplanned()} onToggle={() => setShowUnplanned(value => !value)} />
      <Show when={showUnplanned()}><CappedTaskRows rows={groups().unplanned} {...rowProps} /></Show>
    </Show>
    <Show when={groups().done.length}>
      <AgendaHeading name="Done" count={groups().done.length} expanded={showDone()} onToggle={() => setShowDone(value => !value)} />
      <Show when={showDone()}><CappedTaskRows rows={groups().done} {...rowProps} /></Show>
    </Show>
  </>;
}

/** A group heading like the journal's sections: name, hairline, count; collapsible groups add the chevron. */
function AgendaHeading(props: { name: string; count: number; late?: boolean; expanded?: boolean; onToggle?(): void }): JSX.Element {
  const content = <><span class="journal-section-name">{props.name}</span><span class="section-rule" /><span class="agenda-summary" classList={{ 'agenda-late': props.late }}>{props.count}</span></>;
  return <Show when={props.onToggle} fallback={<div class="journal-agenda-toggle agenda-group-heading">{content}</div>}>
    <Button class="journal-agenda-toggle agenda-group-heading" aria-expanded={!!props.expanded} onClick={() => props.onToggle?.()}>{content}<Icon name="down" /></Button>
  </Show>;
}

/** A day with hundreds of overdue tasks would otherwise push the journal's own blocks out of view. */
function CappedTaskRows(props: Parameters<typeof TaskSourceRows>[0] & { cap?: number }) {
  const [all, setAll] = createSignal(false);
  const cap = () => props.cap ?? Infinity;
  return <>
    <TaskSourceRows {...props} rows={all() ? props.rows : props.rows.slice(0, cap())} />
    <Show when={props.rows.length > cap()}><Button class="journal-agenda-more" onClick={() => setAll(value => !value)}>{all() ? 'Show fewer' : `Show ${props.rows.length - cap()} more`}</Button></Show>
  </>;
}

/** Resolves once an opened document has loaded; rejects when it is missing or failed. */
export function documentReady(doc: PageDocument): Promise<void> {
  const ready = Promise.withResolvers<void>();
  createRoot(dispose => {
    createEffect(() => {
      const status = doc.status();
      if (status === 'ready') { dispose(); ready.resolve(); }
      else if (status !== 'loading') { dispose(); ready.reject(new Error(doc.statusMessage())); }
    });
  });
  return ready.promise;
}

/** Agenda and task queries render the same canonical source, never journal copies. */
export function TaskSourceRows(props: {
  rows: readonly (TaskRow | AgendaItem)[];
  date: string;
  /** Omit the source page label for rows from this page. */
  pageId?: string;
  notebook: NotebookClient;
  disabled?: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const byId = createMemo(() => new Map(props.rows.map(row => [row.source.block.id, row])));
  const ids = createMemo(() => [...byId().keys()]);
  return <ul class="agenda-rows"><For each={ids()}>{id => {
    const initial = byId().get(id)!;
    return <TaskSourceRow row={byId().get(id) ?? initial} date={props.date} pageId={props.pageId} notebook={props.notebook} disabled={props.disabled} onOpen={props.onOpen} onChanged={props.onChanged} />;
  }}</For></ul>;
}

function TaskSourceRow(props: {
  row: TaskRow | AgendaItem;
  date: string;
  pageId?: string;
  notebook: NotebookClient;
  disabled?: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onChanged(): void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [running, setRunning] = createSignal<{ anchor: HTMLElement; session: WorkSession; date: string; row: TaskRow | AgendaItem } | null>(null);
  const historical = () => 'reasons' in props.row && props.row.reasons.includes('recently_completed');
  const unfinished = () => !historical() && !isFinished(props.row.task);
  const facts = createMemo(() => historical() ? [] : taskFacts(props.row.task, { date: props.date, today: props.notebook.todayDate(), listed: 'reasons' in props.row, timeShown: 'time' in props.row && !!props.row.time }));
  /** Opens the canonical source, runs one edit on its task block and saves it. */
  const editSource = async (row: TaskRow | AgendaItem, edit: (doc: PageDocument) => Promise<boolean | void>) => {
    if (busy() || props.disabled) return;
    setBusy(true); setError('');
    const doc = props.notebook.open(row.source.page.id);
    try {
      await documentReady(doc);
      if (await edit(doc) === false) return;
      await doc.flush();
      setRunning(null);
      props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      doc.release();
      setBusy(false);
    }
  };
  const complete = (anchor: HTMLElement, date: string, stopWork?: WorkSession, row = props.row) => editSource(row, async doc => {
    let active: WorkSession | null | undefined;
    if (props.notebook.connection() !== 'offline') {
      try { active = await props.notebook.api.activeWorkSession(); }
      catch (reason) { if (!(reason instanceof ApiError) || !reason.uncertain) throw reason; }
    }
    const source = doc.block(row.source.block.id);
    if (!source?.task || source.revision !== row.source.block.revision || isFinished(source.task)) {
      throw new Error('This task changed. Refresh or open its source before completing it.');
    }
    if (active?.block_id === source.id && (!stopWork || stopWork.id !== active.id || stopWork.revision !== active.revision)) {
      setRunning({ anchor, session: active, date, row });
      return false;
    }
    const stopping = active === undefined ? stopWork : active?.block_id === source.id ? stopWork : undefined;
    const result = doc.edit({ kind: 'completeTask', id: source.id, completedOn: date, ...(stopping ? { stopWork: stopping } : {}) });
    if (!result.ok) throw new Error(result.reason);
  });
  const reopen = () => editSource(props.row, async doc => {
    const source = doc.block(props.row.source.block.id);
    if (!source?.task || source.revision !== props.row.source.block.revision || !isFinished(source.task)) {
      throw new Error('This task changed. Refresh or open its source before reopening it.');
    }
    const result = doc.edit({ kind: 'task', id: source.id, value: { ...source.task, status: 'todo', completed_on: null } });
    if (!result.ok) throw new Error(result.reason);
  });
  return <li class="agenda-row" classList={{ 'agenda-row-completed': historical() || props.row.task.status === 'done', 'agenda-row-cancelled': !historical() && props.row.task.status === 'cancelled' }} aria-busy={busy()}>
    <Show when={!historical()} fallback={<span class="agenda-status task-status-button" data-status="done" aria-label="Done"><Icon name="check" /></span>}>
      <Button class="agenda-status task-status-button" data-status={props.row.task.status} label={`${unfinished() ? 'Complete' : 'Reopen'} task (${statusLabels[props.row.task.status]}): ${props.row.source.block.text}`} title={unfinished() ? `Complete on ${props.date}` : 'Reopen task'} disabled={busy() || props.disabled}
        onClick={event => { void (unfinished() ? complete(event.currentTarget, props.date) : reopen()); }}><Icon name={statusIcons[props.row.task.status]} /></Button>
    </Show>
    <button type="button" class="agenda-source" onClick={event => props.onOpen({ kind: 'page', pageId: props.row.source.page.id, blockId: props.row.source.block.id }, event.shiftKey)} title="Open source · Shift to open beside">
      <span class="agenda-source-text"><BlockText text={props.row.source.block.text || 'Empty task'} notebook={props.notebook} interactive={false} /></span>
      <Show when={props.row.source.page.id !== props.pageId}><span class="agenda-source-page">{props.row.source.page.text}</span></Show>
    </button>
    <span class="agenda-row-meta">
      <Show when={'time' in props.row && props.row.time}><span class="agenda-time">{'time' in props.row ? props.row.time : null}</span></Show>
      <For each={facts()}>{fact => <span classList={{ 'agenda-late': !!fact.late }} title={fact.label}>{fact.text}</span>}</For>
    </span>
    <Show when={busy()}><p class="agenda-message" role="status">Saving… <Show when={props.notebook.saveState() !== 'saved'}>{props.notebook.saveMessage() || props.notebook.saveState()}</Show></p></Show>
    <Show when={error()}><div class="agenda-error" role="alert"><span>{error()}</span><Button onClick={props.onChanged}>Refresh</Button></div></Show>
    <Show keyed when={running()}>{state => <Popup anchor={state.anchor} label="Stop work and complete?" onDismiss={() => { if (!busy()) setRunning(null); }}>
      <p>Stop work and complete this task on {state.date}?</p>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions"><Button disabled={busy()} onClick={() => setRunning(null)}>Cancel</Button><Button class="bordered" disabled={busy() || props.disabled} onClick={() => { void complete(state.anchor, state.date, state.session, state.row); }}>Stop and complete</Button></div>
    </Popup>}</Show>
  </li>;
}
