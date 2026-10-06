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

/** Appends a choice option under the field's definition and returns the option's id. */
export async function addFieldOption(notebook: NotebookClient, field: FieldDefinition, text: string): Promise<string> {
  const existing = field.options.find(option => option.text.toLowerCase() === text.toLowerCase());
  if (existing) return existing.id;
  const definition = await api.block(field.id);
  const doc = notebook.open(definition.page_id);
  try {
    await documentReady(doc);
    const written = doc.edit({ kind: 'insert', parentId: field.id, after: doc.outline.children(field.id).at(-1) ?? null, text });
    if (!written.ok) throw new Error(written.reason);
    return written.created[0]!;
  } finally { doc.release(); }
}

export interface FieldEntryConversion {
  /** Converts a `Name:: value` block if its text matches; true when a conversion started. */
  shorthand(id: string, focus?: boolean): boolean;
  /** Turns block `id` into an entry for `field`, an existing definition or a name to find or create, keeping the text after `from` as its value. */
  entry(id: string, field: FieldDefinition | string, from: number, focus?: boolean): void;
}

export function createFieldEntryConversion(options: {
  doc: PageDocument; notebook: NotebookClient;
  disposed(): boolean; composing(): boolean; caret(): Caret | null; focusEpoch(): number;
  /** A definition already loaded by name, so a known field converts without a round trip. */
  known(name: string): FieldDefinition | undefined;
  onStart(): void; onField(field: FieldDefinition): void;
  onCommitted(id: string, caret: Caret | null, epoch: number, focus: boolean, field: FieldDefinition): void;
  onError(message: string): void;
}) {
  const pending = new Set<string>();
  /**
   * Rewrites the block as `[[field]]` with `value` as its first child. Typing may continue while a new
   * definition is created, so the caret's place in the value is read at write time.
   */
  function write(doc: PageDocument, id: string, field: FieldDefinition, valueStart: number, epoch: number, focus: boolean) {
    const text = doc.block(id)!.text;
    const value = text.slice(valueStart);
    const at = options.caret();
    const before = at?.id === id ? { ...at } : { id, offset: text.length };
    let result: EditResult;
    // The paste transaction rewrites the label and inserts a first child atomically. An empty value or
    // literal leading whitespace needs two edits.
    if (value && value === value.trimStart()) {
      result = doc.edit({
        kind: 'replaceRange', range: { anchor: { id, offset: 0 }, head: { id, offset: text.length } },
        between: [], text: `${fieldEntryText(field.id)}\n  ${value}`, mode: 'paste',
      }, before);
    } else {
      result = doc.edit({ kind: 'text', id, text: fieldEntryText(field.id) }, before);
      if (result.ok) result = doc.edit({ kind: 'insert', parentId: id, after: null, text: value }, before);
    }
    if (!result.ok) throw new Error(result.reason);
    const offset = before.id === id ? Math.max(0, Math.min(value.length, before.offset - valueStart)) : value.length;
    options.onCommitted(id, result.caret ? { ...result.caret, offset } : null, at?.id === id ? options.focusEpoch() : epoch, focus, field);
  }
  function start(id: string, target: FieldDefinition | string, valueStart: number, focus: boolean, still: (text: string) => number | null) {
    pending.add(id);
    const epoch = options.focusEpoch();
    const heldDoc = options.notebook.open(options.doc.pageId);
    options.onStart();
    const known = typeof target === 'string' ? options.known(target) : target;
    const finish = () => { pending.delete(id); heldDoc.release(); };
    if (known) {
      try { write(heldDoc, id, known, valueStart, epoch, focus); }
      catch (error) { options.onError(error instanceof Error ? error.message : String(error)); }
      finally { finish(); }
      return;
    }
    void (async () => {
      try {
        const field = await ensureField(options.notebook, typeof target === 'string' ? target : target.name);
        if (options.disposed()) return;
        options.onField(field);
        const text = heldDoc.block(id)?.text;
        const from = text === undefined ? null : still(text);
        if (from !== null) write(heldDoc, id, field, from, epoch, focus);
      } catch (error) {
        if (!options.disposed()) options.onError(error instanceof Error ? error.message : String(error));
      } finally { finish(); }
    })();
  }
  const valueOffset = (text: string, value: string) => text.length - value.length;
  return {
    shorthand(id, focus = true) {
      if (options.disposed() || options.composing()) return false;
      if (pending.has(id)) return true;
      const original = options.doc.block(id)?.text;
      const match = original === undefined ? null : matchFieldEntry(original);
      if (!match) return false;
      const name = match.name.toLowerCase();
      // Still the same field after the definition is created: convert what the block holds by then.
      start(id, match.name, valueOffset(original!, match.value), focus, text => {
        const now = matchFieldEntry(text);
        return now && now.name.toLowerCase() === name ? valueOffset(text, now.value) : null;
      });
      return true;
    },
    entry(id, field, from, focus = true) {
      if (options.disposed() || pending.has(id) || !options.doc.block(id)) return;
      const original = options.doc.block(id)!.text;
      const valueAt = (text: string) => { let at = from; while (text[at] === ' ') at++; return at; };
      start(id, field, valueAt(original), focus, text => text.startsWith(original.slice(0, from)) ? valueAt(text) : null);
    },
  } satisfies FieldEntryConversion;
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
