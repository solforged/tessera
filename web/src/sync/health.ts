import type { PairedDevice, SyncConflicts, SyncDevices, SyncState, SyncVersion } from '../api/types';

export const SUSTAINED_OUTAGE_MS = 2 * 60 * 60 * 1000;
export type HealthKind = 'synced' | 'sending' | 'unreachable' | 'version' | 'forgotten' | 'retired' | 'review';
export interface SyncHealth {
  kind: HealthKind; tone: 'ok' | 'wait' | 'act'; rail: string; hint: string; title: string; cover: string | null; detail: string;
  role: 'hub' | 'replica'; deviceId: string | null; deviceName: string; hubName: string;
  pending: number; kept: number; rejected: number; since: number | null;
  behind: 'hub' | 'replica' | null; hubVersion: SyncVersion | null; deviceVersion: SyncVersion | null;
}

export function elapsed(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

const mismatch = (error: { code: string; message: string } | null | undefined) =>
  error?.code === 'schema_mismatch' || error?.code === 'validation' && error.message.includes('schema');
const behind = (hub: SyncVersion | null, device: SyncVersion | null): SyncHealth['behind'] =>
  !hub || !device || hub.schema === device.schema ? null : hub.schema < device.schema ? 'hub' : 'replica';

/** One precedence rule for the rail, cover, summary and expanded device rows. */
export function syncHealth(state: SyncState | null, devices: SyncDevices | null, now: number, conflicts: SyncConflicts | null = null, demo = false): SyncHealth | null {
  if (demo || !state || state.role === 'none') return null;
  const replica = state.role === 'replica' ? state.replica : null;
  if (!replica && (state.role !== 'hub' || !devices?.devices.length)) return null;
  const hub = devices?.this_device ?? state.this_device;
  const paired = devices?.devices.length ?? 0;
  const base: SyncHealth = {
    kind: 'synced', tone: 'ok', rail: replica ? 'Devices synced' : `${paired} ${paired === 1 ? 'device' : 'devices'} synced`,
    hint: 'Click for details.', title: 'Devices synced', cover: null, detail: '',
    role: replica ? 'replica' : 'hub', deviceId: replica?.device_id ?? null,
    deviceName: replica?.device_name ?? 'This device', hubName: replica?.hub_name ?? devices?.hub_name ?? 'the Mac',
    pending: replica?.pending ?? 0, kept: replica?.kept_copies ?? conflicts?.kept.length ?? 0,
    rejected: replica?.rejected ?? conflicts?.rejected.length ?? 0, since: replica?.failing_since ?? null,
    behind: null, hubVersion: replica ? replica.hub_version : hub, deviceVersion: replica ? state.this_device : null,
  };
  const retired = !replica ? devices!.devices.find(device => device.state === 'retired') : null;
  const refused = !replica ? devices!.devices.find(device => mismatch(device.refused)) : null;
  const device: PairedDevice | null = retired ?? refused ?? null;
  if (device) {
    base.deviceId = device.id; base.deviceName = device.name; base.deviceVersion = device.version;
    base.since = device.refused?.since ?? device.retired_at;
  }
  const code = replica?.last_error?.code;
  if (code === 'unpaired' || code === 'wrong_device' || replica?.retired || code === 'retired' || retired) {
    base.kind = code === 'unpaired' || code === 'wrong_device' ? 'forgotten' : 'retired';
    base.title = base.kind === 'forgotten' ? 'Pair again' : 'Download again';
    base.rail = replica ? base.title : `${base.deviceName} retired`;
    base.hint = base.kind === 'forgotten' ? `${base.hubName} no longer knows this device.`
      : replica ? 'Away more than 30 days.' : `${base.deviceName} must download the workshop again.`;
  } else if (mismatch(replica?.last_error) || refused) {
    base.kind = 'version'; base.title = 'Version mismatch'; base.behind = behind(base.hubVersion, base.deviceVersion);
    base.rail = replica ? `Update ${base.behind === 'hub' ? base.hubName : base.deviceName}${base.pending ? ` · ${base.pending} waiting` : ''}`
      : `${base.deviceName} refused${base.since !== null ? ` · ${elapsed(base.since, now)}` : ''}`;
    base.hint = base.behind === 'hub' ? `Update ${base.hubName} to sync.`
      : base.behind === 'replica' ? `Update ${base.deviceName} to sync.` : 'Update both devices to sync.';
  } else if (base.kept + base.rejected > 0) {
    base.kind = 'review'; base.title = 'Needs review'; base.rail = `Needs review · ${base.kept + base.rejected}`;
    base.hint = 'Review when convenient.';
    base.detail = [base.kept ? `${base.kept} kept` : '', base.rejected ? `${base.rejected} rejected` : ''].filter(Boolean).join(' · ');
  } else if (replica?.last_error) {
    base.kind = 'unreachable'; base.title = `Can’t reach ${base.hubName}`;
    base.rail = `${base.title}${base.since !== null ? ` · ${elapsed(base.since, now)}` : ''}`;
    base.hint = base.pending > 0 && base.since !== null && now - base.since >= SUSTAINED_OUTAGE_MS
      ? `Check Tailscale or ${base.hubName}.` : 'Tessera keeps trying.';
  } else if (replica && (replica.syncing || replica.pending > 0 || replica.unapplied > 0)) {
    base.kind = 'sending'; base.title = replica.pending ? 'Sending' : 'Syncing…';
    base.rail = replica.pending ? `Sending · ${replica.pending} changes` : 'Syncing…';
  } else if (replica) {
    base.title = 'Synced'; base.rail = `Synced${replica.synced_at !== null ? ` · ${elapsed(replica.synced_at, now)}` : ''}`;
  }
  base.tone = base.kind === 'synced' || base.kind === 'sending' ? 'ok'
    : base.kind === 'unreachable' || base.kind === 'review' ? 'wait' : 'act';
  base.cover = base.tone === 'ok' ? null : base.title;
  if (base.kind !== 'review') base.detail = base.pending ? `${base.pending} waiting` : '';
  return base;
}

export const RELEASES = 'https://github.com/solforged/tessera/releases/latest';
export function downloadPage(hubUrl: string | null | undefined): { url: string; host: string } | null {
  if (!hubUrl) return null;
  try { const url = new URL(hubUrl); return { url: `https://${url.hostname}:8443/`, host: url.hostname.split('.')[0]! }; }
  catch { return null; }
}
export const versionLine = (version: SyncVersion | null) => version
  ? [version.version ?? 'Version unknown', version.build, `schema ${version.schema}`].filter(Boolean).join(' · ') : 'Version not reported';
