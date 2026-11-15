import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { createApi } from '../api/client';
import type { ApiClient } from '../api/client';

const root = resolve(import.meta.dir, '../../..');
/** A hook or test that starts a workshop needs a timeout above this; Bun's default is 5 s. */
const READY_MS = 30_000;
const probe = { data() {} };
type Service = Subprocess<'ignore', 'ignore', 'pipe'>;

/** Ports this process has reserved: each stays bound until its workshop starts, so no other run is given it. */
const held = new Map<number, { stop(closeActiveConnections?: boolean): void }>();

export interface WorkshopService {
  baseUrl: string;
  port: number;
  directory: string;
  api: ApiClient;
  workshopId: string;
  /** Stops the service and removes its workshop. */
  stop(): Promise<void>;
}

/** A free loopback port, chosen by the system and reserved until `startService` uses it. */
export function freePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: probe });
  held.set(listener.port, listener);
  return listener.port;
}

/**
 * Serve an empty workshop from a temporary folder with the debug build of
 * `tessera`: `TESSERA_TEST_BINARY`, or the one in Cargo's target directory.
 */
export async function startService({
  name,
  port = freePort(),
}: {
  name: string;
  port?: number;
}): Promise<WorkshopService> {
  const directory = await mkdtemp(join(tmpdir(), `tessera-${name}-`));
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = createApi(baseUrl);
  const binary = serviceBinary();
  held.get(port)?.stop(true);
  held.delete(port);
  let child: Service;
  try {
    child = Bun.spawn([binary, '--workshop', directory, 'serve', '--port', String(port), '--sync-port', '0'], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `The workshop service could not start (${binary}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stop = async () => {
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  };
  try {
    return { baseUrl, port, directory, api, workshopId: await ready(api, directory, child), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function serviceBinary(): string {
  if (Bun.env.TESSERA_TEST_BINARY) return Bun.env.TESSERA_TEST_BINARY;
  const target = Bun.env.CARGO_TARGET_DIR;
  const directory = target ? (isAbsolute(target) ? target : resolve(root, target)) : join(root, 'target');
  return join(directory, 'debug', 'tessera');
}

async function ready(api: ApiClient, directory: string, child: Service): Promise<string> {
  const expected = await realpath(directory);
  const deadline = Date.now() + READY_MS;
  const stderr = drain(child.stderr);
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  for (;;) {
    if (exited)
      throw new Error(`The workshop service exited before it was ready (${child.exitCode}).${await stderr()}`);
    let info;
    try {
      info = await api.notebook(AbortSignal.timeout(2_000));
    } catch {
      if (Date.now() > deadline)
        throw new Error(`The workshop service was not ready within ${READY_MS / 1000} s.${await stderr()}`);
      await Bun.sleep(20);
      continue;
    }
    if ((await realpath(info.path)) !== expected)
      throw new Error(`The test port serves another workshop, ${info.path}.`);
    return info.id;
  }
}

/** Keep reading the service's log so a full pipe never stalls it; the returned function gives what it has said so far. */
function drain(stream: ReadableStream<Uint8Array>): () => Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const finished = (async () => {
    try {
      for await (const chunk of stream) text = (text + decoder.decode(chunk, { stream: true })).slice(-8_000);
    } catch {
      /* the service was killed */
    }
  })();
  return async () => {
    await Promise.race([finished, Bun.sleep(200)]);
    return text.trim() ? `\n${text.trim()}` : '';
  };
}
