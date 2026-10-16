import { describe, expect, test } from 'bun:test';
import { inlineTokens, isStableReference, isViewReference, quoteTarget, referenceBeside, textTokens } from './text-tokens';

describe('reference locators', () => {
  test('uses the first and last pipes, preserving pipes within labels', () => {
    for (const [text, alias, locator] of [
      ['[[id|label]]', 'label', undefined],
      ['[[id|label|3.12]]', 'label', '3.12'],
      ['[[id||3.12]]', '', '3.12'],
      ['[[id|a|b|3.12]]', 'a|b', '3.12'],
    ] as const) {
      const token = textTokens(text)[0]!;
      expect(token.id).toBe('id');
      expect(token.alias).toBe(alias);
      expect(token.locator).toBe(locator);
      expect(token.value).toBe(text);
    }
  });
});

test('nested bracket expressions stay wholly literal without resolving inner titles', () => {
  for (const value of ['[[a [[b]] c]]', '[[a [[b]]]]', '[[a [[b]]', '[[id|a [[b]] c]]']) {
    const text = `Nested ${value} tail [[valid]]`;
    expect(textTokens(text).filter(token => token.kind === 'reference').map(token => token.id)).toEqual(value === '[[a [[b]]' ? [] : ['valid']);
    expect(textTokens(text).map(token => text.slice(token.start, token.end)).join('')).toBe(text);
  }
});

test('reading emphasis and code preserve exact source spans and shield code syntax', () => {
  const source = '**bold** *italic* `#tag [[Name]]` ***both***';
  const tokens = inlineTokens(source);
  expect(tokens.filter(token => token.formats?.length).map(token => [token.value, token.formats])).toEqual([
    ['bold', ['bold']], ['italic', ['italic']], ['#tag [[Name]]', ['code']], ['both', ['bold', 'italic']],
  ]);
  for (const token of tokens) expect(source.slice(token.start, token.end)).toBe(token.value);
  expect(textTokens('`#tag [[Name]]`').every(token => token.kind === 'text')).toBe(true);
  expect(inlineTokens('**[[id|label]]**').find(token => token.kind === 'reference')?.formats).toEqual(['bold']);
  expect(inlineTokens('**unfinished').map(token => token.value).join('')).toBe('**unfinished');
});

test('inline code uses exact backtick runs and leaves adjacent semantic tokens active', () => {
  for (const marker of ['`', '``', '```']) {
    const text = `${marker}#Hidden [[id]]${marker} #Visible [[id]]`;
    expect(textTokens(text).filter(token => token.kind !== 'text').map(token => token.value)).toEqual(['Visible', '[[id]]']);
  }
  for (const text of ['`#Hidden [[id]]`', '``#Hidden ` [[id]]``', '`#Hidden `` [[id]]`']) {
    expect(textTokens(text).every(token => token.kind === 'text')).toBe(true);
  }
});

test('unmatched backticks stay literal without suppressing later tags or references', () => {
  for (const marker of ['`', '``', '```']) {
    const text = `it${marker}s about #history and [[Polybius]]`;
    expect(textTokens(text).filter(token => token.kind !== 'text').map(token => token.value)).toEqual(['history', '[[Polybius]]']);
    expect(inlineTokens(text).some(token => token.formats?.includes('code'))).toBe(false);
  }
});

test('authored external captions use one URL token without becoming page references', () => {
  for (const [source, caption] of [
    ['[label](https://example.org/Topic_(a_(b)))', 'label'],
    ['[[https://example.org/a|caption]]', 'caption'],
    ['[[HTTPS://example.org/a|uppercase]]', 'uppercase'],
  ] as const) {
    const [token] = textTokens(source);
    expect(token?.kind).toBe('url');
    expect(token?.alias).toBe(caption);
    expect(token?.end).toBe(source.length);
    expect(source.slice(token!.labelStart, token!.labelStart! + caption.length)).toBe(caption);
  }
  expect(textTokens('[a](https://a.org)[b](https://b.org)').filter(token => token.kind === 'url').map(token => token.alias)).toEqual(['a', 'b']);
});

test('bare Unicode tags include every combining mark and agree with type spelling', () => {
  const source = '#हिन्दी #cafe\u0301 #中文_2/x-y e\u0301#inside';
  expect(textTokens(source).filter(token => token.kind === 'tag').map(token => [token.value, source.slice(token.start, token.end)])).toEqual([
    ['हिन्दी', '#हिन्दी'], ['cafe\u0301', '#cafe\u0301'], ['中文_2/x-y', '#中文_2/x-y'],
  ]);
});

