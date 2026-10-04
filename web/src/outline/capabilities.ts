import { createSignal } from 'solid-js';
import { ApiError } from '../api/client';
import type { TaskState, TaskStatus, WorkSession } from '../api/types';
import type { Caret, Edit, NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import type { PopupAnchor } from '../ui/Popup';
import { matchFieldEntry } from '../table/query';
import { parseTaskDate } from '../tasks/date-input';

export const newTask = (): TaskState => ({ status: 'todo', scheduled: null, scheduled_time: null, deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: null, completed_on: null });

/** Ignore even unfinished references/code while the author is typing. */
function protectedDate(text: string, at: number): boolean {
  for (let cursor = 0; cursor < at;) {
    if (text[cursor] === '\\') { cursor += 2; continue; }
    if (text.startsWith('[[', cursor)) {
      cursor += 2;
      while (cursor < text.length && !text.startsWith(']]', cursor)) cursor += text[cursor] === '\\' ? 2 : 1;
      cursor = Math.min(text.length, cursor + 2);
      if (cursor > at) return true;
      continue;
    }
    const marker = text[cursor];
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
    const fenceStart = /^[ ]{0,3}$/.test(text.slice(lineStart, cursor));
    if (marker !== '`' && !(marker === '~' && fenceStart)) { cursor++; continue; }
    let end = cursor;
    while (text[end] === marker) end++;
    const count = end - cursor;
    const newline = text.indexOf('\n', end);
    const openingEnd = newline < 0 ? text.length : newline;
    if (count >= 3 && fenceStart && (marker === '~' || !text.slice(end, openingEnd).includes('`'))) {
      const close = new RegExp(`^[ ]{0,3}${marker}{${count},}[ \\t\\r]*$`);
      cursor = Math.min(openingEnd + 1, text.length);
      while (cursor < text.length) {
        const next = text.indexOf('\n', cursor);
        const lineEnd = next < 0 ? text.length : next;
        const closed = close.test(text.slice(cursor, lineEnd));
        cursor = Math.min(lineEnd + 1, text.length);
        if (closed) break;
      }
    } else if (marker === '`') {
      cursor = end;
      for (;;) {
        const start = text.indexOf('`', cursor);
        if (start < 0) { cursor = text.length; break; }
        cursor = start;
        while (text[cursor] === '`') cursor++;
        if (cursor - start === count) break;
      }
    } else cursor = end;
    if (cursor > at) return true;
  }
  return false;
}

/** A trailing authoring token only; preserve every other source character. */
export function quickTaskPlan(text: string, task: TaskState | null, contextDate: string): { text: string; value: TaskState } | null {
  if (!task || matchFieldEntry(text)) return null;
  const end = text.trimEnd().length;
  const at = text.lastIndexOf('@', end - 1);
  if (at < 0 || at > 0 && !/\s/.test(text[at - 1]!) || /[\r\n]/.test(text.slice(at, end)) || protectedDate(text, at)) return null;
  const parsed = parseTaskDate(text.slice(at, end), contextDate);
  if (!parsed.ok || !parsed.date) return null;
  return { text: text.slice(0, at) + text.slice(end), value: { ...task, scheduled: parsed.date, scheduled_time: parsed.time } };
}

export type CapabilityPopup = { id: string; anchor: PopupAnchor } & (
  | { kind: 'task' | 'schedule' | 'project' | 'work' }
  | { kind: 'complete'; session: WorkSession; completedOn: string }
);

export function createOutlineCapabilities(options: {
  doc: PageDocument;
  notebook: NotebookClient;
  contextDate(): string;
  caret(): Caret | null;
  anchor(id: string): PopupAnchor | null;
  onOpen(target: OpenTarget, beside: boolean): void;
}) {
  const { doc, notebook } = options;
  const [popup, setPopup] = createSignal<CapabilityPopup | null>(null);
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = createSignal<ReadonlyMap<string, string>>(new Map());
  const busy = (id: string) => pending().has(id);
  const error = (id: string) => errors().get(id) ?? '';
  const failure = (id: string, reason: unknown) => setErrors(previous => new Map(previous).set(id, reason instanceof Error ? reason.message : String(reason)));
  async function run(id: string, operation: () => Promise<void>) {
    if (busy(id)) throw new Error('A command is pending for this block.');
    setPending(previous => new Set(previous).add(id));
    setErrors(previous => { const next = new Map(previous); next.delete(id); return next; });
    try { await operation(); }
    catch (reason) { failure(id, reason); throw reason; }
    finally { setPending(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  }
  async function save(intent: Edit) {
    const result = doc.edit(intent, options.caret());
    if (!result.ok) throw new Error(result.reason);
    await doc.flush();
  }
  const edit = (id: string, intent: Edit) => run(id, () => save(intent));
  // Event callbacks retain errors on their source row; controlled widgets also
  // receive the rejection so their entered draft is not discarded.
  const invoke = (operation: Promise<void>) => { void operation.catch(() => {}); };
  function open(id: string, kind: 'task' | 'schedule' | 'project' | 'work', anchor = options.anchor(id)) {
    if (!anchor || !doc.block(id)) return;
    setPopup({ id, kind, anchor });
  }
  function dismiss(state: CapabilityPopup) { if (popup() === state) setPopup(null); }
  async function status(id: string, status: TaskStatus | null) {
    const completedOn = options.contextDate();
    await run(id, async () => {
      if (status === 'done') {
        let active: WorkSession | null | undefined;
        if (notebook.connection() !== 'offline') {
          try { active = await notebook.api.activeWorkSession(); }
          catch (reason) { if (!(reason instanceof ApiError) || !reason.uncertain) throw reason; }
        }
        if (active?.block_id === id && !active.reversed && active.ended_at === null) {
          const anchor = options.anchor(id);
          if (!anchor) throw new Error('Open the task to stop work and complete it.');
          setPopup({ id, kind: 'complete', anchor, session: active, completedOn });
          return;
        }
        await save({ kind: 'completeTask', id, completedOn });
      } else {
        const task = doc.block(id)?.task;
        await save({ kind: 'task', id, value: status === null ? null : { ...(task ?? newTask()), status, completed_on: null } });
      }
    });
  }
  const toggle = (id: string) => status(id, doc.block(id)?.task?.status === 'done' ? 'todo' : doc.block(id)?.task ? 'done' : 'todo');
  async function complete(state: Extract<CapabilityPopup, { kind: 'complete' }>) {
    await edit(state.id, { kind: 'completeTask', id: state.id, completedOn: state.completedOn, stopWork: state.session });
    dismiss(state);
  }
  function showActions(id: string, beside = false) {
    const date = options.contextDate();
    options.onOpen({ kind: 'agenda', date, query: { source: null, filter: { selection: 'unfinished', statuses: [], recent_days: 7, scheduled: null, deadline: null, priority: null, project_id: id }, context_date: date, limit: null } }, beside);
  }
  function source(id: string, beside = false) { options.onOpen({ kind: 'page', pageId: doc.pageId, blockId: id }, beside); }
  return { popup, busy, error, failure, run, save, edit, invoke, open, dismiss, status, toggle, complete, showActions, source };
}
