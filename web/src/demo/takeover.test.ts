import { expect, spyOn, test } from 'bun:test';
import { NotebookHandoff } from './takeover';

class TestChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  messages: { type: 'request' | 'released'; id: string }[] = [];
  sent = Promise.withResolvers<void>();
  postMessage(message: { type: 'request' | 'released'; id: string }): void { this.messages.push(message); this.sent.resolve(); }
  close(): void { this.onmessage = null; }
  receive(data: unknown): void { this.onmessage?.(new MessageEvent('message', { data })); }
}

test('an owner announces release only after its save and close finish', async () => {
  const channel = new TestChannel();
  const saved = Promise.withResolvers<boolean>();
  const handoff = new NotebookHandoff(channel, { release: () => saved.promise, waiting() {}, released() {}, timeout() {} });
  channel.receive({ type: 'request', id: 'window-b' });
  expect(handoff.requested).toBe(true);
  expect(channel.messages).toEqual([]);
  // A simultaneous third window cannot start another close or receive an early grant.
  channel.receive({ type: 'request', id: 'window-c' });
  saved.resolve(true); await channel.sent.promise;
  expect(channel.messages).toEqual([{ type: 'released', id: 'window-b' }]);
  handoff.dispose();
});

test('an owner with uncommitted edits keeps ownership and never announces release', async () => {
  const channel = new TestChannel();
  const saved = Promise.withResolvers<boolean>();
  const handoff = new NotebookHandoff(channel, { release: () => saved.promise, waiting() {}, released() {}, timeout() {} });
  channel.receive({ type: 'request', id: 'window-b' });
  saved.resolve(false); await saved.promise;
  expect(channel.messages).toEqual([]);
  handoff.dispose();
});

test('only the current addressed release opens a requesting window', () => {
  const channel = new TestChannel(); const states: string[] = [];
  const handoff = new NotebookHandoff(channel, { release: async () => false, waiting: () => { states.push('waiting'); }, released: () => { states.push('open'); }, timeout: () => { states.push('timeout'); } });
  handoff.request(); const previous = channel.messages[0]!.id;
  handoff.request(); const current = channel.messages[1]!.id;
  channel.receive({ type: 'released', id: previous });
  expect(states).toEqual(['waiting', 'waiting']);
  channel.receive({ type: 'released', id: current });
  channel.receive({ type: 'released', id: current });
  expect(states).toEqual(['waiting', 'waiting', 'open']);
  handoff.dispose();
});

test('an unanswered request times out after five seconds and ignores a late release', () => {
  let expire: (() => void) | undefined;
  const schedule = Object.assign((callback: TimerHandler, delay?: number, ..._args: unknown[]) => {
    expect(delay).toBe(5000);
    expire = () => { if (typeof callback === 'function') callback(); };
    return 1 as number & NodeJS.Timeout;
  }, { __promisify__: setTimeout.__promisify__ });
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(schedule as unknown as typeof setTimeout);
  const channel = new TestChannel(); const states: string[] = [];
  const handoff = new NotebookHandoff(channel, { release: async () => false, waiting: () => { states.push('waiting'); }, released: () => { states.push('open'); }, timeout: () => { states.push('timeout'); } });
  try {
    handoff.request(); const id = channel.messages[0]!.id;
    expect(states).toEqual(['waiting']);
    expire!();
    channel.receive({ type: 'released', id });
    expect(states).toEqual(['waiting', 'timeout']);
  } finally { handoff.dispose(); timer.mockRestore(); }
});
