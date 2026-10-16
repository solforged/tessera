import type { TaskRow, AgendaItem } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { documentReady } from '../outline/source-fields';

export type TaskSourceEdit = (doc: PageDocument) => Promise<boolean | void>;
interface Entry { doc: PageDocument; changed: boolean }

/** Agenda routes accepted edits and Undo through the canonical page, even after its row leaves the list. */
export class TaskSourceHistory {
  private documents = new Map<string, PageDocument>();
  private history: Entry[] = [];
  private undone: Entry[] = [];

  canUndo(redo = false): boolean { return (redo ? this.undone : this.history).length > 0; }
  private queue = Promise.resolve();

  constructor(private notebook: Pick<NotebookClient, 'open'>) {}

  edit(row: TaskRow | AgendaItem, apply: TaskSourceEdit): Promise<boolean> {
    const pageId = row.source.page.id;
    let doc = this.documents.get(pageId);
    if (!doc) { doc = this.notebook.open(pageId); this.documents.set(pageId, doc); }
    const entry: Entry = { doc, changed: false };
    // Register the intent before loading or checking running work, so an immediate Undo waits for it.
    this.history.push(entry); this.undone = [];
    return this.enqueue(async () => {
      try {
        await documentReady(entry.doc);
        if (await apply(entry.doc) === false) return false;
        entry.changed = true;
        await entry.doc.flush();
        return true;
      } finally {
        if (!entry.changed) {
          this.history = this.history.filter(value => value !== entry);
          this.undone = this.undone.filter(value => value !== entry);
        }
      }
    });
  }

  undo(redo = false): Promise<void> {
    const from = redo ? this.undone : this.history;
    const to = redo ? this.history : this.undone;
    const entry = from.pop();
    if (!entry) return Promise.resolve();
    to.push(entry);
    return this.enqueue(async () => {
      if (!entry.changed) return;
      redo ? entry.doc.redo() : entry.doc.undo();
      await entry.doc.flush();
      const message = entry.doc.historyMessage();
      if (message) throw new Error(message);
    });
  }

  dispose(): void {
    void this.queue.then(() => {
      for (const doc of this.documents.values()) doc.release();
      this.documents.clear();
    });
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
