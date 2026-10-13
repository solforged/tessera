import { describe, expect, test } from 'bun:test';
import type { Block } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { completedReference, completionPickKey, headingPrefix, isJournalReference, isQuoteCompletion, openReferenceRange, referenceCompletionAt, referenceNewlineAt } from './completion';
import { titleTargets, typedTitles, withLinkedTitles } from './link-titles';
import { foldName } from './names';

test('resolution and completion retain citation labels and locators', () => {
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  for (const suffix of ['|span|3.12', '||3.12', '|a|b|3.12', '|label']) {
    const text = `[[Source${suffix}]]`;
    const range = openReferenceRange(text, 0, 5, false);
    expect(range.query).toBe('Source');
    expect(completedReference(text, range.from, range.to, id)).toBe(`[[${id}${suffix}]]`);
    expect(withLinkedTitles(text, new Map([[foldName('Source'), id]]))).toBe(`[[${id}${suffix}]]`);
  }
});

describe('an open reference completion', () => {
  test('captures only a whole-row block query, including paired closers beyond the caret', () => {
    for (const [text, from, caret] of [['((', 0, 2], ['(())', 0, 2], ['((nested))', 0, 5], [' \t((nested)) ', 2, 6]] as const) {
      expect(isQuoteCompletion(text, from, caret)).toBe(true);
    }
    for (const [text, from, caret] of [['see ((nested))', 4, 9], ['((nested)) next', 0, 5], ['((nested) ', 0, 8], ['[[nested]]', 0, 5], ['((nested\nnext))', 0, 8]] as const) {
      expect(isQuoteCompletion(text, from, caret)).toBe(false);
    }
  });

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

  test('places a soft newline after the paired query without losing it during title normalization', () => {
    const text = 'Meet [[QA Inline]] then continue';
    const after = referenceNewlineAt(text, 5, 10, false);
    const next = text.slice(0, after) + '\n' + text.slice(after);
    expect(next).toBe('Meet [[QA Inline]]\n then continue');
    const targets = new Map<string, string>();
    targets.set(foldName('QA Inline'), '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(withLinkedTitles(next, targets)).toBe('Meet [[01ARZ3NDEKTSV4RRFFQ69G5FAV|QA Inline]]\n then continue');
    expect(referenceNewlineAt('Meet ((QA Inline))', 5, 10, true)).toBe(18);
    expect(referenceNewlineAt('Meet [[QA Inline', 5, 16, false)).toBe(16);
  });
});

describe('typed completion triggers', () => {
  test('does not open page or block reference completion in closed or unfinished code', () => {
    for (const text of ['`co[[QA Inline]]de`', '`co[[QA Inline', '``co[[QA Inline]]de``', '`co((QA Inline))de`', '~~~\n[[QA Inline]]\n~~~']) {
      const marker = text.includes('[[') ? '[[' : '((';
      expect(referenceCompletionAt(text, text.indexOf(marker) + marker.length + 'QA Inline'.length)).toBeNull();
    }
    const text = '`code` [[QA Inline]]';
    expect(referenceCompletionAt(text, text.length - 2)).toEqual({ from: 7, to: text.length - 2, query: 'QA Inline', blocks: false });
    expect(referenceCompletionAt('[[outer|((inner))]]', 14)).toBeNull();
  });

  test('reserves modified Enter and Tab for their editing chords', () => {
    for (const key of ['Enter', 'Tab']) {
      const event = { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
      expect(completionPickKey(event)).toBe(true);
      for (const modifier of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey'] as const) expect(completionPickKey({ ...event, [modifier]: true })).toBe(false);
    }
  });

  test('removes a heading prefix typed before existing text without removing the text', () => {
    for (const [prefix, heading] of [['# ', 1], ['## ', 2], ['### ', 3]] as const) {
      expect(headingPrefix(`${prefix}Existing sentence`, prefix.length)).toEqual({ text: 'Existing sentence', heading });
      expect(headingPrefix(prefix, prefix.length)).toEqual({ text: '', heading });
      expect(headingPrefix(`${prefix}Existing sentence`, prefix.length + 1)).toBeNull();
    }
    expect(headingPrefix('#### Existing sentence', 5)).toBeNull();
    expect(headingPrefix('Text # sentence', 7)).toBeNull();
  });
});

describe('hand-typed reference linking', () => {
  test('preserves each typed case variant and explicit label after resolving a page title', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const targets = new Map<string, string>();
    targets.set(foldName('Verify35 Case Canonical'), id);
    const text = `[[verify35 CASE canonical]] and [[VERIFY35 case CANONICAL]] and [[Verify35 Case Canonical|my label]] and [[${id}]] and [[unknown]]`;
    expect(withLinkedTitles(text, targets)).toBe(`[[${id}|verify35 CASE canonical]] and [[${id}|VERIFY35 case CANONICAL]] and [[${id}|my label]] and [[${id}]] and [[unknown]]`);
  });

  test('leaves hand-typed reference spelling inside code literal even when a title resolves', () => {
    const text = '`[[Canonical]]` and [[Canonical]]';
    const targets = new Map<string, string>();
    targets.set(foldName('Canonical'), '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(typedTitles('`[[Canonical]]`')).toEqual([]);
    expect(withLinkedTitles(text, targets)).toBe('`[[Canonical]]` and [[01ARZ3NDEKTSV4RRFFQ69G5FAV|Canonical]]');
  });

  test('never normalizes or trims authored newlines inside a literal reference', () => {
    const targets = new Map<string, string>();
    targets.set(foldName('QA Inline'), '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    for (const text of ['Meet [[QA Inline\n]]', 'Meet [[QA\nInline]]', 'Meet [[QA Inline|QA\nInline]]', 'Meet [[QA Inline\r\n]]']) {
      expect(typedTitles(text)).toEqual([]);
      expect(withLinkedTitles(text, targets)).toBe(text);
    }
  });

  test('ISO queries never create an ordinary page and resolve only an existing journal', async () => {
    const date = '2026-11-04';
    expect(isJournalReference(date)).toBe(true);
    expect(isJournalReference(` ${date} `)).toBe(true);
    expect(isJournalReference('November 4')).toBe(false);
    const ordinary = { id: 'ordinary', kind: 'page', text: date } as Block;
    const journal = { id: 'journal', kind: 'journal', text: date } as Block;
    let rows = [ordinary];
    const created: string[] = [];
    const notebook = {
      api: { complete: async () => rows },
      createPage: async (title: string) => { created.push(title); return 'created'; },
    } as unknown as NotebookClient;
    expect((await titleTargets(notebook, [date])).size).toBe(0);
    rows = [ordinary, journal];
    const targets = await titleTargets(notebook, [date]);
    expect(targets.size).toBe(1);
    expect(targets.get(foldName(date))).toBe(journal.id);
    expect(created).toEqual([]);
  });
});
