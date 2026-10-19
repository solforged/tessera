import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type * as Solid from 'solid-js';
import type { AgentTurnEvents, StartAgentTurn, TurnEvent } from '../api/types';
import type { AgentSession, DockMessage } from './session';

// Dynamic imports are intentional here: mock Solid's SSR boundary before loading its consumers.
const browserEntry = 'solid-js/dist/solid.js';
const solid = await import(browserEntry) as typeof Solid;
mock.module('solid-js', () => solid);
const { createRoot, createSignal, useContext } = await import('solid-js');
const { createAgentSession } = await import('./session');
const { AgentMarks } = await import('./marks');
const { createApi, setTransport } = await import('../api/client');

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const disposers: (() => void)[] = [];
beforeEach(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  setTransport((url, init) => fetch(url, init));
});
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

function session(notebook = 'notebook') {
  return createRoot(dispose => {
    disposers.push(dispose);
    const [id, setId] = createSignal<string | undefined>(notebook);
    return { dock: createAgentSession(id), setId, dispose };
  });
}
async function until(ready: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ready()) return;
    await Promise.resolve();
  }
  throw new Error('The session did not reach the expected state.');
}
function assistant(dock: AgentSession) {
  const message = dock.messages().at(-1);
  if (message?.role !== 'assistant') throw new Error('No assistant message.');
  return message;
}
function service() {
  const starts: StartAgentTurn[] = [];
  const cancelled: string[] = [];
  const undos: number[] = [];
  const polls: { after: number; signal?: AbortSignal | null; reply(value: AgentTurnEvents): void; fail(error: Error): void }[] = [];
  let refusal: string | undefined;
  let creation: Promise<Response> | undefined;
  setTransport(async (url, init) => {
    const parsed = new URL(url, 'http://test.local');
    if (parsed.pathname === '/api/agent/turns') {
      starts.push(JSON.parse(String(init.body)) as StartAgentTurn);
      return creation ?? Response.json({ turn: `turn-${starts.length}` });
    }
    if (parsed.pathname.endsWith('/cancel')) {
      cancelled.push(parsed.pathname.split('/').at(-2)!);
      return new Response(null, { status: 204 });
    }
    if (parsed.pathname.endsWith('/events')) {
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(init.signal?.reason);
        init.signal?.addEventListener('abort', abort, { once: true });
        polls.push({ after: Number(parsed.searchParams.get('after')), signal: init.signal,
          reply(value) { init.signal?.removeEventListener('abort', abort); resolve(Response.json(value)); },
          fail(error) { init.signal?.removeEventListener('abort', abort); reject(error); },
        });
      });
    }
    if (parsed.pathname.endsWith('/undo')) {
      undos.push(Number(parsed.pathname.split('/').at(-2)));
      return refusal ? Response.json({ error: { code: 'conflict', message: refusal } }, { status: 409 }) : Response.json({ undone: undos.at(-1), kept_pages: [], committed: {} });
    }
    throw new Error(`Unexpected request ${init.method} ${url}`);
  });
  return { starts, cancelled, undos, polls,
    refuse(message: string) { refusal = message; },
    deferStart(promise: Promise<Response>) { creation = promise; },
    async reply(dock: AgentSession, events: TurnEvent[], done = false) {
      await until(() => polls.length > 0);
      polls.shift()!.reply({ events, done });
      await until(() => done ? !dock.running() : polls.length > 0);
    },
  };
}

