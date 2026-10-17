import { expect, test } from 'bun:test';
import { titleKey } from './title-key';

test('folds Unicode 16 letters independently of the runtime Unicode tables', () => {
  expect(titleKey('\u1c89\ua7cb\u{10d50}')).toBe('\u1c8a\u0264\u{10d70}');
  expect(titleKey('\u1c8a\u0264\u{10d70}')).toBe('\u1c8a\u0264\u{10d70}');
});
