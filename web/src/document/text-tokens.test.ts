import { describe, expect, test } from 'bun:test';
import { textTokens } from './text-tokens';

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
