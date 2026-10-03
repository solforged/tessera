import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import type { WorkSession } from '../api/types';
import { Button } from '../ui/Button';
import './work-sessions.css';

export interface WorkSessionsProps {
  sessions: readonly WorkSession[];
  active: WorkSession | null;
  disabled?: boolean;
  onStart(): void | Promise<void>;
  onStop(id: string, note: string): void | Promise<void>;
  onEdit(id: string, note: string): void | Promise<void>;
}

function duration(start: number, end: number): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function WorkSessions(props: WorkSessionsProps) {
  const [now, setNow] = createSignal(Date.now());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [drafts, setDrafts] = createSignal<ReadonlyMap<string, string>>(new Map());
  const blocked = () => !!props.disabled || busy();
  const active = createMemo(() => {
    const session = props.active;
    return session && !session.reversed && session.ended_at === null ? session : null;
  });
  const history = createMemo(() => {
    const activeId = active()?.id;
    return new Map(props.sessions.filter(session => !session.reversed && session.id !== activeId).map(session => [session.id, session]));
  });
  const historyIds = createMemo(() => [...history().keys()]);
  const note = (session: WorkSession) => drafts().get(session.id) ?? session.note;
  const changeNote = (id: string, value: string) => setDrafts(previous => {
    const next = new Map(previous);
    next.set(id, value);
    return next;
  });

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

  createEffect(() => {
    const running = active();
    const rows = history();
    if (!running && ![...rows.values()].some(session => session.ended_at === null)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
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
    if (!session) return;
    const value = note(session);
    void submit(() => props.onStop(session.id, value));
  };
  const edit = (session: WorkSession) => {
    const value = note(session);
    if (value === session.note) return;
    void submit(() => props.onEdit(session.id, value));
  };

  return <section class="work-sessions" aria-label="Work sessions" aria-busy={busy()}>
    <Show when={active()} fallback={<div class="work-session-actions"><Button class="bordered" disabled={blocked()} onClick={() => { void submit(() => props.onStart()); }}>Start work</Button></div>}>
      {session => <div class="work-session-active">
        <div class="work-session-actions">
          <span class="work-session-duration" role="timer" aria-label="Elapsed work time">{duration(session().started_at, now())}</span>
          <Button class="bordered" disabled={blocked()} onClick={stop}>Stop</Button>
        </div>
        <div class="work-session-times"><span>Started</span> <time dateTime={new Date(session().started_at).toISOString()}>{new Date(session().started_at).toLocaleString()}</time></div>
        <label class="work-session-note">Note<textarea class="input" rows={2} value={note(session())} disabled={blocked()} onInput={event => changeNote(session().id, event.currentTarget.value)} /></label>
      </div>}
    </Show>
    <Show when={error()}><p class="work-session-error error" role="alert">{error()}</p></Show>
    <Show when={historyIds().length > 0}>
      <ul class="work-session-history" aria-label="Work history">
        <For each={historyIds()}>{id => {
          const session = () => history().get(id)!;
          return <li class="work-session-row">
            <div class="work-session-times">
              <span>Started</span> <time dateTime={new Date(session().started_at).toISOString()}>{new Date(session().started_at).toLocaleString()}</time>
              <Show when={session().ended_at !== null} fallback={<span>Running</span>}>
                <span>Ended</span> <time dateTime={new Date(session().ended_at!).toISOString()}>{new Date(session().ended_at!).toLocaleString()}</time>
              </Show>
              <span class="work-session-duration" aria-label="Work duration">{duration(session().started_at, session().ended_at ?? now())}</span>
            </div>
            <label class="work-session-note">Note<textarea class="input" rows={2} value={note(session())} disabled={blocked()} onInput={event => changeNote(id, event.currentTarget.value)} /></label>
            <div class="work-session-actions"><Button class="bordered" disabled={blocked() || note(session()) === session().note} onClick={() => edit(session())}>Save note</Button></div>
          </li>;
        }}</For>
      </ul>
    </Show>
  </section>;
}
