import { For, Show, batch, createEffect, createMemo, createSignal, createUniqueId, onCleanup, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import type { TaskRow, TaskState, TaskStatus } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { calendarWeekDates, fetchWeekTaskRange, keyboardWeekSchedule, layoutWeekTimedEntries, mergeWeekTaskRows, mondayWeekStart, scheduleWeekTask, snapWeekMinutes, weekTaskEntries } from './week-calendar';
import type { IncompleteWeekRange, TimedWeekEntry, WeekEntry } from './week-calendar';
import './agenda.css';
import './week-calendar.css';

export interface WeekCalendarProps {
  date: string;
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}

interface OptimisticTask {
  row: TaskRow;
  pending: boolean;
  committedSequence: number | null;
}

interface WeekDrop {
  date: string;
  minutes: number | null;
}

interface WeekDrag {
  pointerId: number;
  row: TaskRow;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
}

const statusLabels: Record<TaskStatus, string> = { todo: 'Todo', doing: 'Doing', waiting: 'Waiting', done: 'Done', cancelled: 'Cancelled' };
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const scheduleKeys: Record<string, true> = { ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true, Home: true };

export function WeekCalendar(props: WeekCalendarProps) {
  const instructionsId = createUniqueId();
  const start = createMemo(() => mondayWeekStart(props.date));
  const dates = createMemo(() => calendarWeekDates(props.date));
  const [fetchedRows, setFetchedRows] = createSignal<TaskRow[]>([]);
  const [optimistic, setOptimistic] = createSignal(new Map<string, OptimisticTask>());
  const [incomplete, setIncomplete] = createSignal<IncompleteWeekRange[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [commandError, setCommandError] = createSignal('');
  const [announcement, setAnnouncement] = createSignal('');
  const [refresh, setRefresh] = createSignal(0);
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [drop, setDrop] = createSignal<WeekDrop | null>(null);
  let root!: HTMLElement;
  let scroll!: HTMLDivElement;
  let drag: WeekDrag | null = null;
  let dragFrame = 0;
  let suppressNextClick = false;
  let requestedStart: string | null = null;
  let initializedStart: string | null = null;
  let acknowledgedSequence = 0;
  let disposed = false;

  const rows = createMemo(() => {
    const byId = new Map(fetchedRows().map(row => [row.source.block.id, row]));
    for (const [id, value] of optimistic()) byId.set(id, value.row);
    return [...byId.values()];
  });
  const entries = createMemo(() => weekTaskEntries(rows(), dates()));
  const byKey = createMemo(() => new Map(entries().map(entry => [entry.key, entry])));
  const days = createMemo(() => dates().map(date => {
    const values = entries().filter(entry => entry.date === date);
    const timed = layoutWeekTimedEntries(values);
    return {
      date,
      allDay: values.filter(entry => entry.kind === 'due' || entry.time === null),
      timed,
      lanes: Math.max(1, ...timed.map(item => item.lanes)),
    };
  }));
  const sheetStyle = createMemo((): JSX.CSSProperties => ({
    '--week-columns': `var(--week-time-gutter) ${days().map(day => `minmax(calc(var(--week-day-min-width) * ${day.lanes}), 1fr)`).join(' ')}`,
    '--week-sheet-width': `calc(var(--week-time-gutter) + var(--week-day-min-width) * ${days().reduce((sum, day) => sum + day.lanes, 0)})`,
  }));
  const pendingCount = createMemo(() => [...optimistic().values()].filter(value => value.pending).length);
  const dropLabel = createMemo(() => {
    const target = drop();
    if (!target) return '';
    const time = target.minutes === null ? null : `${String(Math.floor(target.minutes / 60)).padStart(2, '0')}:${String(target.minutes % 60).padStart(2, '0')}`;
    return `${target.date}${time ? ` at ${time}` : ', all-day'}`;
  });

  createEffect(() => {
    const from = start();
    const through = dates().filter((date): date is string => date !== null).at(-1);
    const sequence = Math.max(props.notebook.changeSequence(), acknowledgedSequence);
    refresh();
    let current = true;
    setLoading(true); setError('');
    if (requestedStart !== from) {
      cancelDrag();
      setFetchedRows([]); setIncomplete([]);
      requestedStart = from;
    }
    if (!from || !through) { setError('Choose a valid calendar date.'); setLoading(false); return; }
    void Promise.all([
      fetchWeekTaskRange(value => props.notebook.api.taskQuery(value), 'scheduled', from, through),
      fetchWeekTaskRange(value => props.notebook.api.taskQuery(value), 'deadline', from, through),
    ]).then(([scheduled, deadline]) => {
      if (!current) return;
      batch(() => {
        setFetchedRows(mergeWeekTaskRows(scheduled.rows, deadline.rows));
        setIncomplete([...scheduled.incomplete, ...deadline.incomplete]);
        setOptimistic(previous => new Map([...previous].filter(([, value]) => value.pending || value.committedSequence !== null && value.committedSequence > sequence)));
        setLoading(false);
      });
      if (initializedStart !== from) {
        initializedStart = from;
        requestAnimationFrame(() => {
          if (!current || !scroll) return;
          const firstDay = root.querySelector<HTMLElement>('[data-week-drop="timed"]');
          if (!firstDay) return;
          const earliest = Math.min(8 * 60, ...untrack(days).flatMap(day => day.timed.map(item => item.minute)));
          scroll.scrollTop = earliest / (24 * 60) * firstDay.getBoundingClientRect().height;
        });
      }
    }).catch(reason => {
      if (current) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    onCleanup(() => { current = false; });
  });

  function focusTask(id: string, kind: WeekEntry['kind']) {
    queueMicrotask(() => {
      if (disposed) return;
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-week-task]')];
      const target = buttons.find(button => button.dataset.weekTask === id && button.dataset.weekKind === kind)
        ?? buttons.find(button => button.dataset.weekTask === id);
      if (target) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } else root.focus({ preventScroll: true });
    });
  }

  async function reschedule(row: TaskRow, task: TaskState, restoreFocus: WeekEntry['kind'] | null) {
    const id = row.source.block.id;
    if (optimistic().get(id)?.pending || task.scheduled === row.task.scheduled && task.scheduled_time === row.task.scheduled_time) return;
    const previous = optimistic().get(id);
    setCommandError('');
    setOptimistic(values => new Map(values).set(id, { row: { ...row, task }, pending: true, committedSequence: null }));
    if (restoreFocus) focusTask(id, restoreFocus);
    const label = `${task.scheduled}${task.scheduled_time ? ` at ${task.scheduled_time}` : ', all-day'}`;
    setAnnouncement(`Saving schedule for ${row.source.block.text || 'Empty task'}: ${label}.`);
    try {
      const result = await props.notebook.commit([{ op: 'set_task', id, base_revision: row.source.block.revision, task }], `Reschedule task to ${label}`);
      acknowledgedSequence = Math.max(acknowledgedSequence, result.seq);
      if (disposed) return;
      const revision = result.revisions.find(value => value.id === id)?.revision ?? row.source.block.revision;
      setOptimistic(values => new Map(values).set(id, {
        row: { ...row, source: { ...row.source, block: { ...row.source.block, revision } }, task },
        pending: false, committedSequence: result.seq,
      }));
      setAnnouncement(`Scheduled ${row.source.block.text || 'Empty task'} for ${label}.`);
      setRefresh(value => value + 1);
    } catch (reason) {
      if (disposed) return;
      setOptimistic(values => {
        const next = new Map(values);
        if (previous) next.set(id, previous); else next.delete(id);
        return next;
      });
      setCommandError(`Could not reschedule ${row.source.block.text || 'this task'}: ${reason instanceof Error ? reason.message : String(reason)}. The previous schedule was restored.`);
      setAnnouncement('');
      if (restoreFocus) focusTask(id, restoreFocus);
    }
  }

  function taskKeyDown(event: KeyboardEvent, entry: WeekEntry) {
    if (!event.altKey || event.ctrlKey || event.metaKey || !scheduleKeys[event.key]) return;
    event.preventDefault(); event.stopPropagation();
    if (drag || optimistic().get(entry.row.source.block.id)?.pending) return;
    const task = keyboardWeekSchedule(entry.row.task, entry.date, event.key);
    if (!task) { setCommandError('The scheduled date must stay between 0001-01-01 and 9999-12-31.'); return; }
    void reschedule(entry.row, task, entry.kind);
  }

  function updateDrop() {
    if (!drag?.active) return;
    const element = document.elementFromPoint(drag.x, drag.y)?.closest<HTMLElement>('[data-week-drop]');
    const date = element?.dataset.weekDate;
    if (!element || !date || !root.contains(element)) { setDrop(null); return; }
    if (element.dataset.weekDrop === 'all-day') { setDrop({ date, minutes: null }); return; }
    const rect = element.getBoundingClientRect();
    setDrop({ date, minutes: snapWeekMinutes((drag.y - rect.top) / rect.height * 24 * 60) });
  }

  function advanceDrag() {
    if (!drag?.active) return;
    const rect = scroll.getBoundingClientRect();
    const style = getComputedStyle(root);
    const edge = parseFloat(style.getPropertyValue('--space-24'));
    const step = parseFloat(style.getPropertyValue('--space-16'));
    const inside = drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom;
    if (inside) {
      if (drag.y < rect.top + edge) scroll.scrollTop -= step;
      else if (drag.y > rect.bottom - edge) scroll.scrollTop += step;
      if (drag.x < rect.left + edge) scroll.scrollLeft -= step;
      else if (drag.x > rect.right - edge) scroll.scrollLeft += step;
    }
    updateDrop();
    dragFrame = requestAnimationFrame(advanceDrag);
  }

  function pointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.active) {
      const threshold = parseFloat(getComputedStyle(root).getPropertyValue('--week-drag-threshold'));
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < threshold) return;
      drag.active = true;
      root.setPointerCapture(event.pointerId);
      setDraggingId(drag.row.source.block.id);
      dragFrame = requestAnimationFrame(advanceDrag);
    }
    event.preventDefault();
    updateDrop();
  }

  function finishDrag() {
    const previous = drag;
    drag = null;
    cancelAnimationFrame(dragFrame);
    document.removeEventListener('pointermove', pointerMove);
    document.removeEventListener('pointerup', pointerUp);
    document.removeEventListener('pointercancel', pointerCancel);
    document.removeEventListener('keydown', dragKeyDown, true);
    if (previous?.active) suppressNextClick = true;
    if (previous && root.hasPointerCapture(previous.pointerId)) root.releasePointerCapture(previous.pointerId);
    batch(() => { setDraggingId(null); setDrop(null); });
    return previous;
  }

  function cancelDrag() {
    const previous = finishDrag();
    if (previous?.active) setAnnouncement('Schedule drag cancelled.');
  }

  function pointerUp(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    updateDrop();
    const target = drop();
    const previous = finishDrag();
    if (!previous?.active) return;
    event.preventDefault();
    if (target) void reschedule(previous.row, scheduleWeekTask(previous.row.task, target.date, target.minutes), null);
    else setAnnouncement('Schedule unchanged. Drop on an all-day column or a time slot to reschedule.');
  }

  function pointerCancel(event: PointerEvent) {
    if (drag?.pointerId === event.pointerId) cancelDrag();
  }

  function dragKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    cancelDrag();
  }

  function beginDrag(event: PointerEvent, entry: WeekEntry) {
    if (!event.isPrimary || event.button !== 0 || drag || optimistic().get(entry.row.source.block.id)?.pending) return;
    suppressNextClick = false;
    drag = { pointerId: event.pointerId, row: entry.row, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
    document.addEventListener('pointermove', pointerMove, { passive: false });
    document.addEventListener('pointerup', pointerUp);
    document.addEventListener('pointercancel', pointerCancel);
    document.addEventListener('keydown', dragKeyDown, true);
  }

  onCleanup(() => { disposed = true; finishDrag(); });

  return <section ref={root} class="week-calendar" aria-label={`Week of ${start() ?? props.date}`} aria-busy={loading()} tabIndex={-1}
    onLostPointerCapture={event => { if (drag?.pointerId === event.pointerId) cancelDrag(); }}
    on:click={{ capture: true, handleEvent: event => {
      if (event.detail > 0 && suppressNextClick) {
        suppressNextClick = false;
        event.preventDefault(); event.stopPropagation();
      }
    } }}>
    <p id={instructionsId} class="week-calendar-instructions">Drag a task to reschedule it. <span class="visually-hidden">Alt+←/→ changes day. Alt+↑/↓ changes time by 15 min. Alt+Home makes all-day. Enter opens; Shift opens beside. Esc cancels a drag. Due cards change the schedule, not the deadline.</span></p>
    <Show when={error()}><div class="agenda-error" role="alert"><span>Could not load this week: {error()}</span><Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
    <Show when={commandError()}><div class="agenda-error" role="alert"><span>{commandError()}</span><Button onClick={() => { setCommandError(''); setRefresh(value => value + 1); }}>Refresh</Button></div></Show>
    <Show when={!loading() && !error() && !entries().length}><p class="agenda-message">No scheduled tasks or deadlines this week. Schedule a task from its source to see it here.</p></Show>
    <Show when={incomplete().length}><div class="agenda-error" role="status"><span>Some days exceed the task API limit. Not all planned tasks are shown.</span><ul><For each={incomplete()}>{range => <li>{range.date}: {range.shown} of {range.total} {statusLabels[range.status].toLocaleLowerCase()} {range.field === 'scheduled' ? 'scheduled tasks' : 'deadlines'} shown.</li>}</For></ul></div></Show>
    <p class="week-calendar-feedback" aria-live="polite" aria-atomic="true">{draggingId() ? drop() ? `Drop to schedule for ${dropLabel()}.` : 'Drop on an all-day column or a time slot.' : pendingCount() ? `Saving ${pendingCount() === 1 ? 'schedule' : `${pendingCount()} schedules`}…` : loading() ? fetchedRows().length ? 'Refreshing week…' : 'Loading scheduled tasks and deadlines…' : announcement()}</p>
    <div ref={scroll} class="week-calendar-scroll" style={sheetStyle()} onScroll={updateDrop}>
      <div class="week-calendar-sheet">
        <div class="week-calendar-top">
          <div class="week-calendar-header"><span class="week-calendar-corner">24-hour</span><For each={dates()}>{(date, index) => <div class="week-calendar-day-header" classList={{ 'week-calendar-today': date === props.notebook.todayDate(), 'week-calendar-selected': date === props.date }} aria-current={date === props.notebook.todayDate() ? 'date' : undefined}>
            <span>{weekdays[index()]}</span><strong>{date ? new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'Unavailable'}</strong>
          </div>}</For></div>
          <div class="week-calendar-all-day"><span class="week-calendar-corner">All-day<br />and due</span><For each={dates()}>{(date, index) => {
            const keys = createMemo(() => days()[index()]!.allDay.map(entry => entry.key));
            return <div class="week-calendar-all-day-column" data-week-drop={date ? 'all-day' : undefined} data-week-date={date ?? undefined} classList={{ 'week-calendar-drop': drop()?.date === date && drop()?.minutes === null }} aria-label={date ? `All-day tasks and deadlines for ${date}` : 'Outside supported dates'}>
              <Show when={!keys().length}><span class="week-calendar-empty-day">{date ? 'No all-day tasks' : 'Outside supported dates'}</span></Show>
              <For each={keys()}>{key => {
                const initial = byKey().get(key)!;
                return <WeekTaskCard entry={byKey().get(key) ?? initial} notebook={props.notebook} instructionsId={instructionsId} busy={!!optimistic().get(initial.row.source.block.id)?.pending} dragging={draggingId() === initial.row.source.block.id} onOpen={props.onOpen} onPointerDown={beginDrag} onKeyDown={taskKeyDown} />;
              }}</For>
            </div>;
          }}</For></div>
        </div>
        <div class="week-calendar-timeline">
          <div class="week-calendar-hours" aria-hidden="true"><For each={Array.from({ length: 24 }, (_, hour) => hour)}>{hour => <span style={{ top: `calc(var(--week-hour-height) * ${hour})` }}>{String(hour).padStart(2, '0')}:00</span>}</For></div>
          <For each={dates()}>{(date, index) => {
            const timedByKey = createMemo(() => new Map(days()[index()]!.timed.map(item => [item.entry.key, item])));
            const keys = createMemo(() => [...timedByKey().keys()]);
            return <div class="week-calendar-time-column" data-week-drop={date ? 'timed' : undefined} data-week-date={date ?? undefined} aria-label={date ? `Timed tasks for ${date}` : 'Outside supported dates'}>
              <For each={keys()}>{key => {
                const initial = timedByKey().get(key)!;
                return <WeekTaskCard entry={byKey().get(key) ?? initial.entry} position={timedByKey().get(key) ?? initial} notebook={props.notebook} instructionsId={instructionsId} busy={!!optimistic().get(initial.entry.row.source.block.id)?.pending} dragging={draggingId() === initial.entry.row.source.block.id} onOpen={props.onOpen} onPointerDown={beginDrag} onKeyDown={taskKeyDown} />;
              }}</For>
              <Show when={drop()?.date === date && drop()?.minutes !== null && drop()?.minutes !== undefined}><div class="week-calendar-drop-preview" aria-hidden="true" style={{ top: `calc(var(--week-hour-height) * ${(drop()?.minutes ?? 0) / 60})` }}>{dropLabel()}</div></Show>
            </div>;
          }}</For>
        </div>
      </div>
    </div>
  </section>;
}

