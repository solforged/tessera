import { createRoot, createSignal } from 'solid-js';
import { api } from '../api/client';
import type { SyncState } from '../api/types';
import { DEMO } from '../demo/mode';

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
 * This device's sync role and, on a replica, its outbox and last sync, shared by the top-bar status, the sync sheet and
 * Settings. On a replica it also syncs when the app opens and every half minute while it stays on screen, so the Mac's
 * edits arrive sooner than the runner's background schedule. The browser demo has no sync, so it stays null there.
 */
export const sync = createRoot(() => {
  const [state, setState] = createSignal<SyncState | null>(null);
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
  return { state, refresh, set: (value: SyncState) => { setState(value); schedule(); } };
});

/**
 * Split the outbox into changes still applied here and changes whose latest replay failed.
 * A failed replay stays in the outbox for the hub, but it is not counted as waiting.
 */
export function outboxParts(pending: number, unapplied: number): { waiting: number; unapplied: number } {
  const failed = Math.min(Math.max(0, unapplied), Math.max(0, pending));
  return { waiting: Math.max(0, pending) - failed, unapplied: failed };
}

/** Top-bar counts. A fully unapplied outbox reads as “N not applied”, not “N waiting”. */
export function outboxText(pending: number, unapplied: number): string {
  const parts = outboxParts(pending, unapplied);
  return [
    parts.waiting ? `${parts.waiting} waiting` : '',
    parts.unapplied ? `${parts.unapplied} not applied` : '',
  ].filter(Boolean).join(', ');
}

/** Sheet heading. “Everything sent” only when nothing is waiting and nothing failed to replay. */
export function outboxHeading(pending: number, unapplied: number): string {
  const parts = outboxParts(pending, unapplied);
  if (parts.waiting) return `${plural(parts.waiting, 'change')} waiting`;
  if (parts.unapplied) return `${plural(parts.unapplied, 'change')} not applied`;
  return 'Everything sent';
}

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
