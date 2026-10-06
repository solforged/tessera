import { describe, expect, test } from 'bun:test';
import type { Block, BlockInPage } from '../api/types';
import { paletteRows } from './palette-rows';

function page(id: string, text: string): Block {
  return { id, text, kind: 'page', parent_id: null, page_id: id, heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0 };
}
function hit(id: string, text: string, page: Block): BlockInPage {
  return { block: { ...page, id, text, kind: 'block', parent_id: page.id }, page };
}
const research = page('research', 'Research');
const links = page('links', 'Links');
const title = page('title', 'nanoGPT');

describe('palette ranking', () => {
  test('page titles precede prose and URL-only blocks', () => {
    const prose = hit('prose', 'Training nanoGPT in prose', research);
    const url = hit('url', 'https://example.test/nanoGPT', links);
    expect(paletteRows([url, prose, { block: title, page: title }], 'nanoGPT')).toEqual([
      { kind: 'hit', hit: { block: title, page: title } }, { kind: 'hit', hit: prose }, { kind: 'hit', hit: url },
    ]);
  });

  test('groups interleaved pages with two hits and an exact more count', () => {
    const one = hit('one', 'nanoGPT one', research);
    const two = hit('two', 'nanoGPT two', research);
    const three = hit('three', 'nanoGPT three', research);
    const four = hit('four', 'nanoGPT four', research);
    const other = hit('other', 'nanoGPT other', links);
    expect(paletteRows([one, other, two, three, four], 'nanoGPT')).toEqual([
      { kind: 'hit', hit: one }, { kind: 'hit', hit: two }, { kind: 'more', page: research, count: 2 }, { kind: 'hit', hit: other },
    ]);
  });

  test('prose occurrences outrank HTTP and HTTPS runs case insensitively', () => {
    const https = hit('https', 'Source: HTTPS://example.test/NANOGPT', research);
    const http = hit('http', 'http://example.test/nanogpt', research);
    const prose = hit('prose', 'nanoGPT discussion https://example.test/nanogpt', research);
    const label = hit('label', '[nanoGPT](https://example.test/nanogpt)', research);
    const input = [https, http, prose, label];
    expect(paletteRows(input, '  NaNoGPT  ')).toEqual([
      { kind: 'hit', hit: prose }, { kind: 'hit', hit: label }, { kind: 'more', page: research, count: 2 },
    ]);
    expect(input).toEqual([https, http, prose, label]);
  });

  test('more scope shows all matching blocks on that page without another cap', () => {
    const rows = [hit('url', 'https://example.test/nanoGPT', research), hit('one', 'nanoGPT one', research), hit('other', 'nanoGPT other', links), hit('two', 'nanoGPT two', research)];
    expect(paletteRows([{ block: research, page: research }, ...rows], 'nanoGPT', research.id)).toEqual([
      { kind: 'hit', hit: rows[1]! }, { kind: 'hit', hit: rows[3]! }, { kind: 'hit', hit: rows[0]! },
    ]);
  });

  test('empty queries preserve root order and two hits do not add a more row', () => {
    expect(paletteRows([{ block: research, page: research }, { block: links, page: links }], '')).toEqual([
      { kind: 'hit', hit: { block: research, page: research } }, { kind: 'hit', hit: { block: links, page: links } },
    ]);
    const rows = [hit('one', 'nanoGPT', research), hit('two', 'nanoGPT', research)];
    expect(paletteRows(rows, 'nanoGPT')).toEqual(rows.map(hit => ({ kind: 'hit', hit })));
    expect(paletteRows([], 'nanoGPT')).toEqual([]);
  });
});
