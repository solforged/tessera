import { createMemo, createSignal, Match, Show, Switch } from 'solid-js';
import type { FieldDefinition } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { documentReady } from '../outline/source-fields';
import { fieldEntryId } from '../table/query';
import { DatePicker } from '../tasks/DatePicker';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { InstancePicker } from './InstancePicker';
import { choiceRows } from './value-options';
import type { ChoiceRow } from './value-options';

/** One value write for both outlines and tables. Blank readings keep their block. */
export function writeFieldValue(doc: PageDocument, target: { field: FieldDefinition; ownerId: string; valueId?: string }, text: string) {
  let valueId = target.valueId;
  const entryId = valueId ? undefined : doc.outline.children(target.ownerId).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === target.field.id);
  if (entryId) valueId = doc.outline.children(entryId).find(id => !doc.isArchived(id) && !doc.block(id)?.text.trim());
  // A picker choice is a complete edit, not a keystroke to coalesce with the preceding value.
  const result = valueId ? doc.edit({ kind: 'replaceRange', range: { anchor: { id: valueId, offset: 0 }, head: { id: valueId, offset: doc.block(valueId)?.text.length ?? 0 } }, between: [], mode: 'text', text }, { id: valueId, offset: 0 })
    : entryId ? doc.edit({ kind: 'insert', parentId: entryId, after: doc.outline.children(entryId).at(-1) ?? null, text })
    : doc.edit({ kind: 'addFieldEntries', parentId: target.ownerId, after: doc.outline.children(target.ownerId).at(-1) ?? null, entries: [{ fieldId: target.field.id, value: text }] });
  if (!result.ok) throw new Error(result.reason);
  return result;
}

export function ValueEditor(props: {
  anchor: PopupAnchor; field: FieldDefinition; text: string; notebook: NotebookClient; contextDate: string;
  onWrite(text: string): void | Promise<void>; onDismiss(): void; onError(message: string): void;
}) {
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const rows = createMemo(() => choiceRows(props.field.options, query()));
  const current = () => /^\[\[([^\]]+)\]\]$/.exec(props.text.trim())?.[1];
  async function choose(row: ChoiceRow) {
    if (busy()) return;
    setBusy(true);
    try {
      let text = '';
      if (row.kind === 'option') text = `[[${row.option.id}]]`;
      else if (row.kind === 'create') {
        const definition = await props.notebook.api.block(props.field.id);
        const doc = props.notebook.open(definition.page_id);
        try {
          await documentReady(doc);
          const existing = doc.outline.children(props.field.id).find(id => !doc.isArchived(id) && doc.block(id)?.text.toLowerCase() === row.text.toLowerCase());
          let id = existing;
          if (!id) {
            const result = doc.edit({ kind: 'insert', parentId: props.field.id, after: doc.outline.children(props.field.id).at(-1) ?? null, text: row.text });
            if (!result.ok) throw new Error(result.reason);
            id = result.created[0]!;
          }
          // The reference must not be sent before its option exists on the service.
          await doc.flush();
          text = `[[${id}]]`;
        } finally { doc.release(); }
      }
      await props.onWrite(text);
      props.onDismiss();
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <Switch>
    <Match when={props.field.kind === 'choice'}><Picker<ChoiceRow> anchor={props.anchor} label={`${props.field.name} options`} query={query()} onQuery={setQuery} placeholder="Find an option"
      items={rows()} initial={Math.max(0, rows().findIndex(row => row.kind === 'option' && row.option.id === current()))}
      key={row => row.kind === 'option' ? row.option.id : row.kind} disabledReason={() => busy() ? 'Saving…' : undefined}
      onPick={row => void choose(row)} onDismiss={props.onDismiss} empty="No matching options."
      row={row => row.kind === 'option' ? <><Icon name={row.option.id === current() ? 'check' : 'bullet'} /><span class="picker-text">{row.option.text}</span><Show when={row.option.id === current()}><span class="picker-meta">Current</span></Show></>
        : row.kind === 'create' ? <><Icon name="plus" /><span class="picker-text">Create option “{row.text}”</span></> : <><Icon name="close" /><span class="picker-text">Clear</span></>} /></Match>
    <Match when={props.field.kind === 'instance'}><InstancePicker anchor={props.anchor} field={props.field} notebook={props.notebook} current={current()}
      onPick={async page => { await props.onWrite(`[[${page.id}]]`); props.onDismiss(); }} onDismiss={props.onDismiss} onError={props.onError} /></Match>
    <Match when={props.field.kind === 'date'}><DatePicker notebook={props.notebook} anchor={props.anchor} label={props.field.name} value={props.text || null} partialDates contextDate={props.contextDate}
      onSelect={value => props.onWrite(value.date ?? '')} onDismiss={props.onDismiss} /></Match>
  </Switch>;
}
