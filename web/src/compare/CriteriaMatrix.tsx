import { For, Match, Show, Switch, createMemo, createSignal } from 'solid-js';
import type { FieldDefinition, PositionQuestion, PositionRow, QuoteState } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { besideHint, opensBeside } from '../shell/beside';
import { BlockText } from '../outline/BlockText';
import { fieldEntryId } from '../table/query';
import { Button } from '../ui/Button';
import { exactRepeats, linkedCriteriaDraft } from './criteria';
import { CriteriaCellEditor } from './CriteriaCellEditor';
import { quoteTarget } from '../document/text-tokens';
import { Quote, createQuoteStatus } from '../outline/Quote';
import { ValueEditor, writeFieldValue } from '../fields/value-editor';
import { hasValueEditor } from '../fields/value-options';
import { checkboxValue } from '../fields/kinds';
import { createOptionValue } from '../fields/commands';

interface CriterionValue { id: string; text: string }

export function CriteriaMatrix(props: {
  rows: PositionRow[]; allRows: PositionRow[]; criteria: string[]; questions: PositionQuestion[]; notebook: NotebookClient;
  docs: Map<string, PageDocument>; field(id: string): FieldDefinition | undefined;
  focusedCriterion: string | null; onFocusQuestion?(id: string): void; orientation?: 'criteria' | 'holders';
  holder(row: PositionRow): string; siglum(row: PositionRow): string; work(row: PositionRow): string;
  onOpen(target: OpenTarget, beside: boolean): void; onEdited(doc: PageDocument): void;
}) {
  const [editing, setEditing] = createSignal<{ position: string; field: string; value: string | null; text: string } | null>(null);
  const [error, setError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const rowById = createMemo(() => new Map(props.rows.map(row => [row.block.block.id, row])));
  const fieldName = (id: string) => props.field(id)?.name;
  const rowIds = createMemo(() => [...rowById().keys()]);
  const quoteStatuses = createMemo(() => new Map([...props.docs].map(([id, doc]) => [id, createQuoteStatus(doc, props.notebook)])));
  const cells = createMemo(() => new Map(props.rows.map(row => {
    const doc = props.docs.get(row.block.page.id);
    doc?.outline.version(); doc?.archivedVersion();
    return [row.block.block.id, new Map(props.criteria.map(field => {
      // The joined response supplies values until its page is ready. Then use the optimistic document.
      const entries = doc?.status() === 'ready' ? doc.outline.children(row.block.block.id).filter(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === field) : null;
      const values = entries ? entries.flatMap(entry => doc!.outline.children(entry).filter(id => !doc!.isArchived(id)).map(id => ({ id, text: doc!.block(id)?.text ?? '' }))) : row.fields.filter(entry => entry.field_id === field).flatMap(entry => entry.values);
      return [field, values] as const;
    }))] as const;
  })));
  const repeats = createMemo(() => exactRepeats(props.criteria, props.rows.map(row => row.block.block.id), (id, field) => cells().get(id)?.get(field)?.map(value => value.text).join('\n') ?? ''));
  function finishEditing(cell?: HTMLElement) {
    setEditing(null);
    if (cell) queueMicrotask(() => { if (cell.isConnected) cell.focus({ preventScroll: true }); });
  }
  async function commit(textDraft: string, cell?: HTMLElement, quote?: QuoteState, option?: string) {
    const current = editing();
    if (!current || saving()) return;
    const row = props.rows.find(row => row.block.block.id === current.position);
    const doc = row && props.docs.get(row.block.page.id);
    const field = props.field(current.field);
    if (!doc || doc.status() !== 'ready') { setError('The perspective is still loading.'); return; }
    if (!field) { setError('The criterion is still loading.'); return; }
    if (!current.value && !textDraft.trim() && !option) { finishEditing(cell); return; }
    current.text = textDraft;
    setSaving(true);
    try {
      const text = option ? '' : await linkedCriteriaDraft(props.notebook, textDraft, () => current.text);
      if (editing() !== current) return;
      if (quote && quoteTarget(text) !== quote.target_id) quote = undefined;
      if (!option && current.value && doc.block(current.value)?.text === text && !quote) { finishEditing(cell); return; }
      if (option) await createOptionValue(props.notebook, doc, { field, ownerId: current.position, valueId: current.value ?? undefined }, option);
      else if (quote) {
        const entry = doc.outline.children(current.position).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === current.field);
        const result = doc.edit(current.value ? { kind: 'quote', id: current.value, text, value: quote }
          : entry ? { kind: 'insert', parentId: entry, after: doc.outline.children(entry).at(-1) ?? null, text, quote }
          : { kind: 'addFieldEntries', parentId: current.position, after: doc.outline.children(current.position).at(-1) ?? null, entries: [{ fieldId: current.field, value: text, quote }] });
        if (!result.ok) throw new Error(result.reason);
      } else writeFieldValue(doc, { field, ownerId: current.position, valueId: current.value ?? undefined }, text);
      finishEditing(cell); setError(''); props.onEdited(doc);
      await doc.flush();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  function start(row: PositionRow, field: string, value: { id: string; text: string } | undefined, cell?: HTMLElement) {
    if (saving()) return;
    const definition = props.field(field);
    if (!definition) { setError('The criterion is still loading.'); return; }
    setEditing({ position: row.block.block.id, field, value: value?.id ?? null, text: value?.text ?? '' });
    if (definition.kind === 'checkbox') void commit(checkboxValue(value?.text ?? '') ? 'no' : 'yes', cell);
  }
  function CellValue(valueProps: { value: CriterionValue; position: string; field: string; editable?: boolean }) {
    let valueHost!: HTMLDivElement;
    const row = () => rowById().get(valueProps.position)!;
    const doc = () => props.docs.get(row().block.page.id);
    const target = createMemo(() => quoteTarget(valueProps.value.text));
    return <Show when={target() && doc()?.status() === 'ready'} fallback={<Show when={valueProps.editable}
      fallback={<div class="criteria-value"><BlockText text={valueProps.value.text} notebook={props.notebook} interactive={false} /></div>}>
      <button type="button" class="criteria-value" role={props.field(valueProps.field)?.kind === 'checkbox' ? 'checkbox' : undefined} aria-checked={props.field(valueProps.field)?.kind === 'checkbox' ? checkboxValue(valueProps.value.text) ?? false : undefined} onClick={event => start(row(), valueProps.field, valueProps.value, event.currentTarget.closest<HTMLElement>('.criteria-cell') ?? undefined)}><Show when={props.field(valueProps.field)?.kind === 'checkbox'} fallback={<BlockText text={valueProps.value.text} notebook={props.notebook} interactive={false} />}>{checkboxValue(valueProps.value.text) ? '☑' : '☐'}</Show></button>
    </Show>}>
      <div ref={valueHost} class="criteria-value" onClick={event => {
        if (valueProps.editable && !(event.target as HTMLElement).closest('button,.outline-reference')) { event.stopPropagation(); start(row(), valueProps.field, valueProps.value, valueHost.closest<HTMLElement>('.criteria-cell') ?? undefined); }
      }}><Quote id={valueProps.value.id} target={target()!} doc={doc()!} notebook={props.notebook} status={quoteStatuses().get(row().block.page.id)?.().get(valueProps.value.id)} onOpen={props.onOpen} onEdited={doc => {
        props.onEdited(doc);
        queueMicrotask(() => valueHost.closest<HTMLElement>('.criteria-cell')?.focus({ preventScroll: true }));
      }} /></div>
    </Show>;
  }
  function HolderHeader(headerProps: { id: string }) {
    return <><span class="compare-siglum">{props.siglum(rowById().get(headerProps.id)!)}</span>
      <Button class="compare-holder-name" title={`Open this perspective · ${besideHint}`} onClick={event => props.onOpen({ kind: 'page', pageId: rowById().get(headerProps.id)!.block.page.id, blockId: headerProps.id }, opensBeside(event))}>{props.holder(rowById().get(headerProps.id)!)}</Button>
      <div class="compare-work"><BlockText text={props.work(rowById().get(headerProps.id)!)} notebook={props.notebook} onOpen={props.onOpen} /></div></>;
  }
  function MatrixCell(cellProps: { id: string; field: string }) {
    let cell!: HTMLDivElement;
    const values = () => cells().get(cellProps.id)?.get(cellProps.field) ?? [];
    const current = () => editing()?.position === cellProps.id && editing()?.field === cellProps.field ? editing() : null;
    const repeat = () => repeats().find(repeat => repeat.criterion === cellProps.field && repeat.positions.includes(cellProps.id));
    const field = () => props.field(cellProps.field);
    return <td data-criterion={fieldName(cellProps.field)}><div ref={cell} class="criteria-cell" data-position-id={cellProps.id} data-field-id={cellProps.field} tabIndex={0} role="group" aria-label={`${fieldName(cellProps.field)} · ${props.holder(rowById().get(cellProps.id)!)}`} onClick={event => { if (!(event.target as HTMLElement).closest('.cm-editor,button')) start(rowById().get(cellProps.id)!, cellProps.field, values()[0], cell); }} onKeyDown={event => { if (!current() && (event.key === 'Enter' || event.key === ' ' && field()?.kind === 'checkbox')) { event.preventDefault(); event.stopPropagation(); start(rowById().get(cellProps.id)!, cellProps.field, values()[0], cell); } }}>
      <Show when={current()} fallback={<Show when={values().some(value => value.text.trim())} fallback={<Button class="criteria-add" onClick={() => start(rowById().get(cellProps.id)!, cellProps.field, values()[0], cell)}>Add</Button>}>
        <For each={values()}>{value => <CellValue value={value} position={cellProps.id} field={cellProps.field} editable />}</For>
      </Show>}>{edit => <>
        <For each={values().filter(value => value.id !== edit().value)}>{value => <CellValue value={value} position={cellProps.id} field={cellProps.field} />}</For>
        <Switch>
          <Match when={field()?.kind === 'checkbox'}><span class="criteria-hint" role="status">Saving…</span></Match>
          <Match when={hasValueEditor(field(), edit().text, props.notebook.todayDate())}><ValueEditor anchor={cell} field={field()!} text={edit().text} notebook={props.notebook} contextDate={props.notebook.todayDate()} onWrite={text => commit(text, cell)} onCreateOption={text => commit('', cell, undefined, text)} onError={setError} onDismiss={() => finishEditing(cell)} /></Match>
          <Match when={true}><CriteriaCellEditor id={edit().value ?? edit().position} text={edit().text} label={`Edit ${fieldName(cellProps.field)} · ${props.holder(rowById().get(cellProps.id)!)}`} notebook={props.notebook} onChange={text => { edit().text = text; }} onCommit={(text, restoreFocus, quote) => void commit(text, restoreFocus ? cell : undefined, quote)} onCancel={() => finishEditing(cell)} /></Match>
        </Switch>
      </>}</Show>
    </div><Show when={repeat()}>{mark => <span class="criteria-exact">≡ {mark().number} · exact repeat</span>}</Show></td>;
  }
  return <>
    <Show when={error()}><p class="pane-error" role="alert">{error()}</p></Show>
    <Show when={props.rows.length && props.criteria.length} fallback={<p class="view-empty">{props.rows.length ? 'This subject has no criteria. Open Edit criteria to add them.' : 'No perspectives match this view. Clear its filters to include more.'}</p>}>
    <div class="criteria-overflow"><table class="criteria-matrix" classList={{ 'criteria-holders': props.orientation === 'holders' }} style={{ '--holder-count': props.orientation === 'holders' ? props.criteria.length : props.rows.length }}>
      <Show when={props.orientation === 'holders'} fallback={<>
        <colgroup><col class="criteria-name-column" /><For each={props.rows}>{() => <col />}</For></colgroup>
        <thead><tr><th scope="col">Criterion</th><For each={rowIds()}>{id => <th scope="col"><HolderHeader id={id} /></th>}</For></tr></thead>
        <tbody><For each={props.criteria}>{field => <>
          <tr class="criteria-values" classList={{ 'criteria-focused': props.focusedCriterion === field }}><th scope="row">{fieldName(field)}<Show when={props.focusedCriterion === field}><span class="criteria-focus-mark">Focused criterion</span></Show></th><For each={rowIds()}>{id => <MatrixCell id={id} field={field} />}</For></tr>
          <For each={props.questions.filter(question => question.criterion === field)}>{question => <tr class="criteria-question"><td colSpan={props.rows.length + 1}><div>
            <span class="criteria-question-mark">?</span><Button class="criteria-question-text" onClick={() => props.onFocusQuestion?.(question.block.block.id)}><BlockText text={question.block.block.text} notebook={props.notebook} interactive={false} /></Button>
            <span class="criteria-scope">{fieldName(field)} · {question.holders.length ? `${question.holders.map(id => { const row = props.allRows.find(row => row.holder_id === id); return row ? props.siglum(row) : props.notebook.lookup(id)()?.text ?? id; }).join(' ↔ ')} only` : `all ${props.allRows.length}`}</span>
            <Button onClick={event => props.onOpen({ kind: 'page', pageId: question.block.page.id, blockId: question.block.block.id }, opensBeside(event))}>Open original</Button>
          </div></td></tr>}</For>
        </>}</For></tbody>
      </>}>
        <colgroup><col class="criteria-holder-column" /><For each={props.criteria}>{() => <col />}</For></colgroup>
        <thead><tr><th scope="col">Holder</th><For each={props.criteria}>{field => <th scope="col">{fieldName(field)}</th>}</For></tr></thead>
        <tbody><For each={rowIds()}>{id => <tr class="criteria-values" data-position-id={id}><th scope="row"><HolderHeader id={id} /></th><For each={props.criteria}>{field => <MatrixCell id={id} field={field} />}</For></tr>}</For></tbody>
      </Show>
    </table></div></Show>
    <footer class="criteria-footnotes"><div><For each={repeats()}>{repeat => <p>≡ {repeat.number}　Identical authored value: "<BlockText text={repeat.text} notebook={props.notebook} interactive={false} />" · {repeat.positions.map(id => props.siglum(props.rows.find(row => row.block.block.id === id)!)).join(', ')}</p>}</For></div><span class="criteria-hint">Enter to edit · {besideHint}</span></footer>
  </>;
}
