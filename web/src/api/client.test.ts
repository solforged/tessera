import { expect, test } from 'bun:test';
import { ApiError, bindWorkshop, createApi, setTransport } from './client';

test('binary resource and export endpoints send X-Tessera-Notebook when bound', async () => {
  const base = 'http://127.0.0.1:4399';
  const workshopId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  bindWorkshop(base, workshopId);
  const seen: { url: string; headers: Record<string, string> }[] = [];
  setTransport(async (url, init) => {
    seen.push({ url, headers: (init.headers as Record<string, string>) ?? {} });
    return new Response(new Blob(['ok']), { status: 200 });
  });
  try {
    const client = createApi(base);
    await client.resource('snap-1', 'images/diagram.png');
    await client.exportSources('bibtex', ['src-1']);
    await client.exportQuery('csl', { states: [] });
    expect(seen).toEqual([
      {
        url: `${base}/api/snapshots/snap-1/resources/images/diagram.png`,
        headers: { 'X-Tessera-Notebook': workshopId },
      },
      {
        url: `${base}/api/library/export?format=bibtex&ids=src-1`,
        headers: { 'X-Tessera-Notebook': workshopId },
      },
      {
        url: `${base}/api/library/export`,
        headers: { 'Content-Type': 'application/json', 'X-Tessera-Notebook': workshopId },
      },
    ]);
  } finally {
    setTransport((url, init) => fetch(url, init));
  }
});

test('ApiError marks network and 5xx failures uncertain and 4xx definitive', () => {
  expect(new ApiError('offline', 0, 'unreachable').uncertain).toBe(true);
  expect(new ApiError('boom', 502, 'internal').uncertain).toBe(true);
  expect(new ApiError('conflict', 409, 'conflict').uncertain).toBe(false);
  expect(String(new ApiError('readable sentence', 422, 'validation'))).toBe('readable sentence');
});
