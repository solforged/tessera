import { expect, test } from 'bun:test';
import { ApiError } from '../api/client';
import type { Block, Committed, Operation, PageView, RejectedChange } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { settleRejection } from './rejections';

const change: RejectedChange = { id: 'rejection', change_id: 'change', origin: 'fold', origin_name: 'Fold', mine: true, error: 'The block was deleted', created_at: 1000, page_id: 'page', page_title: 'Notes', texts: ['First words', 'Second words'] };
const block = (id: string, parent: string | null): Block => ({ id, parent_id: parent, page_id: 'page', kind: parent ? 'block' : 'page', text: '', heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0 });
function notebook(page: PageView | null) {
  const calls: Operation[][] = [];
  const client = {
    roots: () => [], todayDate: () => '2026-10-12',
    api: { page: async () => page!, journal: async () => { throw new ApiError('No journal', 404, 'not_found'); } },
    commit: async (operations: readonly Operation[]): Promise<Committed> => {
      calls.push([...operations]);
      return { seq: calls.length, revisions: operations.flatMap(operation => operation.op === 'insert' || operation.op === 'create_journal' ? [{ id: operation.id, revision: 1 }] : []), settings: [], deletions: [], replayed: false, text_rewrites: [] };
    },
  } as unknown as NotebookClient;
  return { client, calls };
}

test('recovering appends words after the last top-level block and settles in the same undoable batch', async () => {
  const { client, calls } = notebook({ root: block('page', null), rows: [{ block: block('last', 'page'), depth: 0, manual_types: [] }, { block: block('child', 'last'), depth: 1, manual_types: [] }], targets: [] });
  const receipt = await settleRejection(client, change, true);
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toMatchObject({ op: 'insert', parent_id: 'page', after: 'last', text: 'First words' });
  const first = calls[0]![0] as Extract<Operation, { op: 'insert' }>;
  expect(calls[0]![1]).toMatchObject({ op: 'insert', parent_id: 'page', after: first.id, text: 'Second words' });
  expect(calls[0]!.at(-1)).toEqual({ op: 'settle_sync_rejection', id: change.id, settled: true });
  await receipt.undo();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toHaveLength(3);
  expect(calls[1]![0]).toEqual({ op: 'settle_sync_rejection', id: change.id, settled: false });
  expect(calls[1]!.slice(1).every(operation => operation.op === 'delete' && operation.base_revision === 1)).toBe(true);
});

test('words without a surviving page create today in the same batch, and undo never deletes the journal day', async () => {
  const { client, calls } = notebook(null);
  const receipt = await settleRejection(client, { ...change, page_id: null }, true);
  expect(calls).toHaveLength(1);
  const day = calls[0]![0] as Extract<Operation, { op: 'create_journal' }>;
  expect(day).toMatchObject({ op: 'create_journal', date: '2026-10-12' });
  expect(calls[0]![1]).toMatchObject({ op: 'insert', parent_id: day.id, after: null });
  await receipt.undo();
  expect(calls[1]!.some(operation => operation.op === 'delete' && operation.id === day.id)).toBe(false);
});

test('dismiss and undo settle only the rejection, without changing the page', async () => {
  const { client, calls } = notebook(null);
  const receipt = await settleRejection(client, change, false);
  expect(calls[0]).toEqual([{ op: 'settle_sync_rejection', id: change.id, settled: true }]);
  await receipt.undo();
  expect(calls[1]).toEqual([{ op: 'settle_sync_rejection', id: change.id, settled: false }]);
});
