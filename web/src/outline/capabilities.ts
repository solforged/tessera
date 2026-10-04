import { createSignal } from 'solid-js';
import { ApiError } from '../api/client';
import type { TaskState, TaskStatus, WorkSession } from '../api/types';
import type { Caret, Edit, NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import type { PopupAnchor } from '../ui/Popup';
import { newTask } from '../tasks/quick-date';


export type CapabilityKind = 'task' | 'schedule' | 'deadline' | 'repeat' | 'project' | 'work';
export type CapabilityPopup = { id: string; anchor: PopupAnchor } & (
  | { kind: CapabilityKind }
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
  function open(id: string, kind: CapabilityKind, anchor = options.anchor(id)) {
    if (!anchor || !doc.block(id)) return;
    setPopup({ id, kind, anchor });
  }
  function dismiss(state: CapabilityPopup) { if (popup() === state) setPopup(null); }
  async function status(id: string, status: TaskStatus | null) {
    const completedOn = options.contextDate();
    await run(id, async () => {
      // A new task starts Todo; any other status is a second step on the created task.
      if (status !== null && !doc.block(id)?.task) {
        await save({ kind: 'task', id, value: newTask() });
        if (status === 'todo') return;
      }
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
  /** Planning commands always land on a task; a plain block becomes a todo first. */
  function ensureTask(id: string) {
    if (doc.block(id) && !doc.block(id)!.task) invoke(edit(id, { kind: 'task', id, value: newTask() }));
  }
  /** Clock in on this task, or out when its own session is running. */
  async function clock(id: string) {
    await run(id, async () => {
      if (!doc.block(id)?.task) await save({ kind: 'task', id, value: newTask() });
      await doc.flush();
      const active = await notebook.api.activeWorkSession();
      const now = Date.now();
      if (active && !active.reversed && active.ended_at === null) {
        if (active.block_id !== id) throw new Error('Work is already running on another task.');
        await save({ kind: 'stopWork', id, session: active, endedAt: now, note: active.note });
      } else await save({ kind: 'startWork', id, startedAt: now });
    });
  }
  return { popup, busy, error, failure, run, save, edit, invoke, open, dismiss, status, toggle, complete, showActions, source, ensureTask, clock };
}
