import { describe, expect, test } from 'bun:test';
import type { Block } from '../api/types';
import { journalSectionName } from './journal-section';
import { defaultTodayTemplate } from './today-template';

const block = (id: string, parent: string | null, text = id, heading: Block['heading'] = null, kind: Block['kind'] = 'block'): Block => ({ id, page_id: 'day', parent_id: parent, kind, text, heading, archived: false, revision: 1, created_at: 1, updated_at: 1 });
const day = block('day', null, '2026-11-01', null, 'journal');
const blocks = new Map([block('inbox', 'day', 'Inbox', 1), block('reading', 'day', 'Reading', 1), block('loose', 'day'), block('plain', 'day', 'Journal', 2), block('under-inbox', 'inbox'), block('nested', 'under-inbox'), block('under-loose', 'loose')].map(value => [value.id, value]));
const parent = (id: string) => blocks.get(id) ?? null;

describe('journalSectionName', () => {
  test('names the written section whose root heading holds the block, however deep', () => {
    expect(journalSectionName(block('task', 'inbox'), day, defaultTodayTemplate, parent, '2026-11-01')).toBe('Inbox');
    expect(journalSectionName(block('task', 'nested'), day, defaultTodayTemplate, parent, '2026-11-01')).toBe('Inbox');
    expect(journalSectionName(block('task', 'reading'), day, defaultTodayTemplate, parent, '2026-11-01')).toBe('Reading');
  });

  test('puts rows outside every section in Notes on today and nowhere on other days', () => {
    expect(journalSectionName(block('task', 'day'), day, defaultTodayTemplate, parent, '2026-11-01')).toBe('Notes');
    expect(journalSectionName(block('task', 'under-loose'), day, defaultTodayTemplate, parent, '2026-11-01')).toBe('Notes');
    expect(journalSectionName(block('task', 'plain'), day, defaultTodayTemplate, parent, '2026-11-01')).toBe('Notes');
    expect(journalSectionName(block('task', 'day'), day, defaultTodayTemplate, parent, '2026-11-02')).toBeNull();
  });

  test('waits for an ancestor that has not loaded and gives up on one that is gone', () => {
    expect(journalSectionName(block('task', 'inbox'), day, defaultTodayTemplate, () => undefined, '2026-11-01')).toBeUndefined();
    expect(journalSectionName(block('task', 'missing'), day, defaultTodayTemplate, id => id === 'inbox' ? blocks.get(id) : null, '2026-11-01')).toBeNull();
  });
});
