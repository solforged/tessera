import { describe, expect, test } from 'bun:test';
import { isVirtualKeyboardOpen } from './viewport';

describe('isVirtualKeyboardOpen', () => {
  test('never triggers on fine-pointer desktop windows, even when short', () => {
    expect(isVirtualKeyboardOpen(530, 530, 900, false)).toBe(false);
    expect(isVirtualKeyboardOpen(274, 274, 900, false)).toBe(false);
  });

  test('detects iOS visualViewport shrink on touch devices', () => {
    expect(isVirtualKeyboardOpen(520, 844, 844, true)).toBe(true);
    expect(isVirtualKeyboardOpen(810, 844, 844, true)).toBe(false);
  });

  test('detects Android WebView resize on touch devices', () => {
    expect(isVirtualKeyboardOpen(480, 480, 890, true)).toBe(true);
    expect(isVirtualKeyboardOpen(800, 800, 890, true)).toBe(false);
  });
});
