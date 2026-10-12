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

test('an outage changes its hint at exactly two hours only when local changes are waiting', () => {
  const failing = { pending: 3, last_error: error('hub_unreachable') };
  expect(syncHealth(replica({ ...failing, failing_since: now - SUSTAINED_OUTAGE_MS + 1 }), null, now)).toMatchObject({
    tone: 'wait', hint: 'Tessera keeps trying.',
  });
  expect(syncHealth(replica({ ...failing, failing_since: now - SUSTAINED_OUTAGE_MS }), null, now)).toMatchObject({
    tone: 'wait', hint: 'Check Tailscale or the Mac.',
  });
  expect(syncHealth(replica({ ...failing, failing_since: now - SUSTAINED_OUTAGE_MS - 1 }), null, now)).toMatchObject({
    tone: 'wait', hint: 'Check Tailscale or the Mac.',
  });
  expect(syncHealth(replica({ ...failing, pending: 0, failing_since: now - SUSTAINED_OUTAGE_MS }), null, now)).toMatchObject({
    tone: 'wait', hint: 'Tessera keeps trying.',
  });
  expect(syncHealth(replica({ ...failing, failing_since: null }), null, now)).toMatchObject({
    tone: 'wait', hint: 'Tessera keeps trying.',
  });
});

test('schema comparison names the behind side on both hub and replica, not the reporting side', () => {
  expect(syncHealth(replica({ last_error: error('schema_mismatch') }, 33), null, now)).toMatchObject({
    behind: 'replica', tone: 'act', hint: 'Update Fold to sync.',
  });
  expect(syncHealth(replica({ last_error: error('schema_mismatch'), hub_version: { ...version, schema: 33 } }), null, now)).toMatchObject({
    behind: 'hub', tone: 'act', hint: 'Update the Mac to sync.',
  });
  const refused = { code: 'schema_mismatch', message: 'Wrong schema', since: now - 2000, attempts: 14 };
  expect(syncHealth(hub, devices({ refused, version: { ...version, schema: 33 } }), now)).toMatchObject({
    behind: 'replica', tone: 'act', hint: 'Update Fold to sync.',
  });
  expect(syncHealth(hub, devices({ refused }, 33), now)).toMatchObject({
    behind: 'hub', tone: 'act', hint: 'Update hyperion to sync.',
  });
  expect(syncHealth(replica({ last_error: error('schema_mismatch'), hub_version: null }), null, now)).toMatchObject({
    behind: null, tone: 'act', hint: 'Update both devices to sync.',
  });
  expect(syncHealth(hub, devices({ refused }), now)).toMatchObject({
    behind: null, tone: 'act', hint: 'Update both devices to sync.',
  });
});

test('hub retirement outranks refusal, which outranks its own review count', () => {
  const conflicts: SyncConflicts = { kept: [], rejected: [{ id: 'r', change_id: 'c', error: '', created_at: now, origin: 'fold', origin_name: 'Fold', mine: false, page_id: null, page_title: null, texts: [] }] };
  const refused = { code: 'schema_mismatch', message: '', since: now, attempts: 1 };
  expect(syncHealth(hub, devices({ state: 'retired', refused }), now, conflicts)).toMatchObject({
    kind: 'retired', tone: 'act', hint: 'Fold must download the notebook again.',
  });
  expect(syncHealth(hub, devices({ refused }), now, conflicts)).toMatchObject({ kind: 'version', tone: 'act' });
  expect(syncHealth(hub, devices(), now, conflicts)).toMatchObject({
    kind: 'review', tone: 'wait', hint: 'Review when convenient.',
  });
});

test('synced and sending are ok without a cover mark', () => {
  expect(syncHealth(replica(), null, now)).toMatchObject({ kind: 'synced', tone: 'ok', cover: null, hint: 'Click for details.' });
  expect(syncHealth(hub, devices(), now)).toMatchObject({ kind: 'synced', tone: 'ok', cover: null, hint: 'Click for details.' });
  for (const changes of [{ pending: 3 }, { syncing: true }, { unapplied: 1 }]) {
    expect(syncHealth(replica(changes), null, now)).toMatchObject({ kind: 'sending', tone: 'ok', cover: null, hint: 'Click for details.' });
  }
});

test('forgotten and retired replicas need action', () => {
  for (const code of ['unpaired', 'wrong_device']) {
    expect(syncHealth(replica({ last_error: error(code) }), null, now)).toMatchObject({
      kind: 'forgotten', tone: 'act', hint: 'the Mac no longer knows this device.',
    });
  }
  for (const changes of [{ retired: true }, { last_error: error('retired') }]) {
    expect(syncHealth(replica(changes), null, now)).toMatchObject({
      kind: 'retired', tone: 'act', hint: 'Away more than 30 days.',
    });
  }
});

test('wait and act keep the title as their cover mark', () => {
  for (const changes of [
    { last_error: error('hub_unreachable') },
    { kept_copies: 1 },
    { last_error: error('schema_mismatch') },
    { last_error: error('unpaired') },
    { retired: true },
  ]) {
    const health = syncHealth(replica(changes), null, now)!;
    expect(health.tone).toBe(health.kind === 'unreachable' || health.kind === 'review' ? 'wait' : 'act');
    expect(health.cover).toBe(health.title);
  }
});

test('standalone, unpaired hubs and the demo have no health mark', () => {
  expect(syncHealth({ this_device: version, role: 'none', replica: null }, null, now)).toBeNull();
  expect(syncHealth(hub, { ...devices(), devices: [] }, now)).toBeNull();
  expect(syncHealth(replica({ pending: 3 }), null, now, null, true)).toBeNull();
});
