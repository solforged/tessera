import { join } from 'node:path';
import { chromium, webkit } from 'playwright-core';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import type { Block, ChangeEvent, Committed, PageView } from '../../src/api/types';
import { api, sleep } from './service';

export type Runtime = 'chromium' | 'webkit';
export interface Outcome { scenario: string; pass: boolean; evidence: string }
export interface Receipt { window: string; at: number; elapsed: number; committed: Pick<Committed, 'seq' | 'revisions'> }
export interface Tracker { receipts: Receipt[]; pollsWhileLive: number; catchUpRequests: number; startedAt: number | null; polls: { window: string; at: number; live: boolean; recovering: boolean; startup: boolean }[]; errors: string[] }
export interface OutboxCounts { notebooks: number; pages: number; commands: number; tickets: number; blocks: number; capabilities: number; cachedPages: number }
export interface HeapSample { used: number; total: number; nodes: number; listeners: number }
export interface StorageSample { outbox: OutboxCounts; pagesOpened: number; mounted: number; domNodes: number }
interface Probe { pending: number; live: boolean; recovering: boolean; observed: number; opened: string[] }
declare global { interface Window { __spike: Probe; __spikeAck(value: Receipt): Promise<void>; __spikePoll(live: boolean, recovering: boolean): Promise<void>; __spikeFailure(message: string): Promise<void> } }

export function percentile(values: readonly number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
export const median = (values: readonly number[]) => percentile(values, .5);
export function budget(name: string, p95: number | null, limit: number): Outcome {
  return { scenario: name, pass: p95 !== null && p95 <= limit, evidence: `${p95 === null ? 'not measured' : `${p95.toFixed(2)} ms`} (limit ${limit} ms)` };
}
export function tracker(): Tracker { return { receipts: [], pollsWhileLive: 0, catchUpRequests: 0, startedAt: null, polls: [], errors: [] }; }
export async function launch(runtime: Runtime): Promise<Browser> {
  if (runtime === 'webkit') return webkit.launch({ headless: true });
  const chrome = process.env.CHROME_PATH ?? join(process.env.HOME!, 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  return chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-precise-memory-info'] });
}

/** Capture successful receipts outside the page, so reloads and tab crashes cannot erase evidence. */
export async function instrument(context: BrowserContext, name: string, result: Tracker) {
  await context.exposeBinding('__spikeAck', (_source, value: Receipt) => { result.receipts.push({ ...value, window: name }); });
  await context.exposeBinding('__spikePoll', (_source, live: boolean, recovering: boolean) => {
    result.polls.push({ window: name, at: Date.now(), live, recovering, startup: result.startedAt === null });
    if (live && !recovering && result.startedAt !== null) result.pollsWhileLive++;
    else result.catchUpRequests++;
  });
  await context.exposeBinding('__spikeFailure', (_source, message: string) => { result.errors.push(`${name}: ${message}`); });
  await context.addInitScript(() => {
    window.__spike = { pending: 0, live: false, recovering: false, observed: 0, opened: [] };
    const original = window.fetch.bind(window);
    window.fetch = Object.assign(async (...args: Parameters<typeof window.fetch>) => {
      const input = args[0];
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
      const method = args[1]?.method ?? (input instanceof Request ? input.method : 'GET');
      const batch = path === '/api/batches' && method.toUpperCase() === 'POST';
      const opened = path.match(/^\/api\/pages\/([0-9A-HJKMNP-TV-Z]{26})$/)?.[1];
      if (opened && !window.__spike.opened.includes(opened)) window.__spike.opened.push(opened);
      const body = args[1]?.body;
      // A provisional journal can open from its local snapshot without a GET /pages request.
      if (batch && typeof body === 'string' && body.includes('"create_journal"')) {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && 'operations' in parsed && Array.isArray(parsed.operations)) {
          for (const operation of parsed.operations) {
            if (operation && typeof operation === 'object' && 'op' in operation && operation.op === 'create_journal' && 'id' in operation && typeof operation.id === 'string' && !window.__spike.opened.includes(operation.id)) window.__spike.opened.push(operation.id);
          }
        }
      }
      if (path === '/api/changes') void window.__spikePoll(window.__spike.live, window.__spike.recovering);
      const start = performance.now();
      if (batch) window.__spike.pending++;
      try {
        const response = await original(...args);
        if (batch) {
          // Reading the cloned body includes the whole round trip, not only response headers.
          const capture = response.clone().json().then(async (committed: Committed) => {
            if (response.ok) await window.__spikeAck({ window: '', at: Date.now(), elapsed: performance.now() - start, committed: { seq: committed.seq, revisions: committed.revisions } });
            else if (response.status !== 409) await window.__spikeFailure(`batch HTTP ${response.status}: ${JSON.stringify(committed)}`);
          }).catch(error => window.__spikeFailure(`Receipt capture: ${String(error)}`)).finally(() => { window.__spike.pending--; });
          await capture;
        }
        return response;
      } catch (error) { if (batch) window.__spike.pending--; throw error; }
    }, original);
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (!String(url).includes('/api/changes/stream')) return;
        this.addEventListener('open', () => { window.__spike.live = true; });
        this.addEventListener('close', () => { window.__spike.live = false; });
        this.addEventListener('message', event => {
          try { const change = JSON.parse(String(event.data)) as ChangeEvent; window.__spike.observed = Math.max(window.__spike.observed, change.seq); } catch { /* The client reports invalid stream messages. */ }
        });
      }
    };
  });
}

