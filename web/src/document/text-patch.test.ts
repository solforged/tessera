import { expect, test } from 'bun:test';
import { mapTextOffset, rebaseText } from './text-patch';

test('undo and redo preserve another window’s appended text', () => {
  const undone = rebaseText('Original local', 'Original', 'Original local remote');
  expect(undone).toBe('Original remote');
  expect(rebaseText('Original remote', 'Original local remote', 'Original remote')).toBe('Original local remote');
});

test('separate text regions rebase without discarding changes between them', () => {
  expect(rebaseText('Alpha middle Omega', 'alpha middle omega', 'Alpha remote Omega')).toBe('alpha remote omega');
  expect(rebaseText('abcd', 'acd', 'abXcd')).toBe('aXcd');
  expect(rebaseText('abcd', 'acd', 'aXbcd')).toBe('aXcd');
  expect(rebaseText('abc', 'ac', 'abc!')).toBe('ac!');
});

test('overlapping replacements and insertions cannot erase a newer contribution', () => {
  expect(rebaseText('Original local', 'Original', 'Original edited')).toBeNull();
  expect(rebaseText('abc', 'aXc', 'aYc')).toBeNull();
  expect(rebaseText('abc', 'aXbc', 'aYbc')).toBeNull();
  expect(rebaseText('abcd', 'ad', 'abXcd')).toBeNull();
});

test('Unicode code points stay intact through independent edits', () => {
  expect(rebaseText('\u{1F33F} café 日本', '\u{1F342} café 日本', '\u{1F33F} café 日本語')).toBe('\u{1F342} café 日本語');
  expect(rebaseText('\u{1F33F} café 日本', '\u{1F342} café 日本', '\u{1F331} café 日本')).toBeNull();
});

test('equal or already-applied text leaves the newer text unchanged', () => {
  expect(rebaseText('base', 'base', 'remote')).toBe('remote');
  expect(rebaseText('base', 'desired', 'desired')).toBe('desired');
  expect(rebaseText('base', 'desired', 'base')).toBe('desired');
});

test('rewrite boundaries follow separate canonical tags in UTF-16 coordinates', () => {
  const before = '🌿 #left middle #right tail';
  const left = '🌿 #[[01M58Z38VNRQPS92TH6BYFQ3VA|left]]';
  const after = `${left} middle #[[01M58Z38VNRQPS92TH6BYFQ3VB|right]] tail`;
  expect(mapTextOffset(before, after, 2)).toBe(2);
  expect(mapTextOffset(before, after, before.indexOf(' middle'))).toBe(left.length);
  expect(mapTextOffset(before, after, before.indexOf(' tail'))).toBe(after.indexOf(' tail'));
  expect(mapTextOffset(before, after, before.length)).toBe(after.length);
  expect(mapTextOffset('abc', 'aXYZc', 2)).toBe(4);
});

test('a parked caret resumes after a tag normalized while its editor was closed', () => {
  const authored = 'Repro #essay ';
  const saved = 'Repro #[[566MCY9EM1J6FTT5NNS38TEDKY|essay]] ';
  const parked = authored.length;
  const resumed = mapTextOffset(authored, saved, parked);
  expect(resumed).toBe(saved.length);
  expect(saved.slice(0, resumed) + 'xy' + saved.slice(resumed)).toBe(`${saved}xy`);
  expect(mapTextOffset(authored, saved, authored.indexOf('#'))).toBe(saved.indexOf('#'));
  expect(mapTextOffset(authored, saved, authored.length - 1)).toBe(saved.length - 1);
  // Resolving the same parked caret again must not apply the rewrite a second time.
  expect(mapTextOffset(authored, saved, parked)).toBe(resumed);
});
