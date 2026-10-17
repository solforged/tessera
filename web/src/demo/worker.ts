import init, * as wasm from './pkg/tessera_web.js';
import { ulid } from 'ulid';
import type { Subscription } from './pkg/tessera_web.js';
import type { Fields, IngestJob, NotebookInfo, Operation, PageView, Passage, PassagePage, SettingsView } from '../api/types';
import type { FailureCode, FromWorker, ToWorker } from './protocol';
import { bookHighlights, locateHighlights, seedBatch } from './seed';
import type { SeedBook } from './seed';
import type { UpgradeCopy } from './notebook';
import bookUrl from './meditations.epub?url';

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
  const response = await wasm.handle(method, path, body === undefined ? [] : ['content-type', 'application/json'], body === undefined ? new Uint8Array() : encoder.encode(JSON.stringify(body)));
  try {
    const text = decoder.decode(response.body);
    if (response.status < 200 || response.status >= 300) throw new Error(`internal: The demo could not prepare its workshop (${response.status}): ${text}`);
    return JSON.parse(text) as T;
  } finally { response.free(); }
}

/** Ingest the bundled public-domain book and find the passages to highlight; the tour still works without it. */
async function ingestBook(): Promise<SeedBook | undefined> {
  try {
    const download = await fetch(bookUrl);
    if (!download.ok) throw new Error(`HTTP ${download.status}`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    const response = await wasm.handle('POST', '/api/library/uploads', ['content-type', 'application/epub+zip', 'x-filename', 'Meditations.epub'], bytes);
    let job: IngestJob;
    try {
      const text = decoder.decode(response.body);
      if (response.status !== 201) throw new Error(`HTTP ${response.status}: ${text}`);
      job = JSON.parse(text) as IngestJob;
    } finally { response.free(); }
    // Uploads are ingested before the response returns.
    const finished = await json<IngestJob>('GET', `/api/library/jobs/${job.id}`);
    const { source_id: id, snapshot_id: snapshotId } = finished;
    if (finished.state !== 'done' || !id || !snapshotId) throw new Error(finished.error ?? `The job is ${finished.state}.`);
    const passages: Passage[] = [];
    for (let total = Infinity; passages.length < total;) {
      const page = await json<PassagePage>('GET', `/api/snapshots/${snapshotId}/passages?from=${passages.length}&limit=500`);
      if (!page.passages.length) break;
      passages.push(...page.passages); total = page.total;
    }
    const source = await json<PageView>('GET', `/api/pages/${id}`);
    const highlights = locateHighlights(passages);
    if (highlights.length < bookHighlights.length) console.warn(`The demo book's text no longer contains ${bookHighlights.length - highlights.length} of the tour's highlights.`);
    return { id, after: source.rows.filter(row => row.block.parent_id === id).at(-1)?.block.id ?? null, snapshotId, highlights };
  } catch (reason) {
    console.warn('The demo book could not be added.', reason);
    return undefined;
  }
}

async function timeZoneSetting(): Promise<Operation> {
  const settings = await json<SettingsView>('GET', '/api/settings');
  return { op: 'set_setting', key: 'time_zone', base_revision: settings.settings.find(value => value.key === 'time_zone')?.revision ?? null, value: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

async function seed(): Promise<void> {
  const book = await ingestBook();
  const fields = await json<Fields>('GET', '/api/fields');
  const timeZone = await timeZoneSetting();
  const batch = seedBatch(fields.page_id, undefined, book);
  batch.operations.unshift(timeZone);
  await json('POST', '/api/batches', batch);
}

const boot = (async () => {
  if (!navigator.storage?.getDirectory || typeof FileSystemFileHandle === 'undefined' || !('createSyncAccessHandle' in FileSystemFileHandle.prototype)) {
    throw new Error('unsupported: This browser does not support the private file storage Tessera needs (OPFS). Try a recent version of Chrome, Edge, Firefox or Safari.');
  }
  await init();
  const info = JSON.parse(await wasm.open()) as NotebookInfo;
  const settings = await json<SettingsView>('GET', '/api/settings');
  const fresh = wasm.is_empty() && !settings.settings.some(value => value.key === 'time_zone');
  send({ type: 'ready', info, fresh });
})();
void boot.catch(failed);

function closeSubscriptions(): void {
  for (const subscription of subscriptions.values()) { subscription.close(); subscription.free(); }
  subscriptions.clear();
}

async function receive(message: ToWorker): Promise<void> {
  await boot;
  switch (message.type) {
    case 'request': {
      const response = await wasm.handle(message.method, message.path, message.headers.flat(), message.body ? new Uint8Array(message.body) : new Uint8Array());
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
    case 'start':
      if (message.kind === 'tour') await seed();
      else await json('POST', '/api/batches', { actor: { kind: 'client', name: 'Tessera' }, idempotency_key: ulid(), operations: [await timeZoneSetting()] });
      send({ id: message.id, type: 'done' });
      break;
    case 'export':
    case 'export-upgrade-copy': {
      const body = (message.type === 'export' ? wasm.export_notebook() : wasm.export_upgrade_copy()).buffer as ArrayBuffer;
      send({ id: message.id, type: 'bytes', body }, [body]);
      break;
    }
    case 'upgrade-copy': {
      const copy = wasm.upgrade_copy();
      send({ id: message.id, type: 'upgrade-copy', copy: copy === undefined ? null : JSON.parse(copy) as UpgradeCopy });
      break;
    }
    case 'restore':
    case 'restore-upgrade-copy': {
      closeSubscriptions();
      const info = JSON.parse(await (message.type === 'restore' ? wasm.restore_notebook(new Uint8Array(message.body)) : wasm.restore_upgrade_copy())) as NotebookInfo;
      send({ id: message.id, type: 'restored', info });
      break;
    }
    case 'reset':
      closeSubscriptions();
      await wasm.reset();
      send({ id: message.id, type: 'done' });
      break;
    case 'close':
      closeSubscriptions();
      wasm.close();
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
    } else {
      const text = reason instanceof Error ? reason.message : String(reason);
      send({ id: message.id, type: 'error', code: text.startsWith('invalid:') ? 'invalid' : 'internal', message: text.replace(/^(invalid|internal):\s*/, '') });
    }
  });
};