export async function open(page: Page, pageId: string, caretId?: string) {
  await page.evaluate(({ pageId, caretId }) => window.dispatchEvent(new CustomEvent('tessera-open', { detail: { kind: 'page', pageId, ...(caretId ? { caretId, caretOffset: 100000 } : {}) } })), { pageId, caretId });
  await page.locator('.pane.active .outline-row[data-block-id]').first().waitFor();
  if (caretId) await page.locator(`.pane.active [data-block-id="${caretId}"] .cm-content`).waitFor();
}
export async function ready(page: Page, base: string) {
  page.setDefaultTimeout(15_000);
  await page.goto(base);
  await page.getByRole('button', { name: 'Find or create', exact: true }).waitFor();
  await page.waitForFunction(() => !!document.querySelector('.pane.active .outline-row') && window.__spike.live);
}
export async function find(page: Page, title: string) {
  await page.keyboard.press('Control+Shift+f');
  await page.getByPlaceholder('Find or create an atom').fill(title);
  const result = page.locator('[role="option"]').filter({ hasText: title }).first();
  await result.waitFor();
  await result.click();
  await page.waitForFunction(title =>
    document.querySelector('.pane.active .outline-title')?.textContent?.trim() === title
      && !document.querySelector('.pane.active [data-pane-pending]')
      && !!document.querySelector('.pane.active .outline-row'),
  title);
}
export async function typeMarker(page: Page, blockId: string, marker: string) {
  const row = page.locator(`.pane.active [data-block-id="${blockId}"] .outline-body`);
  await row.click();
  const editor = page.locator('.pane.active .cm-content');
  await editor.waitFor();
  await editor.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.insertText(` ${marker}`);
}

export async function outbox(page: Page): Promise<OutboxCounts> {
  return page.evaluate(async () => {
    const stores = ['notebooks', 'pages', 'commands', 'tickets', 'blocks', 'capabilities'] as const;
    const connection = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open('tessera-outbox-v1');
    request.onsuccess = () => connection.resolve(request.result);
    request.onerror = () => connection.reject(request.error);
    request.onupgradeneeded = () => { request.transaction?.abort(); connection.reject(new Error('Outbox database does not exist.')); };
    const db = await connection.promise;
    try {
      const pageKeys = Promise.withResolvers<IDBValidKey[]>();
      const pageRequest = db.transaction('pages').objectStore('pages').getAllKeys();
      pageRequest.onsuccess = () => pageKeys.resolve(pageRequest.result);
      pageRequest.onerror = () => pageKeys.reject(pageRequest.error);
      const counts = await Promise.all(stores.map(store => {
        const count = Promise.withResolvers<number>();
        const request = db.transaction(store).objectStore(store).count();
        request.onsuccess = () => count.resolve(request.result);
        request.onerror = () => count.reject(request.error);
        return count.promise;
      }));
      // A page snapshot and its ordered structural patches share notebook:pageId.
      // Keep raw store counts, but do not mistake each patch for another cached page.
      const cachedPages = new Set((await pageKeys.promise).map(key => String(key).split(':').slice(0, 2).join(':'))).size;
      return { ...Object.fromEntries(stores.map((store, index) => [store, counts[index]!])), cachedPages } as OutboxCounts;
    } finally { db.close(); }
  });
}
export async function drained(page: Page, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const saved = await page.evaluate(() => window.__spike.pending === 0 && !!document.querySelector('.pane.active .pane-save-state[data-state="saved"]'));
    if (saved && (await outbox(page)).commands === 0) return;
    await sleep(25);
  }
  const evidence = await page.evaluate(() => ({
    probe: window.__spike,
    states: [...document.querySelectorAll('.pane-save-state')].map(element => ({ state: element.getAttribute('data-state'), message: element.getAttribute('title') })),
    alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
  }));
  throw new Error(`Outbox did not drain: ${JSON.stringify({ ...evidence, outbox: await outbox(page) })}`);
}

