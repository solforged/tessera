import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { ApiError, createApi, setTransport } from '../api/client';
import type { HistoryEntry } from '../api/types';

const fetchMock = spyOn(globalThis, 'fetch');
afterEach(() => {
  fetchMock.mockReset();
  setTransport((url, init) => fetch(url, init));
});
afterAll(() => { fetchMock.mockRestore(); });

const entry: HistoryEntry = {
  seq: 91,
  change_id: 'change-91',
  origin: 'phone-device',
  actor: { kind: 'client', name: 'tessera-web:phone-window' },
  reason: 'Revised a note',
  created_at: Date.UTC(2026, 9, 22, 12, 30),
  summary: 'Changed a block',
  page: { id: 'page', kind: 'page', parent_id: null, page_id: 'page', text: 'A note', heading: null, archived: false, revision: 1, created_at: 1, updated_at: 1 },
  undoable: true,
  undone_by: null,
  undoes: null,
};

test('history reads the entries envelope and defaults to the newest 50', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ entries: [entry] }));
  const client = createApi('http://history.test');
  expect(await client.history()).toEqual([entry]);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe('http://history.test/api/history?limit=50');
  expect(init?.method).toBe('GET');
});

test('history passes the last sequence as an exclusive before cursor', async () => {
  const earlier: HistoryEntry = { ...entry, seq: 90, change_id: null, origin: null, actor: { kind: 'person' }, page: null, undoable: false, undone_by: 91, undoes: 75 };
  fetchMock.mockResolvedValueOnce(Response.json({ entries: [earlier] }));
  const client = createApi('http://history.test');
  expect(await client.history(50, 91)).toEqual([earlier]);
  expect(String(fetchMock.mock.calls[0]![0])).toBe('http://history.test/api/history?limit=50&before=91');
});

test('undoChange attributes the undo to the notebook client window', async () => {
  const receipt = { undone: 91, kept_pages: [], committed: { seq: 92, revisions: [], settings: [], deletions: [], replayed: false, text_rewrites: [] } };
  fetchMock.mockResolvedValueOnce(Response.json(receipt));
  const client = createApi('http://history.test', 'tessera-web:window-identity');
  expect(await client.undoChange(91)).toEqual(receipt);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe('http://history.test/api/history/91/undo');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ actor: { kind: 'client', name: 'tessera-web:window-identity' } });
});

test('a refused undo preserves the service message for inline display', async () => {
  const message = 'change 91 was already undone by change 92';
  fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 'conflict', message } }, { status: 409 }));
  const client = createApi('http://history.test', 'tessera-web:window-identity');
  try {
    await client.undoChange(91);
    throw new Error('The undo should have been refused.');
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    expect(error.message).toBe(message);
    expect(error.status).toBe(409);
  }
});
