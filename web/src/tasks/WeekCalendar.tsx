import { For, Show, batch, createEffect, createMemo, createSignal, createUniqueId, onCleanup, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import type { TaskRow, TaskState } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget } from '../shell/contract';
import { besideHint, besideKey, opensBeside } from '../shell/beside';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { statusIcons, statusLabels } from './TaskControls';
import { groupAgenda, isFinished } from './task-labels';
import { createClock } from './clock';
import { calendarWeekDates, fetchWeekTaskRange, keyboardWeekSchedule, layoutWeekTimedEntries, mergeWeekTaskRows, mondayWeekStart, scheduleWeekTask, snapWeekMinutes, timeMinutes, weekTaskEntries } from './week-calendar';
import type { IncompleteWeekRange, TimedWeekEntry, WeekEntry } from './week-calendar';
import { WeekScheduleHistory } from './week-schedule';
import type { ScheduledWeekTask } from './week-schedule';
import './agenda.css';
import './week-calendar.css';

export interface WeekCalendarProps {
  date: string;
  showAllHours: boolean;
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
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

interface CalendarEntry extends WeekEntry {
  overdue?: boolean;
}

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const scheduleKeys: Record<string, true> = { ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true, Home: true };

export function WeekCalendar(props: WeekCalendarProps) {
  const instructionsId = createUniqueId();
  const start = createMemo(() => mondayWeekStart(props.date));
  const dates = createMemo(() => calendarWeekDates(props.date));
  const clock = createClock(props.notebook);
  const nowMinute = createMemo(() => timeMinutes(clock()));
  const [fetchedRows, setFetchedRows] = createSignal<TaskRow[]>([]);
  const [optimistic, setOptimistic] = createSignal(new Map<string, ScheduledWeekTask>());
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
  // A moved card can leave the grid; the calendar then keeps keyboard ownership of the same task.
  let keyboardTarget: WeekEntry | null = null;
  const history = new WeekScheduleHistory(props.notebook, (id, value) => {
    if (disposed) return;
    if (value.committedSequence !== null) acknowledgedSequence = Math.max(acknowledgedSequence, value.committedSequence);
    setOptimistic(values => new Map(values).set(id, value));
    if (keyboardTarget?.row.source.block.id === id) keyboardTarget = { ...keyboardTarget, row: value.row };
    if (value.pending) focusTask(id, 'scheduled');
    else {
      const task = value.row.task;
      const label = `${task.scheduled}${task.scheduled_time ? ` at ${task.scheduled_time}` : ', all-day'}`;
      setAnnouncement(`Scheduled ${value.row.source.block.text || 'Empty task'} for ${label}.`);
      setRefresh(value => value + 1);
    }
  });

  const rows = createMemo(() => {
    const byId = new Map(fetchedRows().map(row => [row.source.block.id, row]));
    for (const [id, value] of optimistic()) byId.set(id, value.row);
    return [...byId.values()];
  });
  const entries = createMemo<CalendarEntry[]>(() => {
    const today = props.notebook.todayDate();
    const first = start();
    const overdue = dates().includes(today) && first ? rows().filter(row => row.task.status !== null && !isFinished(row.task)
      && (!!row.task.scheduled && row.task.scheduled < first || !!row.task.deadline && row.task.deadline < first)) : [];
    const overdueIds = new Set(overdue.map(row => row.source.block.id));
    return [
      ...weekTaskEntries(rows(), dates()).filter(entry => entry.date !== today || entry.kind === 'scheduled' && entry.time !== null || !overdueIds.has(entry.row.source.block.id)),
      ...overdue.map(row => ({ key: `overdue:${row.source.block.id}`, row, date: today, kind: 'scheduled' as const, time: null, due: !!row.task.deadline && row.task.deadline < today, overdue: true })),
    ];
  });
  const byKey = createMemo(() => new Map(entries().map(entry => [entry.key, entry])));
  const days = createMemo(() => dates().map(date => {
    const values = entries().filter(entry => entry.date === date);
    const timed = layoutWeekTimedEntries(values);
    return {
      date,
      allDay: values.filter(entry => entry.kind === 'due' || entry.time === null),
      timed,
    };
  }));
  const hours = createMemo(() => {
    if (props.showAllHours) return { start: 0, end: 24 };
    const timed = days().flatMap(day => day.timed.map(item => item.minute));
    return {
      start: Math.floor(Math.min(6 * 60, ...timed) / 60),
      end: Math.min(24, Math.max(22, ...timed.map(minute => Math.floor(minute / 60) + 1))),
    };
  });
  const sheetStyle = createMemo((): JSX.CSSProperties => ({
    '--week-columns': 'var(--week-time-gutter) repeat(7, minmax(0, 1fr))',
    '--week-grid-height': `calc(${hours().end - hours().start} * var(--week-hour-height))`,
    '--week-start-minute': hours().start * 60,
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
    const visibleDates = dates().filter((date): date is string => date !== null);
    const through = visibleDates.at(-1);
    const today = props.notebook.todayDate();
    const sequence = Math.max(props.notebook.changeSequence(), acknowledgedSequence);
    refresh();
    let current = true;
    setLoading(true); setError('');
    if (requestedStart !== from) {
      keyboardTarget = null;
      cancelDrag();
      setFetchedRows([]); setIncomplete([]);
      requestedStart = from;
    }
    if (!from || !through) { setError('Choose a valid calendar date.'); setLoading(false); return; }
    void Promise.all([
      fetchWeekTaskRange(value => props.notebook.api.taskQuery(value), 'scheduled', from, through),
      fetchWeekTaskRange(value => props.notebook.api.taskQuery(value), 'deadline', from, through),
      Promise.all(visibleDates.map(date => props.notebook.api.agenda(date))),
    ]).then(([scheduled, deadline, agendas]) => {
      if (!current) return;
      batch(() => {
        const appointments: TaskRow[] = agendas.flatMap(agenda => agenda.items.filter(item => item.task.status === null)
          .map(item => ({ source: item.source, task: item.task, project_id: item.project_id, section_id: null, section_text: null })));
        const todayAgenda = agendas[visibleDates.indexOf(today)];
        const overdue: TaskRow[] = todayAgenda ? groupAgenda(todayAgenda.items, today).overdue
          .map(item => ({ source: item.source, task: item.task, project_id: item.project_id, section_id: null, section_text: null })) : [];
        setFetchedRows(mergeWeekTaskRows(scheduled.rows, deadline.rows, appointments, overdue));
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
          const earliest = Math.max(untrack(hours).start * 60, Math.min(8 * 60, ...untrack(days).flatMap(day => day.timed.map(item => item.minute))));
          const range = untrack(hours);
          scroll.scrollTop = (earliest - range.start * 60) / ((range.end - range.start) * 60) * firstDay.getBoundingClientRect().height;
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

  async function reschedule(row: TaskRow, task: TaskState, restoreFocus: WeekEntry['kind']) {
    setCommandError('');
    try {
      const saving = history.schedule(row, task);
      focusTask(row.source.block.id, restoreFocus);
      await saving;
    } catch (reason) {
      if (!disposed) {
        setCommandError(`Could not reschedule ${row.source.block.text || 'this task'}: ${reason instanceof Error ? reason.message : String(reason)}.`);
        setAnnouncement('');
        focusTask(row.source.block.id, restoreFocus);
      }
    }
  }

  function historyKeyDown(event: KeyboardEvent) {
    if (event.target === root && keyboardTarget && taskKeyDown(event, keyboardTarget)) return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
    event.preventDefault(); event.stopPropagation();
    setCommandError('');
    void history.undo(event.shiftKey).catch(reason => {
      if (!disposed) setCommandError(`Could not restore the schedule: ${reason instanceof Error ? reason.message : String(reason)}.`);
    });
  }

  function taskKeyDown(event: KeyboardEvent, entry: WeekEntry): boolean {
    if (!event.altKey || event.ctrlKey || event.metaKey || !scheduleKeys[event.key]) return false;
    event.preventDefault(); event.stopPropagation();
    if (drag) return true;
    const row = history.latest(entry.row);
    keyboardTarget = { ...entry, row };
    const task = keyboardWeekSchedule(row.task, row.task.scheduled ?? entry.date, event.key);
    if (!task) { setCommandError('The scheduled date must stay between 0001-01-01 and 9999-12-31.'); return true; }
    void reschedule(row, task, entry.kind);
    return true;
  }

  function updateDrop() {
    if (!drag?.active) return;
    const element = document.elementFromPoint(drag.x, drag.y)?.closest<HTMLElement>('[data-week-drop]');
    const date = element?.dataset.weekDate;
    if (!element || !date || !root.contains(element)) { setDrop(null); return; }
    if (element.dataset.weekDrop === 'all-day') { setDrop({ date, minutes: null }); return; }
    const rect = element.getBoundingClientRect();
    setDrop({ date, minutes: snapWeekMinutes(hours().start * 60 + (drag.y - rect.top) / rect.height * (hours().end - hours().start) * 60) });
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
    if (target) void reschedule(previous.row, scheduleWeekTask(history.latest(previous.row).task, target.date, target.minutes), 'scheduled');
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
    onKeyDown={historyKeyDown}
    onLostPointerCapture={event => { if (drag?.pointerId === event.pointerId) cancelDrag(); }}
    on:click={{ capture: true, handleEvent: event => {
      if (event.detail > 0 && suppressNextClick) {
        suppressNextClick = false;
        event.preventDefault(); event.stopPropagation();
      }
    } }}>
    <p id={instructionsId} class="visually-hidden">Drag a task to reschedule it. Alt+←/→ changes day. Alt+↑/↓ changes time by 15 min. Alt+Home makes all-day. Enter opens; {besideKey}+Enter opens beside. Esc cancels a drag. Due cards change the schedule, not the deadline.</p>
    <Show when={error()}><div class="agenda-error" role="alert"><span>Could not load this week: {error()}</span><Button onClick={() => setRefresh(value => value + 1)}>Retry</Button></div></Show>
    <Show when={commandError()}><div class="agenda-error" role="alert"><span>{commandError()}</span><Button onClick={() => { setCommandError(''); setRefresh(value => value + 1); }}>Refresh</Button></div></Show>
    <Show when={!loading() && !error() && !entries().length}><p class="agenda-message">No scheduled tasks or deadlines this week. Schedule a task from its source to see it here.</p></Show>
    <Show when={incomplete().length}><div class="agenda-error" role="status"><span>Some days exceed the task API limit. Not all planned tasks are shown.</span><ul><For each={incomplete()}>{range => <li>{range.date}: {range.shown} of {range.total} {statusLabels[range.status].toLocaleLowerCase()} {range.field === 'scheduled' ? 'scheduled tasks' : 'deadlines'} shown.</li>}</For></ul></div></Show>
    <p class="week-calendar-feedback" aria-live="polite" aria-atomic="true">{draggingId() ? drop() ? `Drop to schedule for ${dropLabel()}.` : 'Drop on an all-day column or a time slot.' : pendingCount() ? `Saving ${pendingCount() === 1 ? 'schedule' : `${pendingCount()} schedules`}…` : loading() ? fetchedRows().length ? 'Refreshing week…' : 'Loading scheduled tasks and deadlines…' : announcement()}</p>
    <div ref={scroll} class="week-calendar-scroll" style={sheetStyle()} data-start-hour={hours().start} data-end-hour={hours().end} onScroll={updateDrop}>
      <div class="week-calendar-sheet">
        <div class="week-calendar-top">
          <div class="week-calendar-header"><span class="week-calendar-corner" title="24-hour time">24h</span><For each={dates()}>{(date, index) => <div class="week-calendar-day-header" classList={{ 'week-calendar-today': date === props.notebook.todayDate(), 'week-calendar-selected': date === props.date }} aria-current={date === props.notebook.todayDate() ? 'date' : undefined}>
            <span>{date ? `${weekdays[index()]} ${Number(date.slice(8, 10))}` : 'Unavailable'}</span>
          </div>}</For></div>
          <div class="week-calendar-all-day"><span class="week-calendar-corner" title="All-day tasks and deadlines">All day</span><For each={dates()}>{(date, index) => {
            const keys = createMemo(() => days()[index()]!.allDay.map(entry => entry.key));
            return <div class="week-calendar-all-day-column" data-week-drop={date ? 'all-day' : undefined} data-week-date={date ?? undefined} classList={{ 'week-calendar-drop': drop()?.date === date && drop()?.minutes === null }} aria-label={date ? `All-day tasks and deadlines for ${date}` : 'Outside supported dates'}>
              <Show when={!date}><span class="week-calendar-empty-day">Outside supported dates</span></Show>
              <For each={keys()}>{key => {
                const initial = byKey().get(key)!;
                return <WeekTaskCard entry={byKey().get(key) ?? initial} notebook={props.notebook} instructionsId={instructionsId} busy={!!optimistic().get(initial.row.source.block.id)?.pending} dragging={draggingId() === initial.row.source.block.id} onOpen={props.onOpen} onPointerDown={beginDrag} onKeyDown={taskKeyDown} />;
              }}</For>
            </div>;
          }}</For></div>
        </div>
        <div class="week-calendar-timeline">
          <div class="week-calendar-hours" aria-hidden="true"><For each={Array.from({ length: hours().end - hours().start + 1 }, (_, index) => hours().start + index)}>{hour => <span style={{ top: `calc(var(--week-hour-height) * ${hour - hours().start})` }}>{String(hour).padStart(2, '0')}:00</span>}</For></div>
          <For each={dates()}>{(date, index) => {
            const timedByKey = createMemo(() => new Map(days()[index()]!.timed.map(item => [item.entry.key, item])));
            const keys = createMemo(() => [...timedByKey().keys()]);
            return <div class="week-calendar-time-column" data-week-drop={date ? 'timed' : undefined} data-week-date={date ?? undefined} aria-label={date ? `Timed tasks for ${date}` : 'Outside supported dates'}>
              <For each={keys()}>{key => {
                const initial = timedByKey().get(key)!;
                return <WeekTaskCard entry={byKey().get(key) ?? initial.entry} position={timedByKey().get(key) ?? initial} notebook={props.notebook} instructionsId={instructionsId} busy={!!optimistic().get(initial.entry.row.source.block.id)?.pending} dragging={draggingId() === initial.entry.row.source.block.id} onOpen={props.onOpen} onPointerDown={beginDrag} onKeyDown={taskKeyDown} />;
              }}</For>
              <Show when={date === props.notebook.todayDate() && nowMinute() >= hours().start * 60 && nowMinute() <= hours().end * 60}><span class="agenda-now week-calendar-now" aria-hidden="true" style={{ top: `calc(var(--week-hour-height) * ${(nowMinute() - hours().start * 60) / 60})` }} /></Show>
              <Show when={drop()?.date === date && drop()?.minutes !== null && drop()?.minutes !== undefined}><div class="week-calendar-drop-preview" aria-hidden="true" style={{ top: `calc(var(--week-hour-height) * ${((drop()?.minutes ?? 0) - hours().start * 60) / 60})` }}>{dropLabel()}</div></Show>
            </div>;
          }}</For>
        </div>
      </div>
    </div>
  </section>;
}

function WeekTaskCard(props: {
  entry: CalendarEntry;
  position?: TimedWeekEntry;
  notebook: NotebookClient;
  instructionsId: string;
  busy: boolean;
  dragging: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onPointerDown(event: PointerEvent, entry: WeekEntry): void;
  onKeyDown(event: KeyboardEvent, entry: WeekEntry): void;
}) {
  const completed = createMemo(() => isFinished(props.entry.row.task));
  const late = createMemo(() => !completed() && (props.entry.overdue || props.entry.date < props.notebook.todayDate()));
  const label = createMemo(() => {
    const entry = props.entry;
    const task = entry.row.task;
    const plan = entry.overdue
      ? ['overdue', task.scheduled ? `scheduled ${task.scheduled}` : null, task.deadline ? `due ${task.deadline}` : null].filter(Boolean).join(', ')
      : `${entry.kind === 'due' ? 'due' : 'scheduled'} ${entry.date}${entry.time ? ` at ${entry.time}` : ', all-day'}${entry.due && entry.kind !== 'due' ? `, due${task.deadline_time ? ` at ${task.deadline_time}` : ''}` : ''}${late() ? ', overdue' : ''}`;
    return `${entry.row.source.block.text || 'Empty atom'}${task.status ? `, ${statusLabels[task.status]}` : ''}, ${plan}, source ${entry.row.source.page.text}`;
  });
  const position = createMemo((): JSX.CSSProperties | undefined => {
    const value = props.position;
    if (!value) return undefined;
    return {
      top: `calc(var(--week-hour-height) * (${value.minute} - var(--week-start-minute)) / 60)`,
      left: `calc(100% / ${value.lanes} * ${value.lane} + var(--space-2))`,
      width: `calc(100% / ${value.lanes} - var(--space-4))`,
      height: `min(calc(var(--week-hour-height) * ${value.heightMinutes} / 60 - var(--space-2)), var(--week-timed-card-height))`,
      '--week-task-title-lines': value.heightMinutes === 45 ? 2 : 1,
    };
  });
  return <button type="button" class="week-calendar-task" classList={{ 'week-calendar-task-timed': !!props.position, 'week-calendar-task-done': completed(), 'week-calendar-task-late': late(), 'week-calendar-task-dragging': props.dragging }}
    style={position()} data-week-task={props.entry.row.source.block.id} data-week-kind={props.entry.kind} data-week-status={props.entry.row.task.status} aria-label={label()} aria-describedby={props.instructionsId} aria-busy={props.busy} title={`${label()} · ${besideHint}`}
    onPointerDown={event => props.onPointerDown(event, props.entry)} onKeyDown={event => props.onKeyDown(event, props.entry)}
    onClick={event => props.onOpen({ kind: 'page', pageId: props.entry.row.source.page.id, blockId: props.entry.row.source.block.id }, opensBeside(event))}>
    <span class="week-calendar-task-meta"><Show when={props.entry.row.task.status}>{status => <Icon name={statusIcons[status()]} />}</Show><Show when={props.entry.overdue} fallback={<><Show when={props.entry.due}>Due{props.entry.row.task.deadline_time ? ` ${props.entry.row.task.deadline_time}` : ''}</Show><Show when={!props.entry.due && props.entry.time}>{props.entry.time}</Show></>}>Overdue</Show></span>
    <span class="week-calendar-task-text"><BlockText text={props.entry.row.source.block.text || 'Empty task'} notebook={props.notebook} interactive={false} /></span>
  </button>;
}
