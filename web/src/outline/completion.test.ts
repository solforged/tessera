import { describe, expect, test } from 'bun:test';
import type { Block } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { cachedExactPage, completedReference, completionPickKey, completionTakesKey, engagedToken, headingPrefix, isJournalReference, isQuoteCompletion, openReferenceRange, referenceAliasInput, referenceCompletionAt, referenceNewlineAt, taskPrefixInput } from './completion';
import { titleTargets, typedTitles, withLinkedTitles } from './link-titles';
import { foldName } from './names';
import { typeTokenAt } from './type-completion';

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

  test('a pipe accepts the chosen target and starts its alias inside paired closers', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const result = referenceAliasInput('see [[gener]] next', 4, 11, id);
    expect(result).toEqual({ from: 4, to: 13, insert: `[[${id}|]]`, caret: 4 + id.length + 3 });
    const text = 'see ' + result.insert + ' next';
    expect(referenceCompletionAt(text, result.caret)).toBeNull();
    const aliased = text.slice(0, result.caret) + 'memory boost' + text.slice(result.caret);
    expect(aliased).toBe(`see [[${id}|memory boost]] next`);
    expect(referenceCompletionAt(aliased, result.caret + 12)).toBeNull();
  });

  test('an unmatched target or create row keeps the typed target without creating a page', () => {
    for (const text of ['[[gener]]', '[[gener']) {
      expect(referenceAliasInput(text, 0, 7)).toEqual({ from: 0, to: text.length, insert: '[[gener|]]', caret: 8 });
    }
    expect(referenceAliasInput('[[Generation effect]]', 0, 19)).toEqual({ from: 0, to: 21, insert: '[[Generation effect|]]', caret: 20 });
  });

  test('adding an alias to an accepted ID does not replace it with a search hit for its mentions', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const result = referenceAliasInput(`[[${id}]]`, 0, 28, 'another-block');
    expect(result).toEqual({ from: 0, to: 30, insert: `[[${id}|]]`, caret: 29 });
  });

  test('editing a target retains an existing alias and locator, but alias typing never completes', () => {
    const text = '[[Source|label|3.12]]';
    expect(referenceAliasInput(text, 0, 5, 'target')).toEqual({ from: 0, to: text.length, insert: '[[target|label|3.12]]', caret: 9 });
    for (let caret = text.indexOf('|') + 1; caret < text.length - 1; caret++) expect(referenceCompletionAt(text, caret)).toBeNull();
    expect(referenceCompletionAt(text, 5)?.query).toBe('Source');
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
  test('does not open page or block reference completion inside matched or open code drafts', () => {
    for (const text of ['`co[[QA Inline]]de`', '``co[[QA Inline]]de``', '`co((QA Inline))de`', '~~~\n[[QA Inline]]\n~~~']) {
      const marker = text.includes('[[') ? '[[' : '((';
      expect(referenceCompletionAt(text, text.indexOf(marker) + marker.length + 'QA Inline'.length)).toBeNull();
    }
    const text = '`code` [[QA Inline]]';
    expect(referenceCompletionAt(text, text.length - 2)).toEqual({ from: 7, to: text.length - 2, query: 'QA Inline', blocks: false });
    expect(referenceCompletionAt('[[outer|((inner))]]', 14)).toBeNull();
    const unmatched = 'it`s about [[Polybius]]';
    expect(referenceCompletionAt(unmatched, unmatched.length - 2)).toBeNull();
  });

  test('reserves modified Enter and Tab for their editing chords', () => {
    for (const key of ['Enter', 'Tab']) {
      const event = { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
      expect(completionPickKey(event)).toBe(true);
      for (const modifier of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey'] as const) expect(completionPickKey({ ...event, [modifier]: true })).toBe(false);
    }
  });

  test('a caret placed after an existing tag offers the picker without taking Enter or Tab', () => {
    const text = 'Normal science is puzzle-solving #proposition';
    const token = typeTokenAt(text, text.length)!;
    expect(token.query).toBe('proposition');
    const at = { id: 'b', from: token.from, query: token.query };
    // Clicking in the block and pressing End only moves the caret.
    const placed = engagedToken(null, at, false);
    expect(placed).toBeNull();
    for (const key of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp']) expect(completionTakesKey({ key }, !!placed)).toBe(false);
    expect(completionTakesKey({ key: 'Escape' }, !!placed)).toBe(true);
    // Typing engages the token, and the caret update that follows each keystroke keeps it engaged.
    const typed = engagedToken(placed, { ...at, query: 'propositions' }, true);
    expect(completionTakesKey({ key: 'Enter' }, !!engagedToken(typed, { ...at, query: 'propositions' }, false))).toBe(true);
    // Moving to another token, or another block, offers again.
    expect(engagedToken(typed, { ...at, query: 'proposition' }, false)).toBeNull();
    expect(engagedToken(typed, { ...at, id: 'c', query: 'propositions' }, false)).toBeNull();
    expect(engagedToken(typed, null, false)).toBeNull();
  });

  test('removes a heading prefix typed before existing text without removing the text', () => {
    for (const [prefix, heading] of [['# ', 1], ['## ', 2], ['### ', 3]] as const) {
      expect(headingPrefix(`${prefix.trim()}Existing sentence`, `${prefix}Existing sentence`, prefix.length)).toEqual({ text: 'Existing sentence', heading, caret: 0 });
      expect(headingPrefix(prefix.trim(), prefix, prefix.length)).toEqual({ text: '', heading, caret: 0 });
      expect(headingPrefix(`${prefix}xisting sentence`, `${prefix}Existing sentence`, prefix.length + 1)).toBeNull();
    }
    expect(headingPrefix('###Existing sentence', '#### Existing sentence', 5)).toBeNull();
    expect(headingPrefix('Text #sentence', 'Text # sentence', 7)).toBeNull();
    expect(headingPrefix(' Existing', '# Existing', 1)).toBeNull();
  });

  test('applies leading input rules to typing delivered in one chunk', () => {
    expect(headingPrefix('', '## Plan the week', 16)).toEqual({ text: 'Plan the week', heading: 2, caret: 13 });
    expect(taskPrefixInput('', '[] Some task', 12)).toEqual({ text: 'Some task', caret: 9 });
    expect(taskPrefixInput('', '[ ] Call @fri', 13)).toEqual({ text: 'Call @fri', caret: 9 });
    expect(taskPrefixInput('[]', '[] ', 3)).toEqual({ text: '', caret: 0 });
    expect(taskPrefixInput('[] Some tas', '[] Some task', 12)).toBeNull();
    expect(taskPrefixInput('x[] Some task', '[] Some task', 0)).toBeNull();
    expect(taskPrefixInput('', 'Some [] task', 12)).toBeNull();
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
    const unmatched = 'it`s about [[Canonical]]';
    expect(typedTitles(unmatched)).toEqual(['Canonical']);
    expect(withLinkedTitles(unmatched, targets)).toBe('it`s about [[01ARZ3NDEKTSV4RRFFQ69G5FAV|Canonical]]');
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

test('exact title completion uses canonical Unicode case folding without dropping accents', () => {
  for (const [title, query] of [['café', 'cafe\u0301'], ['ΟΣ', 'οσ'], ['ΟΣ', 'ος'], ['Straße', 'STRASSE'], ['İstanbul', 'i\u0307stanbul']]) {
    const page = { id: 'page', kind: 'page', parent_id: null, text: title } as Block;
    const roots = [page];
    const notebook = { roots: () => roots, lookup: () => () => page } as unknown as NotebookClient;
    expect(cachedExactPage(notebook, query!)).toBe(page);
    expect(cachedExactPage(notebook, 'cafe')).toBeNull();
  }
});