/** Unfolded workload pages are checked across every viewport, not only mounted rows. Writers must be paused. */
export async function converged(page: Page, base: string, pageId: string) {
  await drained(page);
  const view = await api<PageView>(base, `/api/pages/${pageId}`);
  const expected = Object.fromEntries(view.rows.map(({ block, depth }, index) => [block.id, { text: block.text, level: depth + 1, index }]));
  const seen = new Set<string>();
  const pane = page.locator('.pane.active .outline-pane');
  await pane.evaluate(element => { element.scrollTop = 0; });
  let previous = -1;
  for (let step = 0; step < view.rows.length + 10; step++) {
    await page.waitForFunction(expected => {
      const rows = [...document.querySelectorAll<HTMLElement>('.pane.active .outline-row[data-block-id]')];
      return rows.length > 0 && rows.every(row => {
        const block = expected[row.dataset.blockId!];
        return block && row.querySelector('.outline-body')?.textContent === block.text && Number(row.getAttribute('aria-level')) === block.level && Number(row.dataset.index) === block.index;
      });
    }, expected, { polling: 10, timeout: 15_000 });
    const snapshot = await pane.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight, ids: [...element.querySelectorAll<HTMLElement>('.outline-row[data-block-id]')].map(row => row.dataset.blockId!) }));
    for (const id of snapshot.ids) seen.add(id);
    if (snapshot.top + snapshot.height >= snapshot.total - 1 || snapshot.top === previous) break;
    previous = snapshot.top;
    await pane.evaluate(element => { element.scrollTop += Math.max(100, element.clientHeight * .7); });
    await page.evaluate(() => {
      const frame = Promise.withResolvers<void>();
      requestAnimationFrame(() => requestAnimationFrame(() => frame.resolve()));
      return frame.promise;
    });
  }
  await pane.evaluate(element => { element.scrollTop = 0; });
  const missing = view.rows.filter(({ block }) => !seen.has(block.id));
  if (missing.length) throw new Error(`View omitted ${missing.length}/${view.rows.length} server rows after reconnect.`);
}

const sessions = new WeakMap<Page, CDPSession>();
export async function heap(page: Page): Promise<HeapSample> {
  let session = sessions.get(page);
  if (!session) { session = await page.context().newCDPSession(page); await session.send('Performance.enable'); sessions.set(page, session); }
  const result = await session.send('Performance.getMetrics');
  const values = Object.fromEntries(result.metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value]));
  return { used: values.JSHeapUsedSize ?? 0, total: values.JSHeapTotalSize ?? 0, nodes: values.Nodes ?? 0, listeners: values.JSEventListeners ?? 0 };
}
export async function storage(page: Page): Promise<StorageSample> {
  return { outbox: await outbox(page), ...await page.evaluate(() => ({ pagesOpened: window.__spike.opened.length, mounted: document.querySelectorAll('[data-block-id]').length, domNodes: document.getElementsByTagName('*').length })) };
}

export interface RevisionCheck { lost: number; checkedReceipts: number; checkedRevisions: number; evidence: string[] }
/** Change replay returns current block state, so check event membership and revision floors. */
export async function verify(base: string, receipts: readonly Receipt[], markers: readonly string[] = []): Promise<RevisionCheck> {
  const wanted = new Map<number, Map<string, number>>();
  for (const receipt of receipts) {
    const revisions = wanted.get(receipt.committed.seq) ?? new Map<string, number>();
    for (const revision of receipt.committed.revisions) revisions.set(revision.id, revision.revision);
    wanted.set(receipt.committed.seq, revisions);
  }
  const missing: string[] = [];
  let after = Number.MAX_SAFE_INTEGER;
  for (const seq of wanted.keys()) after = Math.min(after, seq - 1);
  if (wanted.size) {
    while (true) {
      const changes = await api<ChangeEvent[]>(base, `/api/changes?after=${after}&limit=500`);
      for (const change of changes) {
        const expected = wanted.get(change.seq);
        if (expected) for (const block of change.blocks) if ((expected.get(block.id) ?? Infinity) <= block.revision) expected.delete(block.id);
        after = change.seq;
      }
      if (!changes.length) break;
    }
    for (const [seq, revisions] of wanted) for (const [id, revision] of revisions) missing.push(`seq ${seq}: ${id}@${revision}`);
  }
  const roots = await api<Block[]>(base, '/api/roots');
  const live = new Map<string, Block>();
  const texts: string[] = [];
  for (const root of roots) {
    const view = await api<PageView>(base, `/api/pages/${root.id}`);
    for (const block of [view.root, ...view.rows.map(row => row.block)]) { live.set(block.id, block); texts.push(block.text); }
  }
  const latest = new Map<string, number>();
  for (const receipt of receipts) for (const { id, revision } of receipt.committed.revisions) latest.set(id, Math.max(latest.get(id) ?? 0, revision));
  for (const [id, revision] of latest) if ((live.get(id)?.revision ?? 0) < revision) missing.push(`live ${id}@${revision}`);
  const text = texts.join('\n');
  for (const marker of markers) if (!text.includes(marker)) missing.push(`marker ${marker}`);
  return { lost: missing.length, checkedReceipts: receipts.length, checkedRevisions: receipts.reduce((sum, receipt) => sum + receipt.committed.revisions.length, 0), evidence: missing };
}

export function duration(defaultMinutes: number) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || !['--minutes', '--hours'].includes(args[0]!))) throw new Error('Usage: --minutes N or --hours N');
  const minutes = args.length ? Number(args[1]) * (args[0] === '--hours' ? 60 : 1) : defaultMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Duration must be a positive number.');
  return { milliseconds: minutes * 60_000, smoke: args[0] === '--minutes' };
}
export function random(seed: number) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 0x100000000; };
}
