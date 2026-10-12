import { expect, test } from 'bun:test';
import type { ReplicaState, SyncState } from '../api/types';
import { FRESH_MS, outboxHeading, outboxParts, outboxText, syncDue } from './state';

const now = 1_800_000_000_000;
const replica = (changes: Partial<ReplicaState> = {}): SyncState => ({
  role: 'replica',
  replica: {
    hub_url: 'https://mac.example:4319', hub_name: 'mac', device_name: 'phone', device_id: 'd',
    pending: 0, unapplied: 0, unapplied_errors: [], synced_at: now - FRESH_MS, syncing: false, last_error: null, retired: false,
    kept_copies: 0, rejected: 0, offline: { books: 0, bytes: 0 }, ...changes,
  },
});

test('an open replica syncs once its last sync is half a minute old, not before', () => {
  expect(syncDue(replica(), false, now)).toBe(true);
  expect(syncDue(replica({ synced_at: now - FRESH_MS + 1 }), false, now)).toBe(false);
  expect(syncDue(replica({ synced_at: null }), false, now)).toBe(true);
});

test('opening the app retries a failed sync once; staying open leaves failures to the backoff', () => {
  const failing = replica({ last_error: { code: 'hub_unreachable', message: 'offline' } });
  expect(syncDue(failing, true, now)).toBe(true);
  expect(syncDue(failing, false, now)).toBe(false);
});

test('a failed replay is not applied, and the rest of the outbox is still waiting', () => {
  expect(outboxParts(0, 0)).toEqual({ waiting: 0, unapplied: 0 });
  expect(outboxParts(3, 0)).toEqual({ waiting: 3, unapplied: 0 });
  expect(outboxParts(3, 1)).toEqual({ waiting: 2, unapplied: 1 });
  expect(outboxParts(1, 1)).toEqual({ waiting: 0, unapplied: 1 });
  expect(outboxParts(1, 4)).toEqual({ waiting: 0, unapplied: 1 });
  expect(outboxText(3, 1)).toBe('2 waiting, 1 not applied');
  expect(outboxText(1, 1)).toBe('1 not applied');
  expect(outboxHeading(3, 1)).toBe('2 changes waiting');
  expect(outboxHeading(1, 1)).toBe('1 change not applied');
  expect(outboxHeading(0, 0)).toBe('Everything sent');
});

test('a forgotten, retired, busy or non-replica notebook never syncs on its own', () => {
  expect(syncDue(replica({ last_error: { code: 'unpaired', message: '' } }), true, now)).toBe(false);
  expect(syncDue(replica({ last_error: { code: 'wrong_device', message: '' } }), true, now)).toBe(false);
  expect(syncDue(replica({ retired: true }), true, now)).toBe(false);
  expect(syncDue(replica({ syncing: true }), true, now)).toBe(false);
  expect(syncDue({ role: 'hub', replica: null }, true, now)).toBe(false);
  expect(syncDue(null, true, now)).toBe(false);
});
