import { createRoot, createSignal } from 'solid-js';
import { api } from '../api/client';
import type { SyncConflicts, SyncDevices, SyncState } from '../api/types';
import { DEMO, EMBEDDED } from '../demo/mode';

/** How often an open replica asks for its sync state; the runner itself syncs on its own schedule. */
const POLL_MS = 5000;
/** While the app is on screen, a replica whose last sync is older than this syncs again. */
export const FRESH_MS = 30_000;

/**
 * Whether an open replica should sync now. Opening the app tries once even after a failure; while it stays open, a
 * failing replica waits for the runner's backoff instead. A retired or forgotten copy has nothing to sync.
 */
export function syncDue(value: SyncState | null, opening: boolean, now = Date.now()): boolean {
  const replica = value?.role === 'replica' ? value.replica : null;
  if (!replica || replica.syncing || replica.retired) return false;
  if (replica.last_error && (!opening || ['unpaired', 'wrong_device', 'retired'].includes(replica.last_error.code))) return false;
  return replica.synced_at === null || now - replica.synced_at >= FRESH_MS;
}

/**
 * This device's sync role, outbox and last sync, shared by the rail, cover, summary and Settings.
 * An open replica syncs every half minute so the Mac's edits arrive sooner than the background schedule.
 * The browser demo has no sync.
 */
export const sync = createRoot(() => {
  const [state, setState] = createSignal<SyncState | null>(null);
  const [now, setNow] = createSignal(Date.now());
  let timer = 0;
  let inflight: Promise<SyncState | null> | null = null;
  let running = false;
  // The next state read follows loading or returning to the app.
  let opening = true;
  const visible = () => document.visibilityState === 'visible';
  const schedule = () => {
    window.clearTimeout(timer);
    // Only a replica changes underneath the page; a hub or a standalone notebook is read once per refresh.
    if (state()?.role === 'replica' && visible()) timer = window.setTimeout(() => { void refresh(); }, POLL_MS);
  };
  const run = () => {
    running = true;
    void api.runSync().then(setState, () => undefined).finally(() => { running = false; schedule(); });
  };
  const refresh = (): Promise<SyncState | null> => {
    if (DEMO) return Promise.resolve(null);
    inflight ??= api.syncState().then(value => {
      setState(value);
      setNow(Date.now());
      if (value.role !== 'replica') void hubDevices.refresh();
      if (value.role !== 'none') void syncConflicts.refresh();
      const wasOpening = opening;
      opening = false;
      if (!running && visible() && syncDue(value, wasOpening)) run();
      return value;
    }, () => state()).finally(() => { inflight = null; schedule(); });
    return inflight;
  };
  if (!DEMO && typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    if (visible()) { opening = true; void refresh(); }
    else window.clearTimeout(timer);
  });
  return { state, now, refresh, set: (value: SyncState) => {
    setState(value); setNow(Date.now()); schedule();
    if (value.role !== 'replica') void hubDevices.refresh();
    if (value.role !== 'none') void syncConflicts.refresh();
  }, tick: () => setNow(Date.now()) };
});

/**
 * Hub records are shared rather than fetched again by every indicator and device row. A Mac with no paired device
 * reports role `none`, and still needs them: they hold the sharing switch that pairs its first phone.
 */
export const hubDevices = createRoot(() => {
  const [state, setState] = createSignal<SyncDevices | null>(null);
  let timer = 0;
  let inflight: Promise<SyncDevices | null> | null = null;
  const schedule = () => {
    window.clearTimeout(timer);
    if (sync.state()?.role === 'hub' && state()?.devices.length && document.visibilityState === 'visible') {
      timer = window.setTimeout(() => { void refresh(); }, POLL_MS);
    }
  };
  const refresh = (): Promise<SyncDevices | null> => {
    if (EMBEDDED || !sync.state() || sync.state()!.role === 'replica') return Promise.resolve(null);
    inflight ??= api.syncDevices().then(value => { setState(value); sync.tick(); void syncConflicts.refresh(); return value; }, () => state())
      .finally(() => { inflight = null; schedule(); });
    return inflight;
  };
  if (!DEMO && typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
    else window.clearTimeout(timer);
  });
  return { state, refresh, set: (value: SyncDevices) => { setState(value); schedule(); } };
});

/** A hub needs its own review counts too. Replica polling and hub-device polling keep these current. */
export const syncConflicts = createRoot(() => {
  const [state, setState] = createSignal<SyncConflicts | null>(null);
  let inflight: Promise<SyncConflicts | null> | null = null;
  const refresh = (): Promise<SyncConflicts | null> => {
    if (DEMO || !sync.state() || sync.state()?.role === 'none') return Promise.resolve(null);
    inflight ??= api.syncConflicts().then(value => { setState(value); return value; }, () => state()).finally(() => { inflight = null; });
    return inflight;
  };
  return { state, refresh };
});

export const replica = () => sync.state()?.replica ?? null;


/** `4 minutes ago`, `just now`, `3 days ago`. */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  return format.format(Math.round(hours / 24), 'day');
}

/** `186 MB`, `2.1 MB`, `640 KB`. */
export function size(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${unit > 0 && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
