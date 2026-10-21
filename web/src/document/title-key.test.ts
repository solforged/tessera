import { expect, test } from 'bun:test';
import { titleKey } from './title-key';
import cases from '../../../crates/tessera-core/tests/fixtures/title-keys.json';
import { identityName } from './title-name';

test('folds Unicode 16 letters independently of the runtime Unicode tables', () => {
  expect(titleKey('\u1c89\ua7cb\u{10d50}')).toBe('\u1c8a\u0264\u{10d70}');
  expect(titleKey('\u1c8a\u0264\u{10d70}')).toBe('\u1c8a\u0264\u{10d70}');
});

test('agrees with core identity keys for canonical, legacy, tag-only and shielded titles', () => {
  for (const [title, key] of cases) expect(titleKey(title!)).toBe(key!);
  expect(identityName('  Lab  #project notes #person ')).toBe('Lab notes');
});