test('saved view targets keep their name and never become block targets', () => {
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const text = `[[view:${id}|Open questions]]`;
  const token = textTokens(text)[0]!;
  expect(token).toEqual({ start: 0, end: text.length, kind: 'reference', value: text, id, targetKind: 'view', alias: 'Open questions' });
  expect(isViewReference(token)).toBe(true);
  expect(isStableReference(token)).toBe(false);
  expect(textTokens(`[[view:8${id.slice(1)}|Invalid]]`)[0]?.targetKind).toBeUndefined();
  expect(referenceBeside(text, text.length, 'backward')?.value).toBe(text);
});

describe('whole-row quote targets', () => {
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  test('accepts only stable targets with optional surrounding whitespace', () => {
    expect(quoteTarget(`((${id}))`)).toBe(id);
    expect(quoteTarget(` \t((${id}))\n`)).toBe(id);
    expect(quoteTarget(`((${id.toLowerCase()}))`)).toBeNull();
    expect(quoteTarget(`((8${id.slice(1)}))`)).toBeNull();
    for (const text of [`see ((${id}))`, `((${id})) next`, `((${id}))\nother`, `((${id})) ((${id}))`,
      `(( ${id}))`, `((${id} ))`, `(((${id})))`, `((${id}|label))`, `((${id.slice(1)}))`, `((I${id.slice(1)}))`,
      `((U${id.slice(1)}))`, `[[${id}]]`, `\`((${id}))\``, '((title))', '((']) expect(quoteTarget(text)).toBeNull();
  });
});

describe('URL tokens', () => {
  test('links HTTP and HTTPS and stops at whitespace and HTML delimiters', () => {
    for (const delimiter of [' ', '\n', '\t', '<', '>', '"', "'"]) {
      const text = `http://example.org/a${delimiter}https://example.org/b`;
      expect(textTokens(text).filter(token => token.kind === 'url').map(token => token.value)).toEqual(['http://example.org/a', 'https://example.org/b']);
    }
    expect(textTokens('ftp://example.org example.org').every(token => token.kind === 'text')).toBe(true);
  });

  test('leaves terminal punctuation in plain text with exact source offsets', () => {
    for (const suffix of ['.', ',', ';', ':', '!', '?', ')', '.,;:!?))']) {
      const url = 'https://example.org/path?q=1#section';
      const text = `See ${url}${suffix} next`;
      expect(textTokens(text)).toEqual([
        { start: 0, end: 4, kind: 'text', value: 'See ' },
        { start: 4, end: 4 + url.length, kind: 'url', value: url },
        { start: 4 + url.length, end: text.length, kind: 'text', value: `${suffix} next` },
      ]);
    }
  });

  test('retains balanced closing parentheses and removes only surplus closers', () => {
    for (const suffix of ['', ')', ').', ')).!?']) {
      const url = 'https://example.org/wiki/Topic_(nested_(part))';
      expect(textTokens(`(${url}${suffix}`).find(token => token.kind === 'url')?.value).toBe(url);
    }
    expect(textTokens('https://example.org/a(b)c)').find(token => token.kind === 'url')?.value).toBe('https://example.org/a(b)c');
  });

  test('keeps references and tags intact and does not tokenize a URL fragment as a tag', () => {
    const text = '[[id|https://alias.example]] #[[Long tag]] #tag https://example.org/#fragment';
    expect(textTokens(text).filter(token => token.kind !== 'text').map(token => [token.kind, token.value])).toEqual([
      ['reference', '[[id|https://alias.example]]'], ['tag', 'Long tag'], ['tag', 'tag'], ['url', 'https://example.org/#fragment'],
    ]);
  });
});

describe('deleting beside a reference', () => {
  const text = 'see [[01M4M13Q37BGH391ARSJX45F7Y]] and [[Mar]]';
  test('takes a whole reference only from its outer edge', () => {
    expect(referenceBeside(text, 34, 'backward')?.value).toBe('[[01M4M13Q37BGH391ARSJX45F7Y]]');
    expect(referenceBeside(text, 4, 'forward')?.value).toBe('[[01M4M13Q37BGH391ARSJX45F7Y]]');
    expect(referenceBeside(text, 4, 'backward')).toBeUndefined();
    expect(referenceBeside(text, 34, 'forward')).toBeUndefined();
  });

  test('leaves a query being typed to ordinary character deletion', () => {
    for (let offset = 40; offset < text.length; offset++) expect(referenceBeside(text, offset, 'backward')).toBeUndefined();
    expect(referenceBeside(text, text.length, 'backward')?.value).toBe('[[Mar]]');
  });

  test('ignores a reference that spans lines and so never shows as a label', () => {
    expect(referenceBeside('[[two\nlines]]', 13, 'backward')).toBeUndefined();
  });
});
