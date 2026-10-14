import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api/client';
import type { Block, PageReferences, ReferenceCount } from '../api/types';
import { readJournalRelated } from './related-reads';

const virtualJournal = { kind: 'journal', revision: 0 } as const;
const persistedJournal = { kind: 'journal', revision: 1 } as const;

describe('related reads for a local journal day', () => {
  test('missing reference groups and counts are quietly empty before the journal is committed', async () => {
    const missing = new ApiError('Not found.', 404, 'not_found');
    await expect(readJournalRelated<PageReferences>(Promise.reject(missing), virtualJournal, { total: 0, groups: [] }))
      .resolves.toEqual({ total: 0, groups: [] });
    await expect(readJournalRelated<ReferenceCount[]>(Promise.reject(missing), virtualJournal, []))
      .resolves.toEqual([]);
  });

  test('returns real references unchanged, including when the root has not acknowledged its commit yet', async () => {
    const references: PageReferences = {
      total: 1,
      groups: [{ page: { id: 'other' } as Block, sources: [{ source: { id: 'linked-task' } as Block, targets: ['journal'] }] }],
    };
    const counts = [{ block_id: 'journal', count: 1 }];
    for (const root of [virtualJournal, persistedJournal]) {
      expect(await readJournalRelated(Promise.resolve(references), root, { total: 0, groups: [] })).toBe(references);
      expect(await readJournalRelated(Promise.resolve(counts), root, [])).toBe(counts);
    }
  });

  test('does not hide missing persisted journals, ordinary pages, or unknown roots', async () => {
    const missing = new ApiError('Not found.', 404, 'not_found');
    for (const root of [persistedJournal, { kind: 'page', revision: 0 } as const, undefined]) {
      await expect(readJournalRelated(Promise.reject(missing), root, [])).rejects.toBe(missing);
    }
  });

  test('does not hide service, offline, or canceled requests on a virtual journal', async () => {
    for (const error of [new ApiError('Service error.', 500, 'internal'), new ApiError('Offline.', 0, 'offline'), new Error('Aborted')]) {
      await expect(readJournalRelated(Promise.reject(error), virtualJournal, [])).rejects.toBe(error);
    }
  });
});
