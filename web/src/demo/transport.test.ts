import { describe, expect, test } from 'bun:test';
import { CHANGE_CLOSED, CHANGE_CONNECTING, CHANGE_OPEN } from '../api/client';
import type { NotebookInfo } from '../api/types';
import type { FromWorker, ToWorker } from './protocol';
import { DemoFailure, DemoTransport } from './transport';

const info: NotebookInfo = { id: 'demo', path: '/demo', created_at: 0, schema_version: 1, sqlite_version: 'test' };
class TestWorker extends EventTarget {
  messages: ToWorker[] = [];
  transfers: Transferable[][] = [];
  private waiting: { count: number; resolve(): void }[] = [];
  postMessage(message: ToWorker, transfer: Transferable[] = []): void {
    this.messages.push(message); this.transfers.push(transfer);
    this.waiting = this.waiting.filter(waiter => {
      if (this.messages.length < waiter.count) return true;
      waiter.resolve(); return false;
    });
  }
  until(count: number): Promise<void> {
    if (this.messages.length >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiting.push({ count, resolve }); return promise;
  }
  terminated = false;
  terminate(): void { this.terminated = true; }
  receive(message: FromWorker): void { this.dispatchEvent(new MessageEvent('message', { data: message })); }
}
function fixture() {
  const worker = new TestWorker();
  return { worker, transport: new DemoTransport(worker as unknown as Worker) };
}

describe('browser demo transport', () => {
  test('requests wait for ready and route both relative and absolute URLs through the worker', async () => {
    const { worker, transport } = fixture();
    const first = transport.fetch('/api/roots?limit=5', {});
    expect(worker.messages).toHaveLength(0);
    worker.receive({ type: 'ready', info, fresh: true });
    expect(await transport.ready).toEqual({ info, fresh: true });
    await worker.until(1);
    const request = worker.messages[0]!;
    expect(request).toMatchObject({ type: 'request', method: 'GET', path: '/api/roots?limit=5', body: null });
    worker.receive({ id: request.id, type: 'response', status: 200, contentType: 'application/json', body: new TextEncoder().encode('[]').buffer });
    const response = await first;
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual([]);
    const second = transport.fetch('https://tessera.solforged.io/api/batches', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Filename': 'book.epub' }, body: '{"operations":[]}' });
    await worker.until(2);
    const post = worker.messages[1]!;
    expect(post).toMatchObject({ type: 'request', method: 'POST', path: '/api/batches', headers: [['content-type', 'application/json'], ['x-filename', 'book.epub']] });
    if (post.type !== 'request') throw new Error('Missing request');
    expect(new TextDecoder().decode(post.body!)).toBe('{"operations":[]}');
    expect(worker.transfers[1]).toEqual([post.body!]);
    worker.receive({ id: post.id, type: 'response', status: 409, contentType: 'application/json', body: new TextEncoder().encode('{"error":"conflict"}').buffer });
    expect((await second).status).toBe(409);
    transport.dispose();
  });

  test('empty-body statuses build valid real Responses', async () => {
    const { worker, transport } = fixture(); worker.receive({ type: 'ready', info, fresh: false });
    const pending = transport.fetch('/api/example', { method: 'POST' });
    await worker.until(1);
    worker.receive({ id: worker.messages[0]!.id, type: 'response', status: 204, contentType: '', body: new ArrayBuffer(0) });
    expect(await (await pending).text()).toBe(''); transport.dispose();
  });

  test('an aborted request is removed even before the worker is ready', async () => {
    const { worker, transport } = fixture(); const controller = new AbortController();
    const pending = transport.fetch('/api/roots', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    worker.receive({ type: 'ready', info, fresh: false }); await transport.ready;
    expect(worker.messages).toHaveLength(0); transport.dispose();
  });

  test('streams open asynchronously before catch-up events and unsubscribe on close', async () => {
    const { worker, transport } = fixture();
    const socket = transport.stream(7); const events: string[] = [];
    socket.onopen = () => events.push('open'); socket.onmessage = event => events.push(event.data); socket.onclose = () => events.push('close');
    expect(socket.readyState).toBe(CHANGE_CONNECTING);
    worker.receive({ type: 'ready', info, fresh: false }); await worker.until(1);
    const subscribe = worker.messages[0]!;
    expect(subscribe).toMatchObject({ type: 'subscribe', after: 7 });
    worker.receive({ id: subscribe.id, type: 'done' });
    worker.receive({ id: subscribe.id, type: 'change', event: '{"seq":8}' });
    expect(socket.readyState).toBe(CHANGE_OPEN); expect(events).toEqual(['open', '{"seq":8}']);
    socket.close(); await worker.until(2);
    expect(worker.messages[1]).toEqual({ id: subscribe.id, type: 'unsubscribe' });
    expect(socket.readyState).toBe(CHANGE_CLOSED); expect(events.at(-1)).toBe('close');
    worker.receive({ id: subscribe.id, type: 'change', event: '{"seq":9}' });
    expect(events).not.toContain('{"seq":9}'); transport.dispose();
  });

  test('closing a stream before its open acknowledgement still releases the subscription', async () => {
    const { worker, transport } = fixture(); worker.receive({ type: 'ready', info, fresh: false });
    const socket = transport.stream(0); await worker.until(1); socket.close(); await worker.until(2);
    expect(worker.messages.map(message => message.type)).toEqual(['subscribe', 'unsubscribe']); transport.dispose();
  });

  test('startup failures reject waiting requests with the exact failure code', async () => {
    const { worker, transport } = fixture();
    const pending = transport.fetch('/api/roots', {});
    worker.receive({ type: 'failed', code: 'locked', message: 'Another tab owns the notebook.' });
    await expect(pending).rejects.toBeInstanceOf(DemoFailure);
    await expect(transport.ready).rejects.toMatchObject({ code: 'locked' }); transport.dispose();
  });

  test('an invalid restore rejects only its call and leaves other requests and streams usable', async () => {
    const { worker, transport } = fixture(); worker.receive({ type: 'ready', info, fresh: false });
    const socket = transport.stream(0); await worker.until(1);
    worker.receive({ id: worker.messages[0]!.id, type: 'done' });
    const bytes = new TextEncoder().encode('not a notebook').buffer;
    const restoring = transport.restore(bytes);
    const exporting = transport.exportNotebook();
    await worker.until(3);
    expect(worker.messages[1]).toMatchObject({ type: 'restore', body: bytes });
    expect(worker.transfers[1]).toEqual([bytes]);
    worker.receive({ id: worker.messages[1]!.id, type: 'error', code: 'invalid', message: 'This file is not a Tessera backup.' });
    await expect(restoring).rejects.toBeInstanceOf(DemoFailure);
    await expect(restoring).rejects.toMatchObject({ code: 'invalid', message: 'This file is not a Tessera backup.' });
    expect(socket.readyState).toBe(CHANGE_OPEN);
    const backup = new ArrayBuffer(32);
    worker.receive({ id: worker.messages[2]!.id, type: 'bytes', body: backup });
    expect(await exporting).toBe(backup);
    const starting = transport.start('empty'); await worker.until(4);
    worker.receive({ id: worker.messages[3]!.id, type: 'done' });
    await starting;
    transport.dispose();
  });

  test('reset waits for the worker to finish before returning', async () => {
    const { worker, transport } = fixture(); worker.receive({ type: 'ready', info, fresh: false });
    const pending = transport.reset(); await worker.until(1);
    expect(worker.messages[0]?.type).toBe('reset');
    worker.receive({ id: worker.messages[0]!.id, type: 'done' });
    await pending; transport.dispose();
  });

  test('close drains accepted body reads and responses before releasing and terminating', async () => {
    const { worker, transport } = fixture(); worker.receive({ type: 'ready', info, fresh: false });
    const accepted = transport.fetch('/api/batches', { method: 'POST', body: '{"edit":"last"}' });
    const closing = transport.close();
    await worker.until(1);
    expect(worker.messages.map(message => message.type)).toEqual(['request']);
    expect(worker.terminated).toBe(false);
    await expect(transport.fetch('/api/batches', { method: 'POST' })).rejects.toBeInstanceOf(DemoFailure);
    worker.receive({ id: worker.messages[0]!.id, type: 'response', status: 200, contentType: 'application/json', body: new TextEncoder().encode('{}').buffer });
    expect((await accepted).status).toBe(200);
    await worker.until(2);
    expect(worker.messages[1]?.type).toBe('close');
    expect(worker.terminated).toBe(false);
    worker.receive({ id: worker.messages[1]!.id, type: 'done' });
    await closing;
    expect(worker.terminated).toBe(true);
  });
});
