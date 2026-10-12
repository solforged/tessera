import { expect, test } from 'bun:test';
import { rebaseText } from './text-patch';

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
