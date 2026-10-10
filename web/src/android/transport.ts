import { Channel, invoke } from '@tauri-apps/api/core';
import { CHANGE_CLOSED, CHANGE_CLOSING, CHANGE_CONNECTING, CHANGE_OPEN } from '../api/client';
import type { ChangeSocket, Transport } from '../api/client';

/** `crates/tessera-android`'s `NotebookRequest`. */
interface NotebookRequest {
  method: string;
  path: string;
  headers: [string, string][];
  /** Base64: Android's IPC carries JSON, which would expand bytes into a number array. */
  body: string | null;
}

const decoder = new TextDecoder();

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/** Settle with `promise`, or reject when `signal` aborts. The notebook may still complete the request. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Send a request to the notebook in the app's process. Its reply is the status (u16),
 * the content type's length (u16), the content type, then the body. */
export const notebookFetch: Transport = async (url, init) => {
  const parsed = new URL(url, location.href);
  const request = new Request(parsed, init);
  const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
  const message: NotebookRequest = { method: request.method, path: `${parsed.pathname}${parsed.search}`, headers: [...request.headers], body: bytes && base64(bytes) };
  const reply = await abortable(invoke<ArrayBuffer | number[]>('notebook_request', { request: message }), request.signal).catch((reason: unknown) => {
    if (!request.signal.aborted) console.error('The notebook did not answer.', reason);
    throw reason;
  });
  const frame = reply instanceof ArrayBuffer ? new Uint8Array(reply) : Uint8Array.from(reply);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const status = view.getUint16(0);
  const typeEnd = 4 + view.getUint16(2);
  const contentType = decoder.decode(frame.subarray(4, typeEnd));
  return new Response([101, 204, 205, 304].includes(status) ? null : frame.subarray(typeEnd), { status, headers: contentType ? { 'content-type': contentType } : {} });
};

let nextStream = 0;

/** Committed changes over a Tauri channel. The `stream_changes` command runs until
 * the stream closes, then settles: an error rejects it. */
class NotebookChangeSocket implements ChangeSocket {
  readyState = CHANGE_CONNECTING;
  onopen: ChangeSocket['onopen'] = null;
  onmessage: ChangeSocket['onmessage'] = null;
  onerror: ChangeSocket['onerror'] = null;
  onclose: ChangeSocket['onclose'] = null;
  private readonly id = ++nextStream;

  constructor(after: number) {
    const channel = new Channel<string>(data => {
      if (this.readyState === CHANGE_OPEN) this.onmessage?.(new MessageEvent<string>('message', { data }));
    });
    // Let the caller attach its handlers first, as with a WebSocket.
    queueMicrotask(() => {
      if (this.readyState !== CHANGE_CONNECTING) return;
      this.readyState = CHANGE_OPEN;
      this.onopen?.(new Event('open'));
      invoke('stream_changes', { id: this.id, after, channel }).then(() => this.ended(), (reason: unknown) => {
        console.error('The change stream stopped.', reason);
        if (this.readyState === CHANGE_OPEN) this.onerror?.(new Event('error'));
        this.ended();
      });
    });
  }

  private ended(): void {
    if (this.readyState === CHANGE_CLOSED) return;
    this.readyState = CHANGE_CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  close(): void {
    if (this.readyState >= CHANGE_CLOSING) return;
    const opened = this.readyState === CHANGE_OPEN;
    this.readyState = CHANGE_CLOSING;
    if (opened) void invoke('close_changes', { id: this.id }).catch((reason: unknown) => console.error('The change stream did not close.', reason));
    queueMicrotask(() => this.ended());
  }
}

export const notebookStream = (after: number): ChangeSocket => new NotebookChangeSocket(after);
