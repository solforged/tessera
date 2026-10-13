import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import type { WorkSession } from '../api/types';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { localDate } from '../ui/MonthGrid';
import { relativeDate } from './task-labels';
import './work-sessions.css';

export interface WorkSessionsProps {
  sessions: readonly WorkSession[];
  active: WorkSession | null;
  today: string;
  disabled?: boolean;
  onStart(): void | Promise<void>;
  onStop(id: string, note: string): void | Promise<void>;
  onEdit(id: string, note: string): void | Promise<void>;
}

/** Elapsed work as `h:mm:ss`, the one shape every clock in the notebook uses. */
export function workDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A session's wall-clock time as `HH:MM`. */
export const clockTime = (ms: number) => { const date = new Date(ms); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };

/** A second-by-second clock while `running`; otherwise it holds still. */
function createNow(running: () => boolean) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!running()) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });
  return now;
}

/** The running session on its task's row: a ticking `h:mm:ss` that opens Work sessions. */
export function RunningClock(props: { session: WorkSession; onOpen(anchor: HTMLElement): void }) {
  const now = createNow(() => true);
  const elapsed = () => workDuration(now() - props.session.started_at);
  return <Button class="outline-planning running-clock" label={`Work running since ${clockTime(props.session.started_at)} · open work sessions`} onClick={event => props.onOpen(event.currentTarget)}>
    <span class="running-clock-dot" aria-hidden="true" /><span role="timer">{elapsed()}</span>
  </Button>;
}

/**
 * One task's clock: Start or Stop at the top with the elapsed time, then its sessions newest first. Each session keeps a
 * one-line note on the session itself; notes save when focus leaves them, on Enter, or when the running session stops.
 */
export function WorkSessions(props: WorkSessionsProps) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [drafts, setDrafts] = createSignal<ReadonlyMap<string, string>>(new Map());
  const blocked = () => !!props.disabled || busy();
  const active = createMemo(() => {
    const session = props.active;
    return session && !session.reversed && session.ended_at === null ? session : null;
  });
  const now = createNow(() => !!active());
  const history = createMemo(() => props.sessions
    .filter(session => !session.reversed && session.id !== active()?.id && session.ended_at !== null)
    .sort((left, right) => right.started_at - left.started_at));
  // Rows are keyed by id, so a refetch that replaces the session objects keeps a note being typed in place.
  const historyIds = createMemo(() => history().map(session => session.id));
  const byId = createMemo(() => new Map(history().map(session => [session.id, session])));
  const total = () => history().reduce((sum, session) => sum + session.ended_at! - session.started_at, 0) + (active() ? now() - active()!.started_at : 0);
  const note = (session: WorkSession) => drafts().get(session.id) ?? session.note;
  const changeNote = (id: string, value: string) => setDrafts(previous => new Map(previous).set(id, value));

  // Keep drafts across object replacement and failed writes. Drop them only
  // when the controlled data acknowledges the exact entered note.
  createEffect(() => {
    const sessions = props.active ? [...props.sessions, props.active] : props.sessions;
    const current = untrack(drafts);
    let next: Map<string, string> | undefined;
    for (const session of sessions) {
      if (current.has(session.id) && current.get(session.id) === session.note) {
        next ??= new Map(current);
        next.delete(session.id);
      }
    }
    if (next) setDrafts(next);
  });

  const submit = async (write: () => void | Promise<void>) => {
    if (blocked()) return;
    setBusy(true);
    try {
      await write();
      setError('');
    } catch (reason) {
      setError((reason instanceof Error ? reason.message : String(reason)) || 'Could not save work session.');
    } finally {
      setBusy(false);
    }
  };
  const stop = () => {
    const session = active();
    if (session) void submit(() => props.onStop(session.id, note(session).trim()));
  };
  const saveNote = (session: WorkSession) => {
    const value = note(session).trim();
    if (value !== session.note) void submit(() => props.onEdit(session.id, value));
  };
  const NoteInput = (noteProps: { session: WorkSession; placeholder: string }) =>
    <input class="work-session-note" type="text" value={note(noteProps.session)} disabled={blocked()} placeholder={noteProps.placeholder} aria-label="Session note" autocomplete="off"
      onInput={event => changeNote(noteProps.session.id, event.currentTarget.value)}
      onBlur={() => saveNote(noteProps.session)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.currentTarget.blur(); } }} />;

  return <section class="work-sessions" aria-label="Work sessions" aria-busy={busy()}>
    <div class="work-session-clock" classList={{ 'work-session-running': !!active() }}>
      <span class="work-session-elapsed" role="timer" aria-label={active() ? 'Elapsed work time' : 'Total work time'}>{workDuration(active() ? now() - active()!.started_at : total())}</span>
      <span class="work-session-summary">
        <Show when={active()} fallback={history().length ? `${history().length === 1 ? '1 session' : `${history().length} sessions`} in total` : 'No work logged yet'}>
          {session => <>Since {clockTime(session().started_at)}<Show when={history().length}> · {workDuration(total())} in total</Show></>}
        </Show>
      </span>
      <Show when={active()} fallback={<Button class="bordered work-session-toggle" disabled={blocked()} onClick={() => { void submit(() => props.onStart()); }}><Icon name="play" />{history().length ? 'Start again' : 'Start'}</Button>}>
        {/* Stop carries the note draft itself; keeping focus in the note spares a second save racing it. */}
        <Button class="bordered work-session-toggle" disabled={blocked()} onMouseDown={event => event.preventDefault()} onClick={stop}><Icon name="stop" />Stop</Button>
      </Show>
    </div>
    <Show when={active()}>{session => <NoteInput session={session()} placeholder="What you are working on (saved with the session)" />}</Show>
    <Show when={error()}><p class="work-session-error error" role="alert">{error()}</p></Show>
    <Show when={history().length > 0}>
      <ol class="work-session-history" aria-label="Work history">
        <For each={historyIds()}>{id => {
          const session = () => byId().get(id)!;
          return <li class="work-session-row">
            <span class="work-session-times">
              <time dateTime={new Date(session().started_at).toISOString()}>{relativeDate(localDate(new Date(session().started_at)), props.today)} {clockTime(session().started_at)}</time>–<time dateTime={new Date(session().ended_at!).toISOString()}>{clockTime(session().ended_at!)}</time>
            </span>
            <span class="work-session-duration" aria-label="Work duration">{workDuration(session().ended_at! - session().started_at)}</span>
            <NoteInput session={session()} placeholder="Add a note" />
          </li>;
        }}</For>
      </ol>
    </Show>
  </section>;
}