function WeekTaskCard(props: {
  entry: WeekEntry;
  position?: TimedWeekEntry;
  notebook: NotebookClient;
  instructionsId: string;
  busy: boolean;
  dragging: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onPointerDown(event: PointerEvent, entry: WeekEntry): void;
  onKeyDown(event: KeyboardEvent, entry: WeekEntry): void;
}) {
  const completed = createMemo(() => props.entry.row.task.status === 'done' || props.entry.row.task.status === 'cancelled');
  const late = createMemo(() => !completed() && props.entry.date < props.notebook.todayDate());
  const label = createMemo(() => `${props.entry.row.source.block.text || 'Empty task'}, ${statusLabels[props.entry.row.task.status]}, ${props.entry.kind === 'due' ? 'due' : 'scheduled'} ${props.entry.date}${props.entry.time ? ` at ${props.entry.time}` : ', all-day'}${props.entry.due && props.entry.kind !== 'due' ? `, due${props.entry.row.task.deadline_time ? ` at ${props.entry.row.task.deadline_time}` : ''}` : ''}${late() ? ', overdue' : ''}, source ${props.entry.row.source.page.text}`);
  const position = createMemo((): JSX.CSSProperties | undefined => {
    const value = props.position;
    if (!value) return undefined;
    return {
      top: `calc(var(--week-hour-height) * ${value.minute / 60})`,
      left: `calc(100% / ${value.lanes} * ${value.lane} + var(--space-2))`,
      width: `calc(100% / ${value.lanes} - var(--space-4))`,
    };
  });
  return <button type="button" class="week-calendar-task" classList={{ 'week-calendar-task-timed': !!props.position, 'week-calendar-task-done': completed(), 'week-calendar-task-late': late(), 'week-calendar-task-dragging': props.dragging }}
    style={position()} data-week-task={props.entry.row.source.block.id} data-week-kind={props.entry.kind} data-week-status={props.entry.row.task.status} aria-label={label()} aria-describedby={props.instructionsId} aria-busy={props.busy} title={`${label()} · Shift to open beside`}
    onPointerDown={event => props.onPointerDown(event, props.entry)} onKeyDown={event => props.onKeyDown(event, props.entry)}
    onClick={event => props.onOpen({ kind: 'page', pageId: props.entry.row.source.page.id, blockId: props.entry.row.source.block.id }, event.shiftKey)}>
    <span class="week-calendar-task-meta"><Show when={completed()}><Icon name={props.entry.row.task.status === 'cancelled' ? 'close' : 'check'} /></Show><Show when={props.entry.due}>Due{props.entry.row.task.deadline_time ? ` ${props.entry.row.task.deadline_time}` : ''}</Show><Show when={!props.entry.due}>{props.entry.time ?? statusLabels[props.entry.row.task.status]}</Show></span>
    <span class="week-calendar-task-text"><BlockText text={props.entry.row.source.block.text || 'Empty task'} notebook={props.notebook} interactive={false} /></span>
  </button>;
}
