import { expect, test } from 'bun:test';
import { backupLabel } from './backup';

test('backup label includes the local date, object count and full path', () => {
  const created_at = Date.UTC(2026, 9, 6, 12, 34, 56);
  const path = '/notebooks/backups/notebook-id/2026-10-06T12-34-56';
  expect(backupLabel({ created_at, object_count: 42, path })).toBe(`${new Date(created_at).toLocaleString()} · 42 objects · ${path}`);
});

test('backup label retains zero objects', () => {
  expect(backupLabel({ created_at: 0, object_count: 0, path: '/backup' })).toBe(`${new Date(0).toLocaleString()} · 0 objects · /backup`);
});