test('streamed parts preserve text → tool → text → edit order and advance the cursor', async () => {
  const server = service();
  const { dock } = session();
  dock.send('Read and annotate', 'provider', [{ page_id: 'page', block_id: 'root' }]);
  await server.reply(dock, [
    { n: 1, kind: 'text', delta: 'Reading ' },
    { n: 2, kind: 'text', delta: 'now.' },
    { n: 3, kind: 'tool', name: 'read_page', summary: 'Read page' },
    { n: 4, kind: 'text', delta: 'I found a theme.' },
    { n: 5, kind: 'edit', seq: 7, summary: 'Added note', page: 'page', blocks: ['block'] },
  ]);
  await until(() => server.polls.length === 1);
  expect(server.polls[0]!.after).toBe(5);
  expect(dock.running()).toBe(true);
  await server.reply(dock, [{ n: 6, kind: 'done', stop: 'end' }], true);
  expect(assistant(dock)).toMatchObject({ status: 'done', parts: [
    { kind: 'text', text: 'Reading now.' }, { kind: 'tool', summary: 'Read page' },
    { kind: 'text', text: 'I found a theme.' },
    { kind: 'edit', seq: 7, summary: 'Added note', page: 'page', blocks: ['block'], undone: false },
  ] });
  expect(dock.running()).toBe(false);
  expect(server.polls).toHaveLength(0);
});

test('stop aborts polling, cancels the service turn, and clear refuses a running thread', async () => {
  const server = service();
  const { dock } = session();
  dock.send('Work', 'provider', []);
  await until(() => server.polls.length === 1);
  dock.clear();
  expect(dock.messages()).toHaveLength(2);
  dock.stop();
  expect(server.polls[0]!.signal?.aborted).toBe(true);
  expect(server.cancelled).toEqual(['turn-1']);
  expect(assistant(dock).status).toBe('cancelled');
  expect(dock.running()).toBe(false);
  dock.clear();
  expect(dock.messages()).toEqual([]);
});

test('stopping before turn creation replies still cancels the newly created server turn', async () => {
  const server = service();
  const pending = Promise.withResolvers<Response>();
  server.deferStart(pending.promise);
  const { dock } = session();
  dock.send('Work', 'provider', []);
  dock.stop();
  pending.resolve(Response.json({ turn: 'late-turn' }));
  await until(() => server.cancelled.length === 1);
  expect(server.cancelled).toEqual(['late-turn']);
  expect(server.polls).toHaveLength(0);
  expect(assistant(dock).status).toBe('cancelled');
});

test('persistence reload cancels running messages and retains only the last 40', async () => {
  const server = service();
  const previous: DockMessage[] = Array.from({ length: 42 }, (_, i) => ({ id: String(i), role: 'user', text: `Earlier ${i}`, context: [] }));
  localStorage.setItem('tessera.agent.notebook', JSON.stringify(previous));
  const { dock } = session();
  expect(dock.messages()).toHaveLength(40);
  expect(dock.messages()[0]!.id).toBe('2');
  dock.send('Work', 'provider', []);
  await until(() => server.polls.length === 1);
  const reloaded = session().dock;
  expect(reloaded.messages()).toHaveLength(40);
  expect(assistant(reloaded).status).toBe('cancelled');
  expect(reloaded.running()).toBe(false);
  expect(server.starts).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem('tessera.agent.notebook')!).at(-1).status).toBe('cancelled');
});

test('marks show the newest un-undone change and undo failures retain their marks', async () => {
  const server = service();
  const { dock } = session();
  dock.send('Edit', 'provider', []);
  await server.reply(dock, [
    { n: 1, kind: 'edit', seq: 10, summary: 'First', page: null, blocks: ['a', 'b'] },
    { n: 2, kind: 'edit', seq: 11, summary: 'Second', page: null, blocks: ['a'] },
    { n: 3, kind: 'done', stop: 'end' },
  ], true);
  expect(dock.marks().get('a')).toEqual({ seq: 11, summary: 'Second' });
  expect(await dock.undo(11)).toBeNull();
  expect(dock.marks().get('a')).toEqual({ seq: 10, summary: 'First' });
  expect(assistant(dock).parts.at(-1)).toMatchObject({ undone: true });
  server.refuse('This atom changed after the agent edit.');
  expect(await dock.undo(10)).toBe('This atom changed after the agent edit.');
  expect(dock.marks().get('b')).toEqual({ seq: 10, summary: 'First' });
  expect(server.undos).toEqual([11, 10]);
});

