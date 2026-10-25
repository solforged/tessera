import type { BackupInfo } from '../api/types';

const safetyLabels = { update: 'before update', restore: 'before restore' } as const;

/** A stored backup's line: when it was taken, what it was taken before, and how many source files it holds. */
export function backupLabel(backup: BackupInfo, when: (value: number) => string): string {
  return [
    when(backup.created_at),
    backup.safety ? safetyLabels[backup.safety] : '',
    backup.object_count ? `${backup.object_count} ${backup.object_count === 1 ? 'file' : 'files'}` : '',
  ].filter(Boolean).join(' · ');
}

/** Two days without a backup while the workshop changes means the daily backup is not running. */
export const STALE_BACKUP_MS = 48 * 60 * 60 * 1000;
export function backupStale(newest: number | undefined, changed: number | undefined, now: number): boolean {
  return newest !== undefined && changed !== undefined && changed > newest && now - newest > STALE_BACKUP_MS;
}
