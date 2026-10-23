import { createComputed, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { ulid } from 'ulid';
import { api } from '../api/client';
import type { ApiClient } from '../api/client';
import type { ContextRef, StartAgentTurn, ThreadMessage, TurnEvent } from '../api/types';

export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; summary: string }
  | { kind: 'edit'; seq: number; summary: string; page: string | null; blocks: string[]; undone: boolean };
export type DockMessage =
  | { id: string; role: 'user'; text: string; context: ContextRef[] }
  | { id: string; role: 'assistant'; parts: AssistantPart[]; status: 'running' | 'done' | 'cancelled' | 'error' | 'limit'; error?: string };
export interface AgentSession {
  messages: Accessor<DockMessage[]>;
  running: Accessor<boolean>;
  send(prompt: string, provider: string, context: ContextRef[]): void;
  stop(): void;
  clear(): void;
  marks: Accessor<ReadonlyMap<string, { seq: number; summary: string }>>;
  undo(seq: number): Promise<string | null>;
}

type AssistantMessage = Extract<DockMessage, { role: 'assistant' }>;
interface RunningTurn { message: string; controller: AbortController; turn?: string }

function load(notebook: string | undefined): DockMessage[] {
  if (!notebook) return [];
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`tessera.agent.${notebook}`) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return (stored as DockMessage[]).slice(-40).map(message =>
      message.role === 'assistant' && message.status === 'running' ? { ...message, status: 'cancelled' } : message);
  } catch { return []; }
}

export function createAgentSession(notebookId: Accessor<string | undefined>, client: ApiClient = api): AgentSession {
  const [messages, setMessages] = createSignal<DockMessage[]>([]);
  let notebook: string | undefined;
  let active: RunningTurn | undefined;
  let disposed = false;

  const update = (change: (messages: DockMessage[]) => DockMessage[]) => {
    const next = setMessages(change);
    if (notebook) {
      try { localStorage.setItem(`tessera.agent.${notebook}`, JSON.stringify(next.slice(-40))); }
      catch { /* The thread still works when browser storage is unavailable or full. */ }
    }
  };
  const updateAssistant = (id: string, change: (message: AssistantMessage) => AssistantMessage) =>
    update(thread => thread.map(message => message.id === id && message.role === 'assistant' ? change(message) : message));
  const stop = () => {
    if (!active) return;
    const stopped = active;
    active = undefined;
    stopped.controller.abort();
    updateAssistant(stopped.message, message => ({ ...message, status: 'cancelled' }));
    if (stopped.turn) void api.cancelAgentTurn(stopped.turn).catch(() => { /* The turn may already have expired. */ });
  };

  createComputed(() => {
    const next = notebookId();
    untrack(() => {
      if (next === notebook) return;
      stop();
      notebook = next;
      update(() => load(notebook));
    });
  });
  onCleanup(() => { disposed = true; stop(); });

  const fold = (message: AssistantMessage, event: TurnEvent): AssistantMessage => {
    switch (event.kind) {
      case 'text': {
        const parts = [...message.parts];
        const last = parts.at(-1);
        if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + event.delta };
        else parts.push({ kind: 'text', text: event.delta });
        return { ...message, parts };
      }
      case 'tool': return { ...message, parts: [...message.parts, { kind: 'tool', summary: event.summary }] };
      case 'edit': return { ...message, parts: [...message.parts, { kind: 'edit', seq: event.seq, summary: event.summary, page: event.page, blocks: [...event.blocks], undone: false }] };
      case 'error': return { ...message, error: event.message };
      case 'done': return { ...message, status: event.stop === 'end' ? 'done' : event.stop };
    }
  };
  const run = async (current: RunningTurn, body: StartAgentTurn) => {
    try {
      // Do not abort creation: a late reply must still be cancelled on the server.
      const { turn } = await api.startAgentTurn(body);
      current.turn = turn;
      if (active !== current) {
        void api.cancelAgentTurn(turn).catch(() => { /* The turn may already have expired. */ });
        return;
      }
      let after = 0;
      while (active === current) {
        const result = await api.agentTurnEvents(turn, after, current.controller.signal);
        if (active !== current) return;
        let finished = false;
        const events = result.events.filter(event => event.n > after);
        updateAssistant(current.message, message => {
          for (const event of events) {
            after = event.n;
            message = fold(message, event);
            if (event.kind === 'done') { finished = true; break; }
          }
          // A finished poll must never leave the thread displaying a running turn.
          if (result.done && message.status === 'running') return { ...message, status: message.error ? 'error' : 'done' };
          return message;
        });
        if (finished || result.done) { active = undefined; return; }
      }
    } catch (error) {
      if (active !== current) return;
      active = undefined;
      updateAssistant(current.message, message => ({ ...message, status: 'error', error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const running = createMemo(() => messages().some(message => message.role === 'assistant' && message.status === 'running'));
  const marks = createMemo<ReadonlyMap<string, { seq: number; summary: string }>>(() => {
    const result = new Map<string, { seq: number; summary: string }>();
    for (const message of messages()) {
      if (message.role !== 'assistant') continue;
      for (const part of message.parts) {
        if (part.kind !== 'edit' || part.undone) continue;
        for (const block of part.blocks) {
          const previous = result.get(block);
          if (!previous || part.seq > previous.seq) result.set(block, { seq: part.seq, summary: part.summary });
        }
      }
    }
    return result;
  });

  return {
    messages, running, marks, stop,
    send(prompt, provider, context) {
      if (disposed || active || !notebook || !prompt.trim()) return;
      const history: ThreadMessage[] = messages().map(message => ({
        role: message.role,
        text: message.role === 'user' ? message.text : message.parts.filter(part => part.kind === 'text').map(part => part.text.trim()).join('\n\n'),
      }));
      const refs = context.map(ref => ({ ...ref }));
      const current: RunningTurn = { message: ulid(), controller: new AbortController() };
      active = current;
      update(thread => [...thread,
        { id: ulid(), role: 'user', text: prompt, context: refs },
        { id: current.message, role: 'assistant', parts: [], status: 'running' },
      ]);
      void run(current, { provider, prompt, messages: history, context: refs });
    },
    clear() { if (!active) update(() => []); },
    async undo(seq) {
      const sourceNotebook = notebook;
      try {
        await client.undoChange(seq);
        if (notebook !== sourceNotebook || disposed) return null;
        update(thread => thread.map(message => message.role !== 'assistant' ? message : {
          ...message,
          parts: message.parts.map(part => part.kind === 'edit' && part.seq === seq ? { ...part, undone: true } : part),
        }));
        return null;
      } catch (error) { return error instanceof Error ? error.message : String(error); }
    },
  };
}
