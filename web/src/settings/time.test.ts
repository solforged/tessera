import { expect, test } from 'bun:test';
import { canonicalZone, isoDate, isoMinute } from './time';

test('times read as local ISO minutes in the given zone', () => {
  const at = Date.UTC(2026, 9, 20, 6, 51, 30);
  expect(isoMinute(at, 'UTC')).toBe('2026-10-20 06:51');
  expect(isoMinute(at, 'America/Los_Angeles')).toBe('2026-10-19 23:51');
  expect(isoDate(at, 'Asia/Tokyo')).toBe('2026-10-20');
});

test('legacy zone names read as their current names', () => {
  expect(canonicalZone('Asia/Calcutta')).toBe('Asia/Kolkata');
  expect(canonicalZone('Europe/Kiev')).toBe('Europe/Kyiv');
  expect(canonicalZone('UTC')).toBe('UTC');
});
