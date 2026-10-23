import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Subprocess } from 'bun';

export const root = resolve(import.meta.dir, '../../..');
export const sleep = (ms: number) => Bun.sleep(ms);

export async function api<T>(base: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

export class Service {
  private child?: Subprocess;
  private running = false;
  readonly base: string;
  private constructor(readonly workshop: string, readonly port: number) { this.base = `http://127.0.0.1:${port}`; }
  get pid() { return this.child?.pid ?? null; }
  static preflight() {
    const missing = [
      [join(root, 'target/release/tessera'), 'cargo build --release -p tessera-cli'],
      [join(root, 'web/dist/index.html'), 'bun run --cwd web build'],
    ].filter(([path]) => !existsSync(path!));
    if (missing.length) throw new Error(`Build prerequisites first, from the repo root:\n${missing.map(([, command]) => command).join('\n')}`);
  }
  static async start(workshop: string) {
    Service.preflight();
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    const service = new Service(workshop, port);
    await service.restart();
    return service;
  }
  async restart() {
    if (this.running) throw new Error('Stop the previous service before restarting it.');
    mkdirSync(this.workshop, { recursive: true });
    const { TESSERA_WORKSHOP: _, ...env } = process.env;
    this.child = Bun.spawn([
      join(root, 'target/release/tessera'), '--workshop', this.workshop, 'serve',
      '--port', String(this.port), '--sync-port', '0', '--assets', join(root, 'web/dist'),
    ], { cwd: root, env, stdout: Bun.file(join(this.workshop, 'perf-service.log')), stderr: Bun.file(join(this.workshop, 'perf-service-error.log')) });
    this.running = true;
    const child = this.child;
    void child.exited.then(() => { if (this.child === child) this.running = false; });
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (!this.running) throw new Error(`Service exited ${this.child.exitCode ?? this.child.signalCode}. See ${this.workshop}/perf-service-error.log`);
        try { await api(this.base, '/api/notebook'); return; } catch { await sleep(50); }
      }
      throw new Error(`Service did not start in 30 s. See ${this.workshop}/perf-service-error.log`);
    } catch (error) { await this.kill('SIGKILL'); throw error; }
  }
  async kill(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGINT') {
    const child = this.child;
    if (!child || !this.running) return;
    child.kill(signal);
    const exited = await Promise.race([child.exited.then(() => true), sleep(10_000).then(() => false)]);
    if (!exited) { child.kill('SIGKILL'); await child.exited; }
    this.running = false;
  }
  walBytes() {
    const path = join(this.workshop, 'notebook.db-wal');
    return existsSync(path) ? statSync(path).size : 0;
  }
}
