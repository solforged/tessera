import { afterEach, describe, expect, test } from 'bun:test';
import {
  ApiError,
  bindWorkshop,
  CHANGE_CONNECTING,
  createApi,
  setStreamFactory,
  setTransport,
  type ChangeSocket,
} from './client';

// Later test files in the same process open real streams through the module.
afterEach(() => {
  setTransport((url, init) => fetch(url, init));
  setStreamFactory(undefined);
});

describe('createApi', () => {
  test('attaches X-Tessera-Notebook once bound and forwards actor identity on undo', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    setTransport(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const unbound = createApi('http://127.0.0.1:49991', 'tessera-web:test-actor');
    await unbound.changeHead();
    expect(calls[0]!.url).toBe('http://127.0.0.1:49991/api/changes/head');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Tessera-Notebook']).toBeUndefined();

    bindWorkshop('http://127.0.0.1:49991', '01JTESTWORKSHOP00000000000');
    await unbound.undoChange(42);
    expect(calls[1]!.url).toBe('http://127.0.0.1:49991/api/history/42/undo');
    expect(calls[1]!.init.method).toBe('POST');
    expect(calls[1]!.init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Tessera-Notebook': '01JTESTWORKSHOP00000000000',
    });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      actor: { kind: 'client', name: 'tessera-web:test-actor' },
    });

    await unbound.uploadImage(new Blob(['img'], { type: 'image/png' }));
    expect(calls[2]!.init.headers).toEqual({
      'Content-Type': 'image/png',
      'X-Tessera-Notebook': '01JTESTWORKSHOP00000000000',
    });
  });

  test('classifies uncertain network and 5xx errors separately from 4xx errors and aborts', async () => {
    const api = createApi('http://127.0.0.1:49992');

    setTransport(async () => {
      throw new TypeError('Failed to fetch');
    });
    let caught: unknown;
    try {
      await api.settings();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(0);
    expect((caught as ApiError).code).toBe('unreachable');
    expect((caught as ApiError).uncertain).toBe(true);
    expect(String(caught)).toBe('The workshop service is not reachable.');

    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    setTransport(async () => {
      throw controller.signal.reason;
    });
    await expect(api.settings(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    setTransport(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'conflict', message: 'Revision mismatch.', details: { rev: 3 } } }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    try {
      await api.settings();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).code).toBe('conflict');
    expect((caught as ApiError).details).toEqual({ rev: 3 });
    expect((caught as ApiError).uncertain).toBe(false);

    setTransport(async () => new Response('gateway failure', { status: 503 }));
    try {
      await api.settings();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(503);
    expect((caught as ApiError).uncertain).toBe(true);
    expect((caught as ApiError).message).toBe('The workshop service ran into a problem.');
  });

  test('reloads the window once on notebook_changed and delegates stream creation to streamFactory', async () => {
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    let reloads = 0;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: {
        href: 'http://127.0.0.1:49993/',
        reload() {
          reloads += 1;
        },
      },
    });

    try {
      setTransport(
        async () =>
          new Response(JSON.stringify({ error: { code: 'notebook_changed', message: 'Switched workshop.' } }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          }),
      );
      const api = createApi('http://127.0.0.1:49993');
      await expect(api.settings()).rejects.toMatchObject({ code: 'notebook_changed', status: 409 });
      await expect(api.settings()).rejects.toMatchObject({ code: 'notebook_changed', status: 409 });
      expect(reloads).toBe(1);
    } finally {
      if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
      else Reflect.deleteProperty(globalThis, 'location');
    }

    const fakeSocket: ChangeSocket = {
      readyState: CHANGE_CONNECTING,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close() {},
    };
    let seenAfter = -1;
    setStreamFactory(after => {
      seenAfter = after;
      return fakeSocket;
    });
    const api = createApi('http://127.0.0.1:49993');
    expect(api.stream(17)).toBe(fakeSocket);
    expect(seenAfter).toBe(17);
  });
});
