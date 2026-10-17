import { describe, expect, test } from 'bun:test';
import { droppedSource } from './link-drop';

function transfer(values: Record<string, string>, files = false): Pick<DataTransfer, 'types' | 'files' | 'getData'> {
  return { types: [...Object.keys(values), ...files ? ['Files'] : []], files: { length: files ? 1 : 0 } as FileList, getData: type => values[type] ?? '' };
}

describe('window source drops', () => {
  test('URI-list comments and a display title do not replace the first link', () => {
    expect(droppedSource(transfer({ 'text/uri-list': '# browser link\r\n\r\nhttps://example.org/article\r\nhttps://example.org/second', 'text/plain': 'Article title' }))).toBe('https://example.org/article');
    expect(droppedSource(transfer({ 'text/uri-list': '# comment only', 'text/plain': ' https://example.org/article ' }))).toBe('https://example.org/article');
  });
  test('plain text must be a whole source rather than prose or another creation kind', () => {
    for (const value of ['https://example.org/article', '9780393339758', '10.1000/example']) expect(droppedSource(transfer({ 'text/plain': value }))).toBe(value);
    for (const value of ['', 'Read https://example.org/article', 'Is slow reading teachable?', 'Front >> Back']) expect(droppedSource(transfer({ 'text/plain': value }))).toBeNull();
  });
  test('file drags stay with file handlers even when accompanied by a link', () => {
    expect(droppedSource(transfer({ 'text/uri-list': 'https://example.org/article', 'text/plain': '9780393339758' }, true))).toBeNull();
    const protectedFiles = transfer({ 'text/plain': '9780393339758' });
    expect(droppedSource({ ...protectedFiles, types: [...protectedFiles.types, 'Files'] })).toBeNull();
  });
});
