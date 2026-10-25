import type { HistoryEntry } from '../api/types';

/** Who made a change: You for this person's windows, Agent, a synced device's name, or the client's name. */
export function historyActor(entry: HistoryEntry, replicaDevice: string | null, deviceName: (id: string) => string | undefined): string {
  const remote = entry.origin ? deviceName(entry.origin) : undefined;
  if (remote !== undefined) return remote || 'Phone';
  if (entry.origin && replicaDevice && entry.origin !== replicaDevice) return 'Another device';
  if (entry.actor.kind === 'agent') return 'Agent';
  return entry.actor.kind === 'person' || entry.actor.name.startsWith('tessera-web') ? 'You' : entry.actor.name;
}
