import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import type { FieldDefinition, QueryRow, QuoteState } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { CriteriaCellEditor } from '../compare/CriteriaCellEditor';
import { ValueEditor, writeFieldValue } from '../fields/value-editor';
import { hasValueEditor } from '../fields/value-options';
import { checkboxValue } from '../fields/kinds';
import { createOptionValue } from '../fields/commands';
import { BlockText } from '../outline/BlockText';
import { titleTargets, typedTitles, withLinkedTitles } from '../outline/link-titles';
import { fieldEntryId } from './query';

/** Shared value blocks, kind pickers and one commit boundary for live view cells. */
export function ViewValue(props: {
  row: QueryRow; field: FieldDefinition; doc?: PageDocument; notebook: NotebookClient;
  onEdited(doc: PageDocument): void; onError(message: string): void;
  onFill?(field: string, direction: -1 | 1): void;
  onReady?(start: () => void): void;
}) {
  let host!: HTMLDivElement;
  const [editing, setEditing] = createSignal<string | null>(null);
  const [valueId, setValueId] = createSignal<string>();
  const [picker, setPicker] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const values = createMemo(() => {
    const doc = props.doc;
    doc?.outline.version(); doc?.archivedVersion();
    if (doc?.status() !== 'ready') return props.row.values[props.field.id] ?? [];
    return doc.outline.children(props.row.block.block.id).filter(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === props.field.id)
      .flatMap(entry => doc.outline.children(entry).filter(id => !doc.isArchived(id)).map(id => ({ id, text: doc.block(id)?.text ?? '' })));
  });
  function finish(focus = true) {
    setEditing(null); setPicker(false);
    if (focus) queueMicrotask(() => host?.isConnected && host.focus({ preventScroll: true }));
  }
  async function write(draft: string, focus = true, quote?: QuoteState, direction?: -1 | 1, option?: string) {
    if (busy()) return;
    const doc = props.doc;
    if (!doc || doc.status() !== 'ready') { props.onError('The reading is still loading.'); return; }
    setBusy(true);
    try {
      const original = values().find(value => value.id === valueId())?.text ?? '';
      const titles = typedTitles(draft);
      const text = titles.length ? withLinkedTitles(draft, await titleTargets(props.notebook, titles)) : draft;
      const changed = text !== original || !!quote || !!option;
      if (changed) {
        const target = { field: props.field, ownerId: props.row.block.block.id, valueId: valueId() };
        if (option) await createOptionValue(props.notebook, doc, target, option);
        else if (quote) {
          const entry = doc.outline.children(target.ownerId).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === target.field.id);
          const result = target.valueId ? doc.edit({ kind: 'quote', id: target.valueId, text, value: quote })
            : entry ? doc.edit({ kind: 'insert', parentId: entry, after: doc.outline.children(entry).at(-1) ?? null, text, quote })
            : doc.edit({ kind: 'addFieldEntries', parentId: target.ownerId, after: doc.outline.children(target.ownerId).at(-1) ?? null, entries: [{ fieldId: target.field.id, value: text, quote }] });
          if (!result.ok) throw new Error(result.reason);
        } else writeFieldValue(doc, target, text);
        props.onEdited(doc);
      }
      // A committed cell gives undo back to the page before its save can settle.
      finish(focus && !direction);
      if (direction) props.onFill?.(props.field.id, direction);
      if (changed) await doc.flush();
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  function start(id?: string, filling = false) {
    if (busy()) return;
    const value = id ? values().find(value => value.id === id) : values()[0];
    setValueId(value?.id);
    const text = value?.text ?? '';
    if (props.field.kind === 'checkbox') { void write(checkboxValue(text) ? 'no' : 'yes'); return; }
    if (!value && filling) {
      const doc = props.doc;
      if (!doc || doc.status() !== 'ready') { props.onError('The reading is still loading.'); return; }
      try {
        writeFieldValue(doc, { field: props.field, ownerId: props.row.block.block.id }, '');
        const entry = doc.outline.children(props.row.block.block.id).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === props.field.id);
        setValueId(entry ? doc.outline.children(entry).find(id => !doc.isArchived(id)) : undefined);
        props.onEdited(doc);
        void doc.flush().catch(reason => props.onError(String(reason)));
      } catch (reason) { props.onError(String(reason)); return; }
    }
    if (hasValueEditor(props.field, text, props.notebook.todayDate())) setPicker(true);
    else setEditing(text);
  }
  onMount(() => props.onReady?.(() => start(undefined, true)));
  return <div ref={host} class="view-value" data-field-id={props.field.id} data-field-role={props.field.role ?? 'attribute'} tabIndex={0} role="group" aria-label={`Edit ${props.field.name} value`} aria-busy={busy()} onClick={event => {
    if (!(event.target as HTMLElement).closest('.cm-editor,button,.picker')) { event.stopPropagation(); start(); }
  }} onKeyDown={event => {
    if (editing() !== null || picker() || event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); start(); }
  }}>
    <Show when={editing() !== null} fallback={<Show when={values().some(value => value.text.trim())} fallback={<span class="view-value-empty">Add {props.field.name}</span>}><For each={values()}>{value => <button type="button" class="criteria-value" onClick={event => { event.stopPropagation(); start(value.id); }}><BlockText text={value.text} blockId={value.id} notebook={props.notebook} interactive={false} /></button>}</For></Show>}>
      <CriteriaCellEditor id={valueId() ?? props.row.block.block.id} text={editing() ?? ''} label={`Edit ${props.field.name} value`} notebook={props.notebook} onCommit={(text, focus, quote) => void write(text, focus, quote)} onCancel={() => finish()} onTab={props.onFill ? (text, direction, quote) => void write(text, false, quote, direction) : undefined} />
    </Show>
    <Show when={picker()}><ValueEditor anchor={host} field={props.field} text={values().find(value => value.id === valueId())?.text ?? ''} notebook={props.notebook} contextDate={props.notebook.todayDate()} onWrite={text => write(text)} onCreateOption={text => write('', true, undefined, undefined, text)} onError={props.onError} onDismiss={() => finish()} /></Show>
  </div>;
}