test('turn history excludes the current prompt and keeps earlier assistant text parts as separate paragraphs', async () => {
  const server = service();
  const { dock } = session();
  dock.send('First', 'provider', [{ page_id: 'one' }]);
  await server.reply(dock, [
    { n: 1, kind: 'text', delta: 'Before.' },
    { n: 2, kind: 'tool', name: 'search', summary: 'Do not include this' },
    { n: 3, kind: 'text', delta: 'After.' },
    { n: 4, kind: 'edit', seq: 1, summary: 'Nor this', page: null, blocks: [] },
    { n: 5, kind: 'done', stop: 'end' },
  ], true);
  dock.send('Second', 'other-provider', [{ page_id: 'two', block_id: 'b' }]);
  expect(server.starts[0]!.messages).toEqual([]);
  expect(server.starts[1]).toEqual({ provider: 'other-provider', prompt: 'Second', messages: [
    { role: 'user', text: 'First' }, { role: 'assistant', text: 'Before.\n\nAfter.' },
  ], context: [{ page_id: 'two', block_id: 'b' }] });
});

test('notebook switching and cleanup cancel polling without mixing notebook threads', async () => {
  const server = service();
  const { dock, setId, dispose } = session('one');
  dock.send('First notebook', 'provider', []);
  await until(() => server.polls.length === 1);
  setId('two');
  expect(dock.messages()).toEqual([]);
  expect(server.cancelled).toEqual(['turn-1']);
  expect(JSON.parse(localStorage.getItem('tessera.agent.one')!).at(-1).status).toBe('cancelled');
  dock.send('Second notebook', 'provider', []);
  await until(() => server.polls.length === 2);
  dispose();
  expect(server.polls[1]!.signal?.aborted).toBe(true);
  expect(server.cancelled).toEqual(['turn-1', 'turn-2']);
  expect(assistant(dock).status).toBe('cancelled');
});

test('service error details and done stop reasons reach the assistant message', async () => {
  const server = service();
  const { dock } = session();
  dock.send('Work', 'provider', []);
  await server.reply(dock, [{ n: 1, kind: 'error', message: 'Provider rejected the key.' }, { n: 2, kind: 'done', stop: 'error' }], true);
  expect(assistant(dock)).toMatchObject({ status: 'error', error: 'Provider rejected the key.' });
  dock.send('Again', 'provider', []);
  await server.reply(dock, [{ n: 1, kind: 'done', stop: 'limit' }], true);
  expect(assistant(dock).status).toBe('limit');
  dock.send('Again', 'provider', []);
  await until(() => server.polls.length > 0);
  server.polls.shift()!.fail(new Error('offline'));
  await until(() => !dock.running());
  expect(assistant(dock)).toMatchObject({ status: 'error', error: 'The workshop service is not reachable.' });
});

test('the default marks context works without a dock provider', () => {
  createRoot(dispose => {
    const marks = useContext(AgentMarks);
    expect(marks.mark('block')).toBeUndefined();
    dispose();
  });
});

test('provider requests share transport, base URL, signals, and service errors', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  setTransport(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/test')) return Response.json({ error: { code: 'provider', message: 'Invalid key.' } }, { status: 401 });
    return Response.json({ providers: [], default: null });
  });
  const client = createApi('http://test.local');
  const signal = new AbortController().signal;
  const body = { providers: [{ name: 'Local', protocol: 'openai' as const, model: 'model', base_url: 'http://localhost:8080/v1' }], default: null };
  await client.agentProviders(signal);
  await client.saveAgentProviders(body, signal);
  expect(calls.map(call => [call.url, call.init.method, call.init.signal])).toEqual([
    ['http://test.local/api/agent/providers', 'GET', signal],
    ['http://test.local/api/agent/providers', 'PUT', signal],
  ]);
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual(body);
  expect(new Headers(calls[1]!.init.headers).get('Content-Type')).toBe('application/json');
  await expect(client.testAgentProvider('id/with space', signal)).rejects.toThrow('Invalid key.');
  expect(calls[2]!.url).toBe('http://test.local/api/agent/providers/id%2Fwith%20space/test');
});
