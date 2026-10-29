import { createMemo, createSignal, Match, Show, Switch } from 'solid-js';
import type { FieldDefinition } from '../api/types';
import type { Edit, EditResult, NotebookClient, PageDocument, RelationPickIntent } from '../document/contract';
import { fieldEntryId } from '../table/query';
import { DatePicker } from '../tasks/DatePicker';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { RelationPicker } from './RelationPicker';
import { choiceRows } from './value-options';
import type { ChoiceRow } from './value-options';
import { fieldLabel, partialDatePlaceholder } from './kinds';

/** Plain table values retain multiline input, native input modes and Enter/blur commit behavior. */
export function PlainValueInput(props: {
  field?: FieldDefinition; text: string; class?: string;
  onInput(text: string): void; onCommit(returnFocus: boolean): void; onCancel(): void;
  /** Tab and Shift+Tab: the caller commits and moves to the neighboring cell. Without it Tab keeps its browser meaning. */
  onAdvance?(backward: boolean): void;
}) {
  const placeholders = { date: partialDatePlaceholder, url: 'https://', identifier: 'ISBN, DOI or arXiv ID' };
  return <textarea class={`input ${props.class ?? ''}`} data-value-editor aria-label={`Edit ${props.field ? fieldLabel(props.field) : 'field'} value`}
    placeholder={props.field && props.field.kind in placeholders ? placeholders[props.field.kind as keyof typeof placeholders] : undefined}
    inputmode={props.field?.kind === 'number' ? 'decimal' : props.field?.kind === 'url' ? 'url' : undefined}
    rows={Math.min(8, Math.max(1, (props.text.match(/\n/g)?.length ?? 0) + 1))} value={props.text}
    ref={input => queueMicrotask(() => { input.focus({ preventScroll: true }); input.select(); })}
    onInput={event => props.onInput(event.currentTarget.value)} onKeyDown={event => {
      if (event.isComposing) return;
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); props.onCommit(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onCancel(); }
      else if (event.key === 'Tab' && props.onAdvance && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); event.stopPropagation(); props.onAdvance(event.shiftKey); }
    }} onBlur={() => props.onCommit(false)} />;
}

/** One value write for both outlines and tables. Blank readings keep their block. */
export function writeFieldValue(doc: PageDocument, target: { field: FieldDefinition; ownerId: string; valueId?: string; after?: string | null }, text: string, edit?: PageDocument['edit'], relationPick?: RelationPickIntent): Extract<EditResult, { ok: true }> {
  if (relationPick && !edit) {
    const accepted = doc.beginTextCommit(write => writeFieldValue(doc, target, text, write, relationPick));
    accepted.finish();
    if (!accepted.result.ok) throw new Error(accepted.result.reason);
    return accepted.result;
  }
  let valueId = target.valueId;
  const entryId = valueId ? undefined : doc.outline.children(target.ownerId).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === target.field.id);
  if (entryId) valueId = doc.outline.children(entryId).find(id => !doc.isArchived(id) && !doc.block(id)?.text.trim());
  // A picker choice is a complete edit, not a keystroke to coalesce with the preceding value.
  const change: Edit = valueId && relationPick ? { kind: 'text', id: valueId, text, relationPick }
    : valueId ? { kind: 'replaceRange', range: { anchor: { id: valueId, offset: 0 }, head: { id: valueId, offset: doc.block(valueId)?.text.length ?? 0 } }, between: [], mode: 'text', text }
    : entryId ? { kind: 'insert', parentId: entryId, after: doc.outline.children(entryId).at(-1) ?? null, text }
    : { kind: 'addFieldEntries', parentId: target.ownerId, after: target.after === undefined ? doc.outline.children(target.ownerId).at(-1) ?? null : target.after, entries: [{ fieldId: target.field.id, value: text }] };
  const before = valueId ? { id: valueId, offset: 0 } : undefined;
  const result = edit ? edit(change, before) : doc.edit(change, before);
  if (!result.ok) throw new Error(result.reason);
  if (relationPick && !valueId) {
    const id = result.caret?.id;
    if (!id) throw new Error('The accepted relation value could not be found.');
    const accepted = edit!({ kind: 'text', id, text, relationPick });
    if (!accepted.ok) throw new Error(accepted.reason);
  }
  return result;
}

export function ValueEditor(props: {
  anchor: PopupAnchor; field: FieldDefinition; text: string; notebook: NotebookClient; contextDate: string;
  /** The block that owns the value, so a relation picker can lead with its page and leave it out. */
  owner?: { id: string; page: string };
  onWrite(text: string, relationPick?: RelationPickIntent): void | Promise<void>; onDismiss(): void; onError(message: string): void;
  onCreateOption(text: string): Promise<void>;
  onAdvance?(backward: boolean): void;
}) {
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const rows = createMemo(() => choiceRows(props.field.options, query()));
  const current = createMemo(() => fieldEntryId(props.text) ?? (props.field.kind === 'choice' ? props.field.options.find(option => option.text.trim().toLowerCase() === props.text.trim().toLowerCase())?.id : undefined));
  async function choose(row: ChoiceRow) {
    if (busy()) return;
    setBusy(true);
    try {
      let text = '';
      if (row.kind === 'option') text = `[[${row.option.id}]]`;
      else if (row.kind === 'create') {
        await props.onCreateOption(row.text);
        props.onDismiss();
        return;
      }
      await props.onWrite(text);
      props.onDismiss();
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <Switch>
    <Match when={props.field.kind === 'choice'}><Picker<ChoiceRow> anchor={props.anchor} label={`${fieldLabel(props.field)} options`} query={query()} onQuery={setQuery} placeholder="Find an option"
      items={rows()} initial={Math.max(0, rows().findIndex(row => row.kind === 'option' && row.option.id === current()))}
      isCurrent={row => row.kind === 'option' && row.option.id === current()}
      key={row => row.kind === 'option' ? row.option.id : row.kind} disabledReason={() => busy() ? 'Saving…' : undefined}
      onPick={row => void choose(row)} onDismiss={props.onDismiss} empty="No matching options."
      row={row => row.kind === 'option' ? <><Icon name={row.option.id === current() ? 'check' : 'bullet'} /><span class="picker-text">{row.option.text}</span><Show when={row.option.id === current()}><span class="picker-meta">Current</span></Show></>
        : row.kind === 'create' ? <><Icon name="plus" /><span class="picker-text">Add option “{row.text}”</span></> : <><Icon name="close" /><span class="picker-text">Clear</span></>} /></Match>
    <Match when={props.field.kind === 'instance'}><RelationPicker anchor={props.anchor} field={props.field} notebook={props.notebook} current={current()} owner={props.owner}
      onPick={async intent => { await props.onWrite(`[[${intent.targetId ?? intent.query.trim()}]]`, intent); props.onDismiss(); }} onDismiss={props.onDismiss} onError={props.onError} /></Match>
    <Match when={props.field.kind === 'date'}><DatePicker notebook={props.notebook} anchor={props.anchor} label={fieldLabel(props.field)} value={props.text || null} partialDates contextDate={props.contextDate}
      onSelect={value => props.onWrite(value.date ?? '')} onDismiss={props.onDismiss} onAdvance={props.onAdvance} /></Match>
  </Switch>;
}
