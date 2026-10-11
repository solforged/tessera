import { describe, expect, test } from 'bun:test';
import { openReferenceRange } from './completion';

describe('an open reference completion', () => {
  test('runs from the brackets through the paired closer when the caret ends the query', () => {
    expect(openReferenceRange('see [[mar]] now', 4, 9, false)).toEqual({ from: 4, to: 11, query: 'mar' });
    expect(openReferenceRange('see ((mar)) now', 4, 9, true)).toEqual({ from: 4, to: 11, query: 'mar' });
  });

  test('searches and replaces the whole title when the caret sits mid-query', () => {
    expect(openReferenceRange('[[Stoicism]] and more', 0, 5, false)).toEqual({ from: 0, to: 12, query: 'Stoicism' });
    expect(openReferenceRange('[[Meditations (book)]] x', 0, 4, false)).toEqual({ from: 0, to: 22, query: 'Meditations (book)' });
  });

  test('stops at the caret when nothing closes the query', () => {
    expect(openReferenceRange('[[mar and more', 0, 5, false)).toEqual({ from: 0, to: 5, query: 'mar' });
    expect(openReferenceRange('[[mar\nnext]]', 0, 5, false)).toEqual({ from: 0, to: 5, query: 'mar' });
    expect(openReferenceRange('[[mar [[other]]', 0, 5, false)).toEqual({ from: 0, to: 5, query: 'mar' });
  });
});
