import { createEffect, createResource, createRoot } from 'solid-js';
import { api } from '../api/client';
import type { FieldDefinition } from '../api/types';
import type { Caret, EditResult, NotebookClient, PageDocument } from '../document/contract';
import { fieldEntryText, matchFieldEntry } from '../table/query';
import type { MenuItem } from '../ui/Menu';
import { extractedResets, sourceFieldName } from './source';

const fieldCreations = new WeakMap<NotebookClient, Map<string, Promise<FieldDefinition>>>();

function documentReady(doc: PageDocument): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  createRoot(dispose => {
    createEffect(() => {
      const status = doc.status();
      if (status === 'loading') return;
      const message = doc.statusMessage();
      dispose();
      if (status === 'ready') resolve();
      else reject(new Error(message));
    });
  });
  return promise;
}

function ensureField(notebook: NotebookClient, name: string): Promise<FieldDefinition> {
  const pending = fieldCreations.get(notebook) ?? new Map<string, Promise<FieldDefinition>>();
  fieldCreations.set(notebook, pending);
  const key = name.toLowerCase();
  const existing = pending.get(key);
  if (existing) return existing;
  const creation = (async () => {
    const result = await api.fields();
    const definition = result.fields.find(field => field.name.toLowerCase() === key);
    if (definition) return definition;
    const fieldsDoc = notebook.open(result.page_id);
    try {
      await documentReady(fieldsDoc);
      // An empty page is seeded with one blank block on load; name it instead of adding a sibling.
      let blank: string | undefined;
      for (const id of fieldsDoc.outline.children(result.page_id)) {
        const block = fieldsDoc.block(id);
        if (!block || block.archived) continue;
        if (block.text.toLowerCase() === key) return { id, name: block.text, kind: 'text' as const, revision: block.revision, options: [] };
        if (!block.text.trim() && !blank) blank = id;
      }
      const written = blank
        ? fieldsDoc.edit({ kind: 'text', id: blank, text: name })
        : fieldsDoc.edit({ kind: 'insert', parentId: result.page_id, after: fieldsDoc.outline.children(result.page_id).at(-1) ?? null, text: name });
      if (!written.ok) throw new Error(written.reason);
      return { id: blank ?? written.created[0]!, name, kind: 'text' as const, revision: 0, options: [] };
    } finally { fieldsDoc.release(); }
  })();
  pending.set(key, creation);
  void creation.then(() => pending.delete(key), () => pending.delete(key));
  return creation;
}

export function createFieldEntryConversion(options: {
  doc: PageDocument; notebook: NotebookClient;
  disposed(): boolean; composing(): boolean; caret(): Caret | null; focusEpoch(): number;
  onStart(): void; onField(field: FieldDefinition): void;
  onCommitted(id: string, caret: Caret | null, epoch: number, focus: boolean): void;
  onError(message: string): void;
}) {
  const pending = new Set<string>();
  return (id: string, focus = true): boolean => {
    if (options.disposed() || options.composing()) return false;
    if (pending.has(id)) return true;
    const original = options.doc.block(id)?.text;
    if (original === undefined) return false;
    const match = matchFieldEntry(original);
    if (!match) return false;
    pending.add(id);
    const before = options.caret()?.id === id ? { ...options.caret()! } : { id, offset: original.length };
    const epoch = options.focusEpoch();
    const heldDoc = options.notebook.open(options.doc.pageId);
    options.onStart();
    void (async () => {
      try {
        const field = await ensureField(options.notebook, match.name);
        if (!options.disposed()) options.onField(field);
        if (heldDoc.block(id)?.text !== original) return;
        let result: EditResult;
        // The existing paste transaction rewrites the label and inserts a
        // first child atomically. Literal leading whitespace needs two edits.
        if (match.value === match.value.trimStart()) {
          result = heldDoc.edit({
            kind: 'replaceRange', range: { anchor: { id, offset: 0 }, head: { id, offset: original.length } },
            between: [], text: `${fieldEntryText(field.id)}\n  ${match.value}`, mode: 'paste',
          }, before);
        } else {
          result = heldDoc.edit({ kind: 'text', id, text: fieldEntryText(field.id) }, before);
          if (result.ok) {
            result = heldDoc.edit({ kind: 'insert', parentId: id, after: null, text: match.value }, before);
            if (result.ok && result.caret) result = { ...result, caret: { ...result.caret, offset: match.value.length } };
          }
        }
        if (!result.ok) throw new Error(result.reason);
        if (!options.disposed()) options.onCommitted(id, result.caret, epoch, focus);
      } catch (error) {
        if (!options.disposed()) options.onError(error instanceof Error ? error.message : String(error));
      } finally {
        pending.delete(id);
        heldDoc.release();
      }
    })();
    return true;
  };
}

/** Both entry actions and source actions apply the same positional reset plan. */
export function createSourceFieldResets(options: {
  doc: PageDocument; notebook: NotebookClient; definitions(): ReadonlyMap<string, FieldDefinition>;
  caret(): Caret | null; onError(message: string): void;
}) {
  const { doc } = options;
  const [extracted] = createResource(
    () => doc.root()?.source ? [doc.pageId, options.notebook.changeSequence()] as const : false,
    ([pageId]) => api.extracted(pageId),
  );
  return (entryId?: string): MenuItem[] => {
    if (!doc.root()?.source || extracted.error) return [];
    const plans = (entryId ? [entryId] : doc.outline.children(doc.pageId)).flatMap(id => {
      const entry = doc.block(id);
      if (!entry || entry.archived || entry.parentId !== doc.pageId) return [];
      const name = sourceFieldName(entry.text, options.definitions());
      if (!name) return [];
      const values = doc.outline.children(id).flatMap(child => {
        const value = doc.block(child);
        return value && !value.archived ? [value] : [];
      });
      const plan = extractedResets(values, extracted()?.find(([label]) => label.toLowerCase() === name.toLowerCase())?.[1]);
      return plan.set.length || plan.insert.length ? [{ id, ...plan }] : [];
    });
    return plans.length ? [{ label: 'Reset to extracted', action: () => {
      for (const plan of plans) {
        for (const value of plan.set) {
          const result = doc.edit({ kind: 'text', ...value }, options.caret());
          if (!result.ok) { options.onError(result.reason); return; }
        }
        let after = doc.outline.children(plan.id).at(-1) ?? null;
        for (const text of plan.insert) {
          const result = doc.edit({ kind: 'insert', parentId: plan.id, after, text }, options.caret());
          if (!result.ok) { options.onError(result.reason); return; }
          after = result.created[0]!;
        }
      }
      void doc.flush().catch(reason => options.onError(String(reason)));
    } }] : [];
  };
}
