import { For, Match, Show, Switch, createMemo, createSignal, onCleanup } from 'solid-js';
import type { FieldDefinition, PositionQuestion, PositionRow, QuoteState } from '../api/types';
import type { NotebookClient, PageDocument, PendingTextCommit, RelationPickIntent } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { besideHint, opensBeside } from '../shell/beside';
import { BlockText } from '../outline/BlockText';
import { fieldEntryId } from '../table/query';
import { Button } from '../ui/Button';
import { exactRepeats, linkedCriteriaDraft, nextCriterionCell } from './criteria';
import { CriteriaCellEditor } from './CriteriaCellEditor';
import { quoteTarget } from '../document/text-tokens';
import { Quote, createQuoteStatus } from '../outline/Quote';
import { ValueEditor, writeFieldValue } from '../fields/value-editor';
import { hasValueEditor } from '../fields/value-options';
import { checkboxValue } from '../fields/kinds';
import { createOptionValue } from '../fields/commands';
import { typedTitles } from '../outline/link-titles';

interface CriterionValue { id: string; text: string }
interface CriterionDraft { position: string; field: string; value: string | null; text: string; cancelled?: boolean; durable?: PendingTextCommit }

export function CriteriaMatrix(props: {
  rows: PositionRow[]; allRows: PositionRow[]; criteria: string[]; questions: PositionQuestion[]; notebook: NotebookClient;
  docs: Map<string, PageDocument>; field(id: string): FieldDefinition | undefined;
  focusedCriterion: string | null; onFocusQuestion?(id: string): void; orientation?: 'criteria' | 'holders';
  holder(row: PositionRow): string; siglum(row: PositionRow): string; work(row: PositionRow): string;
  onOpen(target: OpenTarget, beside: boolean): void; onEdited(doc: PageDocument): void;
}) {
  const [editing, setEditing] = createSignal<CriterionDraft | null>(null);
  const [error, setError] = createSignal('');
  const pending = new Set<CriterionDraft>();
  const cellElements = new Map<string, HTMLElement>();
  const rowById = createMemo(() => new Map(props.rows.map(row => [row.block.block.id, row])));
  const questionById = createMemo(() => new Map(props.questions.map(question => [question.block.block.id, question])));
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
  function finishEditing(cell?: HTMLElement, current = editing()) {
    if (editing() !== current) return;
    setEditing(null);
    if (cell) queueMicrotask(() => { if (cell.isConnected) cell.focus({ preventScroll: true }); });
  }
  function cancelEditing(cell: HTMLElement) {
    const current = editing();
    if (current) current.cancelled = true;
    finishEditing(cell, current);
  }
  function advance(current: CriterionDraft, direction: -1 | 1) {
    const next = nextCriterionCell(rowIds(), props.criteria, current, direction, props.orientation);
    if (!next) return null;
    const cell = cellElements.get(`${next.position}:${next.field}`);
    if (!cell) return null;
    start(rowById().get(next.position)!, next.field, cells().get(next.position)?.get(next.field)?.[0], cell, false);
    return next;
  }
  async function commit(textDraft: string, cell?: HTMLElement, quote?: QuoteState, option?: string, direction?: -1 | 1, relationPick?: RelationPickIntent) {
    const current = editing();
    if (!current) return;
    const row = props.rows.find(row => row.block.block.id === current.position);
    const doc = row && props.docs.get(row.block.page.id);
    const field = props.field(current.field);
    if (!doc || doc.status() !== 'ready') { setError('The perspective is still loading.'); return; }
    if (!field) { setError('The criterion is still loading.'); return; }
    current.text = textDraft;
    // Transfer the keyboard before awaiting names or persistence; each operation owns its source draft.
    if (direction && !advance(current, direction)) return;
    if (pending.has(current)) return;
    if (!current.value && !textDraft.trim() && !option) { finishEditing(cell, current); return; }
    pending.add(current);
    try {
      if (relationPick) {
        writeFieldValue(doc, { field, ownerId: current.position, valueId: current.value ?? undefined }, textDraft, undefined, relationPick);
        finishEditing(cell, current); setError(''); props.onEdited(doc);
        await doc.flush();
        return;
      }
      if (!option && typedTitles(textDraft).length) {
        current.durable = doc.beginTextCommit(write => writeFieldValue(doc, { field, ownerId: current.position, valueId: current.value ?? undefined }, textDraft, write));
        if (current.durable.result.ok) current.value = current.durable.result.caret?.id ?? current.value;
        props.onEdited(doc);
      }
      const text = option ? '' : await linkedCriteriaDraft(props.notebook, textDraft, () => current.text);
      if (current.cancelled) return;
      if (quote && quoteTarget(text) !== quote.target_id) quote = undefined;
      if (!option && current.value && doc.block(current.value)?.text === text && !quote) { finishEditing(cell, current); return; }
      if (option) await createOptionValue(props.notebook, doc, { field, ownerId: current.position, valueId: current.value ?? undefined }, option);
      else if (quote) {
        const entry = doc.outline.children(current.position).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === current.field);
        const result = doc.edit(current.value ? { kind: 'quote', id: current.value, text, value: quote }
          : entry ? { kind: 'insert', parentId: entry, after: doc.outline.children(entry).at(-1) ?? null, text, quote }
          : { kind: 'addFieldEntries', parentId: current.position, after: doc.outline.children(current.position).at(-1) ?? null, entries: [{ fieldId: current.field, value: text, quote }] });
        if (!result.ok) throw new Error(result.reason);
      } else if (current.durable) {
        const result = current.durable.replace(text);
        if (!result.ok) throw new Error(result.reason);
      } else writeFieldValue(doc, { field, ownerId: current.position, valueId: current.value ?? undefined }, text);
      pending.delete(current);
      finishEditing(cell, current); setError(''); props.onEdited(doc);
      await doc.flush();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { current.durable?.finish(); current.durable = undefined; pending.delete(current); }
  }
  function start(row: PositionRow, field: string, value: { id: string; text: string } | undefined, cell?: HTMLElement, activate = true) {
    const definition = props.field(field);
    if (!definition) { setError('The criterion is still loading.'); return; }
    if (!activate && definition.kind === 'checkbox') {
      setEditing(null); cell?.focus({ preventScroll: true }); return;
    }
    const position = row.block.block.id;
    let draft: CriterionDraft | undefined;
    for (const candidate of pending) if (!candidate.cancelled && candidate.position === position && candidate.field === field) { draft = candidate; break; }
    setEditing(draft ?? { position, field, value: value?.id ?? null, text: value?.text ?? '' });
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
    const key = `${cellProps.id}:${cellProps.field}`;
    onCleanup(() => cellElements.delete(key));
    const values = () => cells().get(cellProps.id)?.get(cellProps.field) ?? [];
    const current = () => editing()?.position === cellProps.id && editing()?.field === cellProps.field ? editing() : null;
    const repeat = () => repeats().find(repeat => repeat.criterion === cellProps.field && repeat.positions.includes(cellProps.id));
    const field = () => props.field(cellProps.field);
    return <td data-criterion={fieldName(cellProps.field)}><div ref={element => { cell = element; cellElements.set(key, element); }} class="criteria-cell" data-position-id={cellProps.id} data-field-id={cellProps.field} tabIndex={0} role="group" aria-label={`${fieldName(cellProps.field)} · ${props.holder(rowById().get(cellProps.id)!)}`} onClick={event => { if (!(event.target as HTMLElement).closest('.cm-editor,button')) start(rowById().get(cellProps.id)!, cellProps.field, values()[0], cell); }} onKeyDown={event => { if (!current() && event.key === 'Tab' && event.target === cell) { event.preventDefault(); event.stopPropagation(); advance({ position: cellProps.id, field: cellProps.field, value: null, text: '' }, event.shiftKey ? -1 : 1); } else if (!current() && (event.key === 'Enter' || event.key === ' ' && field()?.kind === 'checkbox')) { event.preventDefault(); event.stopPropagation(); start(rowById().get(cellProps.id)!, cellProps.field, values()[0], cell); } }}>
      <Show when={current()} fallback={<Show when={values().some(value => value.text.trim())} fallback={<Button class="criteria-add" onClick={() => start(rowById().get(cellProps.id)!, cellProps.field, values()[0], cell)}>Add</Button>}>
        <For each={values()}>{value => <CellValue value={value} position={cellProps.id} field={cellProps.field} editable />}</For>
      </Show>}>{edit => <>
        <For each={values().filter(value => value.id !== edit().value)}>{value => <CellValue value={value} position={cellProps.id} field={cellProps.field} />}</For>
        <Switch>
          <Match when={field()?.kind === 'checkbox'}><span class="criteria-hint" role="status">Saving…</span></Match>
          <Match when={hasValueEditor(field(), edit().text, props.notebook.todayDate())}><ValueEditor anchor={cell} field={field()!} text={edit().text} notebook={props.notebook} contextDate={props.notebook.todayDate()} onWrite={(text, relationPick) => commit(text, cell, undefined, undefined, undefined, relationPick)} onCreateOption={text => commit('', cell, undefined, text)} onError={setError} onDismiss={() => { /* A pick commits and clears the draft before the popup asks to close; `edit()` throws once the Show has gone falsy. */ const draft = current(); if (draft) finishEditing(cell, draft); }} /></Match>
          <Match when={true}><CriteriaCellEditor id={edit().value ?? edit().position} text={edit().text} label={`Edit ${fieldName(cellProps.field)} · ${props.holder(rowById().get(cellProps.id)!)}`} notebook={props.notebook} onChange={text => {
            const current = edit(); current.text = text;
            const result = current.durable?.replace(text);
            if (result && !result.ok) setError(result.reason);
          }} onCommit={(text, restoreFocus, quote) => void commit(text, restoreFocus ? cell : undefined, quote)} onTab={(text, direction, quote) => void commit(text, undefined, quote, undefined, direction)} onCancel={() => cancelEditing(cell)} /></Match>
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
          <For each={props.questions.filter(question => question.criterion === field).map(question => question.block.block.id)}>{id => {
            const question = () => questionById().get(id)!;
            return <tr class="criteria-question"><td colSpan={props.rows.length + 1}><div>
              <span class="criteria-question-mark">?</span><Button class="criteria-question-text" onClick={() => props.onFocusQuestion?.(id)}><BlockText text={question().block.block.text} notebook={props.notebook} interactive={false} /></Button>
              <span class="criteria-scope">{fieldName(field)} · {question().holders.length ? `${question().holders.map(id => { const row = props.allRows.find(row => row.holder_id === id); return row ? props.siglum(row) : props.notebook.lookup(id)()?.text ?? id; }).join(' ↔ ')} only` : `all ${props.allRows.length}`}</span>
              <Button onClick={event => props.onOpen({ kind: 'page', pageId: question().block.page.id, blockId: id }, opensBeside(event))}>Open original</Button>
            </div></td></tr>;
          }}</For>
        </>}</For></tbody>
      </>}>
        <colgroup><col class="criteria-holder-column" /><For each={props.criteria}>{() => <col />}</For></colgroup>
        <thead><tr><th scope="col">Holder</th><For each={props.criteria}>{field => <th scope="col">{fieldName(field)}</th>}</For></tr></thead>
        <tbody><For each={rowIds()}>{id => <tr class="criteria-values" data-position-id={id}><th scope="row"><HolderHeader id={id} /></th><For each={props.criteria}>{field => <MatrixCell id={id} field={field} />}</For></tr>}</For></tbody>
      </Show>
    </table></div></Show>
    <footer class="criteria-footnotes"><div><For each={repeats()}>{repeat => <p>≡ {repeat.number}　Identical authored value: "<BlockText text={repeat.text} notebook={props.notebook} interactive={false} />" · {repeat.positions.map(id => props.siglum(props.rows.find(row => row.block.block.id === id)!)).join(', ')}</p>}</For></div><span class="criteria-hint">Enter to edit · Tab to next cell · {besideHint}</span></footer>
  </>;
}
