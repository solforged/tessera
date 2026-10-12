import { describe, expect, test } from 'bun:test';
import { hiddenFieldEntries, selectionIds } from './visibility';
import type { HiddenFieldEntry } from './visibility';
import { emptyExtraValuePrevious } from './keyboard';

const entry = (hide: HiddenFieldEntry['hide'], blanks: boolean[]): HiddenFieldEntry => ({ id: 'entry', hide, values: blanks.map((blank, index) => ({ id: `value${index}`, blank })), descendants: ['nested'] });

describe('outline field hiding', () => {
  test('never shows empty entries and every value combination', () => {
    for (const blanks of [[], [true], [false], [true, false]]) expect([...hiddenFieldEntries([entry('never', blanks)], new Set(), false)]).toEqual([]);
  });
  test('when_empty hides no values, blank values and multiple blank values', () => {
    for (const blanks of [[], [true], [true, true]]) expect([...hiddenFieldEntries([entry('when_empty', blanks)], new Set(), false)]).toEqual(['entry']);
  });
  test('when_empty keeps any nonblank value, including mixed multi-values', () => {
    for (const blanks of [[false], [true, false], [false, true]]) expect([...hiddenFieldEntries([entry('when_empty', blanks)], new Set(), false)]).toEqual([]);
  });
  test('always hides filled and empty entries', () => {
    for (const blanks of [[], [true], [false], [true, false]]) expect([...hiddenFieldEntries([entry('always', blanks)], new Set(), false)]).toEqual(['entry']);
  });
  test('retained entry, value or deeper range endpoint keeps its entry', () => {
    for (const hide of ['when_empty', 'always'] as const) for (const id of ['entry', 'value0', 'nested']) expect([...hiddenFieldEntries([entry(hide, [true])], new Set([id]), false)]).toEqual([]);
  });
  test('pre-hide range retention keeps interior field values in either selection direction', () => {
    const rows = ['before', 'entry', 'value0', 'after'];
    for (const [anchor, head] of [['before', 'after'], ['after', 'before']] as const) {
      const retained = new Set(selectionIds(rows, { anchor: { id: anchor, offset: 0 }, head: { id: head, offset: 0 } }));
      expect([...hiddenFieldEntries([entry('always', [false])], retained, false)]).toEqual([]);
      expect([...hiddenFieldEntries([entry('always', [false])], new Set([anchor, head]), false)]).toEqual(['entry']);
    }
  });
  test('revealing an owner keeps every hidden entry', () => {
    for (const hide of ['when_empty', 'always'] as const) expect([...hiddenFieldEntries([entry(hide, [true])], new Set(), true)]).toEqual([]);
  });
});

describe('blank extra value cleanup', () => {
  const field = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const known = new Map([[field, {}]]);
  function fixture(texts: string[], children: string[] = [], archived: string[] = []) {
    const values = texts.map((_, index) => `value${index}`);
    return {
      block: (id: string) => ({ text: id === 'entry' ? `[[${field}]]` : texts[values.indexOf(id)] ?? '' }),
      outline: { children: (id: string) => id === 'entry' ? values : children, parentOf: () => 'entry' },
      isArchived: (id: string) => archived.includes(id),
    } as unknown as Parameters<typeof emptyExtraValuePrevious>[0];
  }
  test('keeps the first live value, even if blank', () => {
    expect(emptyExtraValuePrevious(fixture(['']), 'value0', known)).toBeNull();
    expect(emptyExtraValuePrevious(fixture(['old', ''], [], ['value0']), 'value1', known)).toBeNull();
  });
  test('removes only additional whitespace-only leaf values', () => {
    expect(emptyExtraValuePrevious(fixture(['first', ' \n ']), 'value1', known)).toBe('value0');
    expect(emptyExtraValuePrevious(fixture(['first', 'text']), 'value1', known)).toBeNull();
    expect(emptyExtraValuePrevious(fixture(['first', ''], ['child']), 'value1', known)).toBeNull();
    expect(emptyExtraValuePrevious(fixture(['first', '']), 'value1', new Map())).toBeNull();
  });
});
