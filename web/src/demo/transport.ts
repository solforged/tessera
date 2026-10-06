/// <reference lib="es2024.promise" />
import { CHANGE_CLOSED, CHANGE_CLOSING, CHANGE_CONNECTING, CHANGE_OPEN } from '../api/client';
import type { ChangeSocket, Transport } from '../api/client';
import type { NotebookInfo } from '../api/types';
import type { FailureCode, FromWorker, ToWorker } from './protocol';

export class DemoFailure extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); this.name = 'DemoFailure'; }
}
interface Pending {
  resolve(message: Extract<FromWorker, { type: 'response' | 'done' }>): void;
  reject(reason: unknown): void;
  cleanup(): void;
}

export class DemoTransport {
  private startup = Promise.withResolvers<NotebookInfo>();
  readonly ready = this.startup.promise;
  private failure?: DemoFailure;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private sockets = new Map<number, DemoSocket>();

  constructor(private worker: Worker) {
    worker.addEventListener('message', event => this.receive(event.data as FromWorker));
    worker.addEventListener('error', event => { event.preventDefault(); this.fail(new DemoFailure('internal', event.message || 'The notebook worker could not start.')); });
    worker.addEventListener('messageerror', () => this.fail(new DemoFailure('internal', 'The notebook worker sent an unreadable response.')));
  }

  private fail(reason: DemoFailure): void {
    this.failure = reason;
    this.startup.reject(reason);
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(reason); }
    this.pending.clear();
    for (const socket of this.sockets.values()) socket.fail();
    this.sockets.clear();
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case 'ready': this.startup.resolve(message.info); break;
      case 'failed': this.fail(new DemoFailure(message.code, message.message)); break;
      case 'change': this.sockets.get(message.id)?.message(message.event); break;
      case 'done':
      case 'response': {
        const pending = this.pending.get(message.id);
        if (pending) { this.pending.delete(message.id); pending.cleanup(); pending.resolve(message); }
        else if (message.type === 'done') this.sockets.get(message.id)?.open();
        break;
      }
    }
  }

  private exchange(message: ToWorker, transfer: Transferable[] = [], signal?: AbortSignal): Promise<Extract<FromWorker, { type: 'response' | 'done' }>> {
    const { promise, resolve, reject } = Promise.withResolvers<Extract<FromWorker, { type: 'response' | 'done' }>>();
    const abort = () => {
      this.pending.delete(message.id); signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('The request was aborted.', 'AbortError'));
    };
    if (signal?.aborted) { abort(); return promise; }
    this.pending.set(message.id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
    signal?.addEventListener('abort', abort, { once: true });
    void this.ready.then(() => {
      if (!this.pending.has(message.id)) return;
      if (this.failure) throw this.failure;
      this.worker.postMessage(message, transfer);
    }).catch(reason => {
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); pending.cleanup(); pending.reject(reason); }
    });
    return promise;
  }

  readonly fetch: Transport = async (url, init) => {
    const parsed = new URL(url, typeof location === 'undefined' ? 'http://demo.local' : location.href);
    const request = new Request(parsed, init);
    const body = request.body ? await request.arrayBuffer() : null;
    const message = await this.exchange({ id: ++this.nextId, type: 'request', method: request.method, path: `${parsed.pathname}${parsed.search}`, contentType: request.headers.get('content-type') ?? undefined, body }, body ? [body] : [], request.signal);
    if (message.type !== 'response') throw new Error('The notebook worker did not return a response.');
    return new Response([204, 205, 304].includes(message.status) ? null : message.body, { status: message.status, headers: { 'content-type': message.contentType } });
  };

  readonly stream = (after: number): ChangeSocket => {
    const id = ++this.nextId;
    const socket = new DemoSocket(() => {
      this.sockets.delete(id);
      void this.ready.then(() => {
        if (!this.failure) this.worker.postMessage({ id, type: 'unsubscribe' } satisfies ToWorker);
      }).catch(() => { /* A failed worker has already released the stream. */ });
    });
    this.sockets.set(id, socket);
    void this.ready.then(() => {
      if (socket.readyState !== CHANGE_CONNECTING) return;
      if (this.failure) throw this.failure;
      this.worker.postMessage({ id, type: 'subscribe', after } satisfies ToWorker);
    }).catch(() => { socket.fail(); this.sockets.delete(id); });
    return socket;
  };

  async reset(): Promise<void> {
    const message = await this.exchange({ id: ++this.nextId, type: 'reset' });
    if (message.type !== 'done') throw new Error('The notebook worker did not finish resetting.');
  }

  dispose(): void {
    this.fail(new DemoFailure('internal', 'The notebook worker was closed.'));
    this.worker.terminate();
  }
}

class DemoSocket implements ChangeSocket {
  readyState = CHANGE_CONNECTING;
  onopen: ChangeSocket['onopen'] = null;
  onmessage: ChangeSocket['onmessage'] = null;
  onerror: ChangeSocket['onerror'] = null;
  onclose: ChangeSocket['onclose'] = null;
  constructor(private unsubscribe: () => void) {}

  open(): void {
    if (this.readyState !== CHANGE_CONNECTING) return;
    this.readyState = CHANGE_OPEN;
    this.onopen?.(new Event('open'));
  }
  message(data: string): void {
    if (this.readyState === CHANGE_OPEN) this.onmessage?.(new MessageEvent<string>('message', { data }));
  }
  fail(): void {
    if (this.readyState >= CHANGE_CLOSING) return;
    this.onerror?.(new Event('error'));
    this.close();
  }
  close(): void {
    if (this.readyState >= CHANGE_CLOSING) return;
    this.unsubscribe();
    this.readyState = CHANGE_CLOSING;
    queueMicrotask(() => { this.readyState = CHANGE_CLOSED; this.onclose?.(new CloseEvent('close')); });
  }
}
