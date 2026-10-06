import type { BackupInfo } from '../api/types';

/** The shared summary for the latest and previous notebook backups. */
export function backupLabel(backup: BackupInfo): string {
  return `${new Date(backup.created_at).toLocaleString()} · ${backup.object_count} objects · ${backup.path}`;
}
