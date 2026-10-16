import { createEffect, createMemo, createSignal, on } from 'solid-js';
import type { Accessor } from 'solid-js';
import { api } from '../api/client';
import type { ChangeEvent, Fields } from '../api/types';
import { textTokens } from '../document/text-tokens';
import { foldName } from '../outline/names';
import { titleKey } from '../document/title-key';

// Mirrors crates/tessera-core/src/built_in.rs `schema`, which the starting-template route applies.
const startingTemplates = [
  { title: 'Person', fields: ['aliases', 'lived', 'affiliated with'] },
  { title: 'Group', fields: ['aliases', 'active'] },
  { title: 'Concept', fields: ['aliases', 'coined by', 'coined in'] },
  { title: 'Book', fields: ['author', 'editor', 'translator', 'published', 'publisher', 'identifier', 'language'] },
  { title: 'Article', fields: ['author', 'site', 'published', 'url'] },
] as const;

/** Only an empty template offers a starting point; existing field choices always win. */
export function startingTemplateFor(title: string, fields: readonly string[] = []) {
  if (fields.length) return null;
  const key = foldName(title);
  return startingTemplates.find(template => template.title.toLowerCase() === key) ?? null;
}

/** A block's types as canonical case-folded keys: `#tags`, then manual types, each once. */
export function typeKeys(text: string, manual: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const token of textTokens(text)) if (token.kind === 'tag' && token.value.trim()) keys.add(titleKey(token.value.trim()));
  for (const title of manual) if (title.trim()) keys.add(titleKey(title.trim()));
  return [...keys];
}

/**
 * Where a new entry for `field` goes among an owner's `children`, given its live `entries` in order: after the last
 * entry whose field comes earlier in the template, else just before the first entry, so template fields keep template
 * order. A field outside the template follows the last entry.
 */
export function entryAnchor(children: readonly string[], entries: readonly { id: string; field: string }[], template: readonly string[], field: string): string | null {
  const rank = template.indexOf(field);
  const earlier = rank < 0 ? entries : entries.filter(entry => { const other = template.indexOf(entry.field); return other >= 0 && other < rank; });
  const last = earlier.at(-1);
  if (last) return last.id;
  const first = entries[0];
  return first ? children[children.indexOf(first.id) - 1] ?? null : null;
}

/**
 * Template field orders for the types a block belongs to. Field summaries name every type with a template, so only
 * those types are fetched, once each; a change that touches a type page refetches its order.
 */
export function createTemplateCache(fields: Accessor<Fields | undefined>, lastChange: Accessor<ChangeEvent | null>) {
  const [orders, setOrders] = createSignal(new Map<string, readonly string[]>());
  const [required, setRequired] = createSignal(new Map<string, readonly string[]>());
  const loading = new Set<string>();
  const typeIds = createMemo(() => {
    const result = new Map<string, string>();
    for (const field of fields()?.fields ?? []) for (const type of field.types) {
      result.set(type.name.toLowerCase(), type.id);
      result.set(type.id.toLowerCase(), type.id);
    }
    return result;
  });
  function load(id: string) {
    if (loading.has(id)) return;
    loading.add(id);
    void api.type(id).then(type => {
      setOrders(previous => new Map(previous).set(id, type.fields));
      setRequired(previous => new Map(previous).set(id, type.required?.map(field => field.field_id) ?? []));
    }, () => {}).finally(() => loading.delete(id));
  }
  createEffect(on(lastChange, change => {
    if (!change) return;
    const known = orders();
    for (const block of change.blocks) if (known.has(block.id)) load(block.id);
  }, { defer: true }));
  /** Template fields of the types named by `keys`, first type first, each field once. */
  function templateFor(keys: readonly string[]): string[] {
    const ids = typeIds();
    const known = orders();
    const result: string[] = [];
    for (const key of keys) {
      const id = ids.get(key);
      if (!id) continue;
      const order = known.get(id);
      if (!order) { queueMicrotask(() => load(id)); continue; }
      for (const field of order) if (!result.includes(field)) result.push(field);
    }
    return result;
  }
  /** Template fields the types named by `keys` require; they show as slots whatever their Hide setting. */
  function requiredFor(keys: readonly string[]): ReadonlySet<string> {
    const ids = typeIds(), known = required();
    return new Set(keys.flatMap(key => known.get(ids.get(key) ?? '') ?? []));
  }
  return { templateFor, requiredFor };
}
