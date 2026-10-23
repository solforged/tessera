import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { Batch, Committed, Operation } from '../../src/api/types';
import { api, Service } from './service';

export interface SeedPage { id: string; title: string; blocks: string[] }
export interface Seed { directory: string; template: string; pages: SeedPage[]; copy(name: string): string; dispose(): void }

/** Build once through the public API, then copy the stopped workshop for each runtime. */
export async function seed(): Promise<Seed> {
  const directory = mkdtempSync(join(tmpdir(), 'tessera-spikes-'));
  const template = join(directory, 'template');
  let service: Service | undefined;
  const pages: SeedPage[] = [];
  try {
    service = await Service.start(template);
    for (let index = 0; index < 60; index++) {
      const page: SeedPage = { id: ulid(), title: `Spike page ${String(index).padStart(3, '0')}`, blocks: [] };
      const operations: Operation[] = [{ op: 'create_page', id: page.id, title: page.title }];
      let previous: string | null = null;
      for (let row = 0; row < 150; row++) {
        const id = ulid();
        // Include small folded subtrees without hiding the first four independent writer blocks.
        const parent = row >= 10 && row % 10 === 1 ? page.blocks[row - 1]! : page.id;
        operations.push({ op: 'insert', id, parent_id: parent, after: parent === page.id ? previous : null, text: `Seed ${index}:${row} quiet notebook text`, heading: null });
        if (parent === page.id) previous = id;
        page.blocks.push(id);
      }
      const batch: Batch = { actor: { kind: 'client', name: 'spike seed' }, reason: 'Runtime and soak corpus', operations };
      await api<Committed>(service.base, '/api/batches', batch);
      pages.push(page);
    }
    // Start in a real journal too, so journal navigation does not need to create its first row.
    const { today: date } = await api<{ today: string }>(service.base, '/api/settings');
    const id = ulid();
    await api(service.base, '/api/batches', { actor: { kind: 'client', name: 'spike seed' }, operations: [
      { op: 'create_journal', id, date },
      { op: 'insert', id: ulid(), parent_id: id, after: null, text: 'Seed journal row', heading: null },
    ] });
  } catch (error) { await service?.kill(); rmSync(directory, { recursive: true, force: true }); throw error; }
  await service.kill();
  return {
    directory, template, pages,
    copy(name) { const destination = join(directory, name); cpSync(template, destination, { recursive: true }); return destination; },
    dispose() { rmSync(directory, { recursive: true, force: true }); },
  };
}
