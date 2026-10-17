import { describe, expect, test } from 'bun:test';
import { createHintHistory } from './hints';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('workshop discovery history', () => {
  test('claims every tag independently and first-use hints only once across reloads', () => {
    const storage = memoryStorage();
    const history = createHintHistory('one', storage);
    expect(history.claim('tag', 'arabic')).toBe(true);
    expect(history.claim('card')).toBe(true);
    expect(history.claim('field')).toBe(true);
    const reloaded = createHintHistory('one', storage);
    expect(reloaded.claim('tag', 'arabic')).toBe(false);
    expect(reloaded.claim('tag', 'persian')).toBe(true);
    expect(reloaded.claim('card')).toBe(false);
    expect(reloaded.claim('field')).toBe(false);
    expect(JSON.parse(storage.getItem('tessera.discovery.one')!)).toEqual({ types: ['arabic', 'persian'], card: true, field: true });
  });

  test('shares claims between panes without sharing them with another workshop', () => {
    const storage = memoryStorage();
    const left = createHintHistory('one', storage), right = createHintHistory('one', storage);
    expect(left.claim('tag', 'arabic')).toBe(true);
    expect(right.claim('tag', 'arabic')).toBe(false);
    expect(right.claim('field')).toBe(true);
    expect(left.claim('field')).toBe(false);
    const other = createHintHistory('two', storage);
    expect(other.claim('tag', 'arabic')).toBe(true);
    expect(other.claim('field')).toBe(true);
  });

  test('ignores malformed optional history and keeps claims when storage is unavailable', () => {
    const storage = memoryStorage();
    storage.setItem('tessera.discovery.one', JSON.stringify({ types: [null, 'arabic'], card: 'true' }));
    const history = createHintHistory('one', storage);
    expect(history.claim('tag', 'arabic')).toBe(false);
    expect(history.claim('card')).toBe(true);
    const unavailable = createHintHistory('offline', {
      getItem: () => { throw new Error('Unavailable'); },
      setItem: () => { throw new Error('Unavailable'); },
    });
    expect(unavailable.claim('tag', 'arabic')).toBe(true);
    expect(unavailable.claim('tag', 'arabic')).toBe(false);
    expect(unavailable.claim('card')).toBe(true);
    expect(unavailable.claim('card')).toBe(false);
  });
});
