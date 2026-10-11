import { createRoot, createSignal } from 'solid-js';
import { api } from '../api/client';
import type { SyncState } from '../api/types';
import { DEMO } from '../demo/mode';

/** How often an open replica asks for its sync state; the runner itself syncs on its own schedule. */
const POLL_MS = 5000;

/**
 * This device's sync role and, on a replica, its outbox and last sync, shared by the top-bar status, the sync sheet and
 * Settings. The browser demo has no sync, so it stays null there.
 */
export const sync = createRoot(() => {
  const [state, setState] = createSignal<SyncState | null>(null);
  let timer = 0;
  let inflight: Promise<SyncState | null> | null = null;
  const schedule = () => {
    window.clearTimeout(timer);
    // Only a replica changes underneath the page; a hub or a standalone notebook is read once per refresh.
    if (state()?.role === 'replica' && document.visibilityState === 'visible') timer = window.setTimeout(() => { void refresh(); }, POLL_MS);
  };
  const refresh = (): Promise<SyncState | null> => {
    if (DEMO) return Promise.resolve(null);
    inflight ??= api.syncState().then(value => { setState(value); return value; }, () => state()).finally(() => { inflight = null; schedule(); });
    return inflight;
  };
  if (!DEMO && typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); else window.clearTimeout(timer); });
  return { state, refresh, set: (value: SyncState) => { setState(value); schedule(); } };
});

export const replica = () => sync.state()?.replica ?? null;

/** The Mac no longer accepts this device's key: it was forgotten in Settings › Devices and must pair again. */
export const forgotten = () => ['unpaired', 'wrong_device'].includes(replica()?.last_error?.code ?? '');

/** A sync failure in plain words; the service's message stays in the tooltip for diagnosis. */
export function problem(error: { code: string; message: string }): string {
  if (error.code === 'hub_unreachable') return 'Can’t reach the Mac. Tessera tries again shortly.';
  if (error.code === 'schema_mismatch') return 'The Mac runs a different version of Tessera. Update both to sync.';
  if (error.code === 'unpaired' || error.code === 'wrong_device') return 'The Mac forgot this device. Pair it again to sync.';
  return error.message;
}

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
