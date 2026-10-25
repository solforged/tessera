import { expect, test } from 'bun:test';
import type { BackupInfo } from '../api/types';
import { STALE_BACKUP_MS, backupLabel, backupStale } from './backup';

const backup: BackupInfo = { path: '/store/id/stamp', name: 'stamp', created_at: 1_000, object_count: 2, size: 10, safety: null };
const when = (value: number) => `at ${value}`;

test('a backup line names its time, what it came before and its files', () => {
  expect(backupLabel(backup, when)).toBe('at 1000 · 2 files');
  expect(backupLabel({ ...backup, safety: 'update', object_count: 1 }, when)).toBe('at 1000 · before update · 1 file');
  expect(backupLabel({ ...backup, safety: 'restore', object_count: 0 }, when)).toBe('at 1000 · before restore');
});

test('a backup is stale only when the workshop changed after it and two days have passed', () => {
  const now = 1_000 + STALE_BACKUP_MS + 1;
  expect(backupStale(1_000, 2_000, now)).toBe(true);
  expect(backupStale(1_000, 500, now)).toBe(false);
  expect(backupStale(1_000, 2_000, 1_000 + STALE_BACKUP_MS)).toBe(false);
  expect(backupStale(undefined, 2_000, now)).toBe(false);
  expect(backupStale(1_000, undefined, now)).toBe(false);
});
