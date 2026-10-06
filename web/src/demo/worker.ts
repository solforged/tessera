import init, * as wasm from './pkg/tessera_web.js';
import type { Subscription } from './pkg/tessera_web.js';
import type { Fields, NotebookInfo, SettingsView } from '../api/types';
import type { FailureCode, FromWorker, ToWorker } from './protocol';
import { seedBatch } from './seed';

const scope = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const subscriptions = new Map<number, Subscription>();
const send = (message: FromWorker, transfer?: Transferable[]) => scope.postMessage(message, transfer);

function failed(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  const prefix = message.split(':', 1)[0];
  const code: FailureCode = prefix === 'locked' || prefix === 'unsupported' ? prefix : 'internal';
  send({ type: 'failed', code, message: message.replace(/^(locked|unsupported|internal):\s*/, '') });
}

// A Rust panic can throw from a wasm async microtask without rejecting its original Promise.
self.addEventListener('error', event => failed(event.error ?? event.message));
self.addEventListener('unhandledrejection', event => failed(event.reason));

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await wasm.handle(method, path, body === undefined ? undefined : 'application/json', body === undefined ? new Uint8Array() : encoder.encode(JSON.stringify(body)));
  try {
    const text = decoder.decode(response.body);
    if (response.status < 200 || response.status >= 300) throw new Error(`internal: The demo could not prepare its notebook (${response.status}): ${text}`);
    return JSON.parse(text) as T;
  } finally { response.free(); }
}

async function seed(): Promise<void> {
  const fields = await json<Fields>('GET', '/api/fields');
  const settings = await json<SettingsView>('GET', '/api/settings');
  const batch = seedBatch(fields.page_id);
  batch.operations.unshift({ op: 'set_setting', key: 'time_zone', base_revision: settings.settings.find(value => value.key === 'time_zone')?.revision ?? null, value: Intl.DateTimeFormat().resolvedOptions().timeZone });
  await json('POST', '/api/batches', batch);
}

const boot = (async () => {
  if (!navigator.storage?.getDirectory || typeof FileSystemFileHandle === 'undefined' || !('createSyncAccessHandle' in FileSystemFileHandle.prototype)) {
    throw new Error('unsupported: This browser does not support the private file storage Tessera needs (OPFS). Try a recent version of Chrome, Edge, Firefox or Safari.');
  }
  await init();
  await wasm.open();
  if (wasm.is_empty()) await seed();
  send({ type: 'ready', info: await json<NotebookInfo>('GET', '/api/notebook') });
})();
void boot.catch(failed);

async function receive(message: ToWorker): Promise<void> {
  await boot;
  switch (message.type) {
    case 'request': {
      const response = await wasm.handle(message.method, message.path, message.contentType, message.body ? new Uint8Array(message.body) : new Uint8Array());
      try {
        // wasm-bindgen owns the response; copy its bytes before freeing it or transferring them.
        const body = Uint8Array.from(response.body).buffer;
        send({ id: message.id, type: 'response', status: response.status, contentType: response.content_type, body }, [body]);
      } finally { response.free(); }
      break;
    }
    case 'subscribe':
      // Queue the open acknowledgement before synchronous catch-up callbacks.
      send({ id: message.id, type: 'done' });
      subscriptions.set(message.id, wasm.subscribe(message.after, event => send({ id: message.id, type: 'change', event })));
      break;
    case 'unsubscribe': {
      const subscription = subscriptions.get(message.id);
      if (subscription) { subscription.close(); subscription.free(); subscriptions.delete(message.id); }
      send({ id: message.id, type: 'done' });
      break;
    }
    case 'reset':
      for (const subscription of subscriptions.values()) { subscription.close(); subscription.free(); }
      subscriptions.clear();
      await wasm.reset();
      await seed();
      send({ id: message.id, type: 'done' });
      break;
  }
}

// Serialize requests and reset around the engine's one SQLite connection.
let work = boot;
scope.onmessage = event => {
  const message = event.data;
  work = work.then(() => receive(message)).catch(reason => {
    if (message.type === 'request') {
      const body = encoder.encode(JSON.stringify({ error: { code: 'internal', message: reason instanceof Error ? reason.message : String(reason) } })).buffer;
      send({ id: message.id, type: 'response', status: 500, contentType: 'application/json', body }, [body]);
    } else failed(reason);
  });
};
