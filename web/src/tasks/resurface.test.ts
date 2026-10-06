import { expect, test } from 'bun:test';
import { ApiError, createApi } from '../api/client';

test('resurfacing client encodes dates, limits and citation actions', async () => {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname + url.search, body: request.method === 'POST' ? await request.json() : null });
      return Response.json(request.method === 'POST' ? null : []);
    },
  });
  try {
    const api = createApi(server.url.origin);
    expect(await api.resurfacing('2020-01-01')).toEqual([]);
    await api.resurfacing('2020-01-02', 2);
    await api.recordSurfacing('citation/id', '2020-01-01', 'kept');
    await api.recordSurfacing('citation/id', '2020-01-01', 'opened');
    await api.recordSurfacing('citation/id', '2020-01-01', 'muted');
    expect(requests).toEqual([
      { method: 'GET', path: '/api/highlights/resurface?date=2020-01-01&limit=3', body: null },
      { method: 'GET', path: '/api/highlights/resurface?date=2020-01-02&limit=2', body: null },
      ...['kept', 'opened', 'muted'].map(action => ({ method: 'POST', path: '/api/highlights/citation%2Fid/resurface', body: { date: '2020-01-01', action } })),
    ]);
  } finally { await server.stop(true); }
});

test('resurfacing client preserves validation errors for journal Retry', async () => {
  const server = Bun.serve({
    port: 0,
    fetch() { return Response.json({ error: { code: 'validation', message: 'Invalid date' } }, { status: 422 }); },
  });
  try {
    const api = createApi(server.url.origin);
    await expect(api.resurfacing('invalid')).rejects.toBeInstanceOf(ApiError);
    await expect(api.recordSurfacing('citation', 'invalid', 'kept')).rejects.toThrow('Invalid date');
  } finally { await server.stop(true); }
});
