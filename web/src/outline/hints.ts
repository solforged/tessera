import { createEffect, createMemo, createResource, createSignal, on, onCleanup } from 'solid-js';
import type { DerivedType, NotebookClient, PageDocument } from '../document/contract';
import { titleKey } from '../document/title-key';
import { typeKeys } from '../fields/templates';
import { parseCardText } from '../review/card-text';
import { fieldEntryId } from '../table/query';

type Hint = { kind: 'tag'; blockId: string; type: DerivedType } | { kind: 'card'; blockId: string } | { kind: 'field'; blockId: string; entryId: string };
interface Seen { types: string[]; card: boolean; field: boolean }
interface HintHistory { claim(kind: Hint['kind'], typeId?: string): boolean }
const dismissals = new WeakMap<NotebookClient, Set<() => void>>();

/** Claim when shown, not when detected: two panes and later visits share the same workshop's receipts. */
export function createHintHistory(notebookId: string, storage: Pick<Storage, 'getItem' | 'setItem'>): HintHistory {
  const key = `tessera.discovery.${notebookId}`;
  let seen: Seen = { types: [], card: false, field: false };
  return {
    claim(kind: Hint['kind'], typeId?: string): boolean {
      try {
        const stored = JSON.parse(storage.getItem(key) ?? 'null');
        if (stored) seen = {
          types: Array.isArray(stored.types) ? stored.types.filter((id: unknown): id is string => typeof id === 'string') : [],
          card: stored.card === true, field: stored.field === true,
        };
      } catch { /* Discovery is optional; keep this window's history when storage is unavailable. */ }
      if (kind === 'tag' ? seen.types.includes(typeId!) : seen[kind]) return false;
      if (kind === 'tag') seen.types.push(typeId!);
      else seen[kind] = true;
      try { storage.setItem(key, JSON.stringify(seen)); } catch { /* The current pane still shows each hint once. */ }
      return true;
    },
  };
}

export function createOutlineHints(options: {
  notebook: NotebookClient; doc: PageDocument;
  editing(): string | null;
  visible(): readonly string[];
  fieldKnown(id: string): boolean;
}) {
  const { notebook, doc } = options;
  const [identity] = createResource(() => notebook.api.notebook());
  const [pending, setPending] = createSignal<Hint[]>([]);
  const [shown, setShown] = createSignal<Hint[]>([]);
  const listeners = dismissals.get(notebook) ?? new Set<() => void>();
  dismissals.set(notebook, listeners);
  const dismiss = () => setShown([]);
  listeners.add(dismiss);
  onCleanup(() => listeners.delete(dismiss));
  const detectedTypes = new Set<string>();
  const initialSequence = notebook.changeSequence();
  const history = createMemo(() => {
    const id = identity.error ? undefined : identity()?.id;
    return id ? createHintHistory(id, { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }) : undefined;
  });

  function queue(hint: Hint) {
    setPending(previous => previous.some(item => item.kind === hint.kind && (item.kind === 'tag' && hint.kind === 'tag' ? item.type.id === hint.type.id : item.blockId === hint.blockId)) ? previous : [...previous, hint]);
  }
  function queueField(entryId: string) {
    const owner = doc.outline.parentOf(entryId);
    // Inline field entries are hidden; their owner, or their value on a journal, carries the receipt.
    const blockId = owner === doc.pageId ? doc.outline.children(entryId)[0] ?? entryId : owner;
    queue({ kind: 'field', blockId, entryId });
  }
  createEffect(on([notebook.derivedTypes, () => doc.status()], ([types, status]) => {
    if (status !== 'ready') return;
    for (const type of types) {
      if (detectedTypes.has(type.id)) continue;
      for (let at = 0; at < doc.outline.size(); at++) {
        const block = doc.block(doc.outline.idAt(at));
        if (!block || block.archived || !typeKeys(block.text, block.manual_types).includes(titleKey(type.title))) continue;
        detectedTypes.add(type.id);
        queue({ kind: 'tag', blockId: block.id, type });
        break;
      }
    }
  }));
  createEffect(on(notebook.lastChange, change => {
    if (!change || change.seq <= initialSequence) return;
    for (const block of change.blocks) {
      if (block.page_id !== doc.pageId || block.kind !== 'block' || block.archived) continue;
      if (parseCardText(block.text).cards.length) queue({ kind: 'card', blockId: block.id });
      const field = fieldEntryId(block.text);
      if (field && options.fieldKnown(field)) queueField(block.id);
    }
  }, { defer: true }));
  createEffect(() => {
    const seen = history();
    if (!seen || doc.saveState() !== 'saved') return;
    const active = options.editing(), visible = new Set(options.visible());
    const waiting: Hint[] = [], ready: Hint[] = [];
    for (const hint of pending()) {
      const block = doc.block(hint.blockId);
      if (!block || block.archived) continue;
      if (hint.kind === 'tag' ? !typeKeys(block.text, block.manual_types).includes(titleKey(hint.type.title)) : hint.kind === 'card' ? !parseCardText(block.text).cards.length : !fieldEntryId(doc.block(hint.entryId)?.text ?? '')) continue;
      if (active === hint.blockId || !visible.has(hint.blockId)) { waiting.push(hint); continue; }
      if (seen.claim(hint.kind, hint.kind === 'tag' ? hint.type.id : undefined)) ready.push(hint);
    }
    if (ready.length) setShown(previous => [...previous, ...ready]);
    if (waiting.length !== pending().length) setPending(waiting);
  });
  return {
    forBlock: (id: string) => shown().filter(hint => hint.blockId === id && options.editing() !== id),
    typed: () => { for (const dismiss of listeners) dismiss(); },
    fieldEntry: queueField,
  };
}
