import { describe, expect, test } from 'bun:test';
import { openReferenceRange } from './completion';

describe('the text a reference completion replaces', () => {
  test('runs from the brackets through the paired closer when the caret ends the query', () => {
    expect(openReferenceRange('see [[mar]] now', 4, 9, false)).toEqual({ from: 4, to: 11 });
    expect(openReferenceRange('see ((mar)) now', 4, 9, true)).toEqual({ from: 4, to: 11 });
  });

  test('takes the rest of the query after a caret placed mid-title, so no tail is left behind', () => {
    expect(openReferenceRange('[[Stoicism]] and more', 0, 5, false)).toEqual({ from: 0, to: 12 });
    expect(openReferenceRange('[[Meditations (book)]] x', 0, 4, false)).toEqual({ from: 0, to: 22 });
  });

  test('stops at the caret when nothing closes the query', () => {
    expect(openReferenceRange('[[mar and more', 0, 5, false)).toEqual({ from: 0, to: 5 });
    expect(openReferenceRange('[[mar\nnext]]', 0, 5, false)).toEqual({ from: 0, to: 5 });
    expect(openReferenceRange('[[mar [[other]]', 0, 5, false)).toEqual({ from: 0, to: 5 });
  });
});
