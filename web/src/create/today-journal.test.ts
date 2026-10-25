import { describe, expect, test } from 'bun:test';
import type { Block, PageView } from '../api/types';
import { defaultTodayTemplate } from '../tasks/today-template';
import { readingSources, recentCaptures, titledLink } from './today-journal';

const source = '01JB0000000000000000000000';
const block = (id: string, parent: string | null, text: string, created = 1, heading: 1 | 2 | 3 | null = null): Block =>
  ({ id, page_id: 'day', parent_id: parent, kind: parent ? 'block' : 'journal', text, heading, archived: false, revision: 1, created_at: created, updated_at: created });
const page = (rows: Block[]) => ({ root: block('day', null, '2026-10-25'), rows: rows.map(value => ({ block: value })) }) as unknown as PageView;
const day = page([
  block('i', 'day', 'Inbox', 1, 2), block('a', 'i', 'First thought', 10), block('l', 'i', `[[${source}|Meditations]]`, 35), block('b', 'i', '', 50), block('c', 'i', 'Second thought', 30),
  block('r', 'day', 'Reading', 1, 2), block('s', 'r', `[[${source}|Meditations|Book IV]]`, 20), block('n', 's', 'On the inner citadel', 40),
  block('x', 'day', 'A loose note', 60), block('h', 'day', 'Inbox', 1, 2), block('y', 'h', 'Under a second Inbox heading', 70),
]);

describe('today journal', () => {
  test('captured today lists the newest lines in sections, never headings, Reading source rows, empty or loose rows', () => {
    expect(recentCaptures(day, defaultTodayTemplate).map(value => value.id)).toEqual(['n', 'l', 'c']);
  });
  test('reading sources come from today’s Reading rows', () => {
    expect(readingSources(day, defaultTodayTemplate)).toEqual([source]);
  });
  test('a link is titled only when its title is known, without brackets breaking it', () => {
    expect(titledLink('https://example.org/a', null)).toBe('https://example.org/a');
    expect(titledLink('https://example.org/a', 'On [brackets]\n')).toBe('[On brackets](https://example.org/a)');
  });
});
