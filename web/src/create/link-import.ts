import { ApiError } from '../api/client';
import type { NotebookClient } from '../document/contract';

/**
 * A Link also added to the Library: once its import finishes, the captured line becomes a reference to the new
 * source. Pending links survive a reload, so the line is linked whenever the job finishes.
 */
export interface PendingLink { job: string; pageId: string; blockId: string; text: string; title: string | null }

const storageKey = 'tessera.link-imports';
const watching = new Set<string>();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function load(): PendingLink[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(value) ? value.filter((entry): entry is PendingLink => typeof entry?.job === 'string' && typeof entry.blockId === 'string') : [];
  } catch { return []; }
}
function store(list: readonly PendingLink[]) {
  try { if (list.length) localStorage.setItem(storageKey, JSON.stringify(list)); else localStorage.removeItem(storageKey); } catch { /* The link is then made only in this session. */ }
}

/** The captured line once its source exists: the source by the link's title. */
export function sourceLineText(sourceId: string, title: string | null): string {
  const label = title?.replace(/[|[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return label ? `[[${sourceId}|${label}]]` : `[[${sourceId}]]`;
}

export function linkWhenImported(notebook: NotebookClient, pending: PendingLink) {
  store([...load().filter(entry => entry.job !== pending.job), pending]);
  void watch(notebook, pending);
}

export function resumeLinkImports(notebook: NotebookClient) {
  for (const pending of load()) void watch(notebook, pending);
}

async function watch(notebook: NotebookClient, pending: PendingLink) {
  if (watching.has(pending.job)) return;
  watching.add(pending.job);
  try {
    // Imports usually finish in seconds; the wait backs off so a slow one costs little, and a reload resumes it.
    for (let delay = 1000; delay < 10 * 60 * 1000; delay = Math.min(delay * 1.5, 30000)) {
      let job;
      try { job = await notebook.api.ingestJob(pending.job); }
      catch (reason) {
        if (reason instanceof ApiError && reason.status === 404) break;
        await wait(delay);
        continue;
      }
      if (job.state === 'failed') break;
      if (job.state === 'done') {
        if (job.source_id) await linkLine(notebook, pending, job.source_id);
        break;
      }
      await wait(delay);
    }
    store(load().filter(entry => entry.job !== pending.job));
  } catch {
    // A failed edit leaves the line as captured; the pending entry stays for the next launch.
  } finally { watching.delete(pending.job); }
}

async function linkLine(notebook: NotebookClient, pending: PendingLink, sourceId: string) {
  const page = await notebook.api.page(pending.pageId);
  const block = page.rows.find(row => row.block.id === pending.blockId)?.block;
  // A line edited or removed since its capture keeps what the writer made of it.
  if (!block || block.archived || block.text !== pending.text) return;
  await notebook.commit([{ op: 'edit_text', id: block.id, base_revision: block.revision, text: sourceLineText(sourceId, pending.title) }], 'Link to library source', [pending.pageId]);
}

/** Waits for an import to finish while someone watches and returns its source: null if it runs long, an error if it fails. */
export async function importedSource(notebook: NotebookClient, jobId: string, limit = 60000): Promise<string | null> {
  for (let waited = 0, delay = 500; waited < limit; waited += delay, delay = Math.min(delay * 1.5, 4000)) {
    const job = await notebook.api.ingestJob(jobId);
    if (job.state === 'done') return job.source_id;
    if (job.state === 'failed') throw new Error(job.error ?? 'The link could not be imported.');
    await wait(delay);
  }
  return null;
}
