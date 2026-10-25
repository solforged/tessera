import { describe, expect, test } from 'bun:test';
import { sourceLineText } from './link-import';

describe('sourceLineText', () => {
  test('names the source by the link title', () => {
    expect(sourceLineText('01SRC', 'Pride and Prejudice by Jane Austen')).toBe('[[01SRC|Pride and Prejudice by Jane Austen]]');
  });
  test('keeps reference syntax and line breaks out of the label', () => {
    expect(sourceLineText('01SRC', 'A | B [draft]\nnotes')).toBe('[[01SRC|A B draft notes]]');
  });
  test('is the bare reference without a usable title', () => {
    expect(sourceLineText('01SRC', null)).toBe('[[01SRC]]');
    expect(sourceLineText('01SRC', ' | ')).toBe('[[01SRC]]');
  });
});
