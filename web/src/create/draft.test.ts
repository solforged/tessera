import { describe, expect, test } from 'bun:test';
import type { Block, FieldDefinition } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { draftFieldOperations, draftFieldRows } from './draft';

const block = (id: string, parent_id: string, text: string, archived = false): Block => ({ id, parent_id, text, archived, page_id: 'page', kind: 'block', heading: null, revision: 3, created_at: 0, updated_at: 0 });
const role: FieldDefinition = { id: 'role', name: 'Role', kind: 'text', revision: 1, options: [], targets: [] };
const notebook = {} as NotebookClient;

describe('creation field writes', () => {
  test('keeps existing values even when an earlier duplicate entry is empty', async () => {
    const rows = [block('empty-entry', 'page', '[[role]]'), block('blank', 'empty-entry', ''), block('entry', 'page', '[[role]]'), block('value', 'entry', 'Researcher')];
    expect(draftFieldRows(rows, 'page', 'role').filled).toBe(true);
    expect(await draftFieldOperations(notebook, 'page', rows, [role], { role: { text: 'Writer' } }, null)).toEqual([]);
  });

  test('fills an empty value in place with its revision guard', async () => {
    const rows = [block('entry', 'page', '[[role]]'), block('blank', 'entry', '  ')];
    expect(await draftFieldOperations(notebook, 'page', rows, [role], { role: { text: 'Writer' } }, 'entry')).toEqual([{ op: 'edit_text', id: 'blank', base_revision: 3, text: 'Writer' }]);
  });

  test('does not revive or overwrite archived entries', async () => {
    const rows = [block('entry', 'page', '[[role]]', true), block('value', 'entry', 'Researcher')];
    const operations = await draftFieldOperations(notebook, 'page', rows, [role], { role: { text: 'Writer' } }, 'entry');
    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({ op: 'insert', parent_id: 'page', text: '[[role]]' });
    expect(operations[1]).toMatchObject({ op: 'insert', text: 'Writer' });
  });

  test('creates a relation page and its type in the same batch as its value', async () => {
    const field = { ...role, kind: 'instance' as const };
    const operations = await draftFieldOperations(notebook, 'page', [], [field], { role: { text: '[[New organisation]]', relationPick: { query: 'New organisation', targets: [], createId: 'new-org', create: { typeTitle: 'Group' } } } }, null);
    expect(operations.slice(0, 2)).toEqual([{ op: 'create_page', id: 'new-org', title: 'New organisation' }, { op: 'add_type', id: 'new-org', base_revision: 1, title: 'Group' }]);
    expect(operations.at(-1)).toMatchObject({ op: 'insert', text: '[[new-org]]' });
  });

  test('reuses a choice option created after the draft was opened', async () => {
    const field = { ...role, kind: 'choice' as const, options: [{ id: 'option', text: 'Writer' }] };
    const operations = await draftFieldOperations(notebook, 'page', [], [field], { role: { text: 'writer', option: 'writer' } }, null);
    expect(operations).toHaveLength(2);
    expect(operations.at(-1)).toMatchObject({ op: 'insert', text: '[[option]]' });
  });
});
