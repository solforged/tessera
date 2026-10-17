import type { BackupInfo } from '../api/types';

/** An earlier backup's line: when it was taken, and how many source files it holds when it holds any. */
export function backupLabel(backup: BackupInfo): string {
  const when = new Date(backup.created_at).toLocaleString();
  return backup.object_count ? `${when} · ${backup.object_count} ${backup.object_count === 1 ? 'file' : 'files'}` : when;
}
