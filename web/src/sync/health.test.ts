import { expect, test } from 'bun:test';
import type { PairedDevice, ReplicaState, SyncConflicts, SyncDevices, SyncState } from '../api/types';
import { SUSTAINED_OUTAGE_MS, syncHealth } from './health';

const now = 1_800_000_000_000;
const version = { version: '0.3.0', build: null, schema: 35 };
const replica = (changes: Partial<ReplicaState> = {}, schema = 35): SyncState => ({
  this_device: { ...version, schema }, role: 'replica', replica: {
    hub_url: 'https://hyperion.example:4319', hub_name: 'the Mac', device_name: 'Fold', device_id: 'fold',
    pending: 0, unapplied: 0, synced_at: now - 120_000, syncing: false, last_error: null, retired: false,
    hub_version: version, failing_since: null, attempts: [], kept_copies: 0, rejected: 0,
    offline: { books: 0, bytes: 0 }, ...changes,
  },
});
const hub: SyncState = { this_device: version, role: 'hub', replica: null };
const devices = (changes: Partial<PairedDevice> = {}, schema = 35): SyncDevices => ({
  this_device: { ...version, schema }, hub_name: 'hyperion', sharing: { available: true, on: true, url: null, error: null },
  retained: { changes: 0, bytes: 0 }, devices: [{
    id: 'fold', name: 'Fold', paired_at: now - 1000, state: 'active', last_seen_at: now - 120_000,
    retired_at: null, version, last_attempt_at: now, refused: null, attempts: [], ...changes,
  }],
});
const error = (code: string) => ({ code, message: 'Sync failed' });

test('replica precedence preserves the actionable failure above review, contact and sending', () => {
  const overlap = { pending: 3, syncing: true, kept_copies: 1, rejected: 2, failing_since: now - SUSTAINED_OUTAGE_MS };
  expect(syncHealth(replica({ ...overlap, last_error: error('unpaired') }), null, now)?.kind).toBe('forgotten');
  expect(syncHealth(replica({ ...overlap, retired: true, last_error: error('schema_mismatch') }), null, now)?.kind).toBe('retired');
  expect(syncHealth(replica({ ...overlap, last_error: error('schema_mismatch') }), null, now)?.kind).toBe('version');
  expect(syncHealth(replica({ ...overlap, last_error: error('hub_unreachable') }), null, now)?.kind).toBe('review');
  expect(syncHealth(replica({ pending: 3, syncing: true, last_error: error('hub_unreachable') }), null, now)?.kind).toBe('unreachable');
  expect(syncHealth(replica({ pending: 3 }), null, now)?.kind).toBe('sending');
  expect(syncHealth(replica(), null, now)?.kind).toBe('synced');
});

test('an outage becomes rubric at exactly two hours only when local changes are waiting', () => {
  const failing = { pending: 3, last_error: error('hub_unreachable') };
  expect(syncHealth(replica({ ...failing, failing_since: now - SUSTAINED_OUTAGE_MS + 1 }), null, now)?.tone).toBe('muted');
  expect(syncHealth(replica({ ...failing, failing_since: now - SUSTAINED_OUTAGE_MS }), null, now)?.tone).toBe('rubric');
  expect(syncHealth(replica({ ...failing, pending: 0, failing_since: now - SUSTAINED_OUTAGE_MS }), null, now)?.tone).toBe('muted');
  expect(syncHealth(replica({ ...failing, failing_since: null }), null, now)?.tone).toBe('muted');
});

test('schema comparison names the behind side on both hub and replica, not the reporting side', () => {
  expect(syncHealth(replica({ last_error: error('schema_mismatch') }, 33), null, now)?.behind).toBe('replica');
  expect(syncHealth(replica({ last_error: error('schema_mismatch'), hub_version: { ...version, schema: 33 } }), null, now)?.behind).toBe('hub');
  const refused = { code: 'schema_mismatch', message: 'Wrong schema', since: now - 2000, attempts: 14 };
  expect(syncHealth(hub, devices({ refused, version: { ...version, schema: 33 } }), now)?.behind).toBe('replica');
  expect(syncHealth(hub, devices({ refused }, 33), now)?.behind).toBe('hub');
  expect(syncHealth(replica({ last_error: error('schema_mismatch'), hub_version: null }), null, now)?.behind).toBeNull();
});

test('hub retirement outranks refusal, which outranks its own review count', () => {
  const conflicts: SyncConflicts = { kept: [], rejected: [{ id: 'r', change_id: 'c', error: '', created_at: now, origin: 'fold', origin_name: 'Fold', mine: false, page_id: null, page_title: null, texts: [] }] };
  const refused = { code: 'schema_mismatch', message: '', since: now, attempts: 1 };
  expect(syncHealth(hub, devices({ state: 'retired', refused }), now, conflicts)?.kind).toBe('retired');
  expect(syncHealth(hub, devices({ refused }), now, conflicts)?.kind).toBe('version');
  expect(syncHealth(hub, devices(), now, conflicts)?.kind).toBe('review');
});

test('synced, standalone, unpaired hubs and the demo have no cover mark', () => {
  expect(syncHealth(replica(), null, now)?.cover).toBeNull();
  expect(syncHealth(hub, devices(), now)?.cover).toBeNull();
  expect(syncHealth({ this_device: version, role: 'none', replica: null }, null, now)).toBeNull();
  expect(syncHealth(hub, { ...devices(), devices: [] }, now)).toBeNull();
  expect(syncHealth(replica({ pending: 3 }), null, now, null, true)).toBeNull();
});
