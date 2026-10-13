import { For, Show, createMemo, createSignal } from 'solid-js';
import type { PositionQuestion, PositionRow, QuoteState } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { BlockText } from '../outline/BlockText';
import { fieldEntryId } from '../table/query';
import { Button } from '../ui/Button';
import { exactRepeats } from './criteria';
import { titleTargets, typedTitles, withLinkedTitles } from '../outline/link-titles';
import { CriteriaCellEditor } from './CriteriaCellEditor';
import { quoteTarget } from '../document/text-tokens';
import { Quote, createQuoteStatus } from '../outline/Quote';

interface CriterionValue { id: string; text: string }

export function CriteriaMatrix(props: {
  rows: PositionRow[]; allRows: PositionRow[]; criteria: string[]; questions: PositionQuestion[]; notebook: NotebookClient;
  docs: Map<string, PageDocument>; fieldName(id: string): string | undefined;
  focusedCriterion: string | null; onFocusQuestion(id: string): void;
  holder(row: PositionRow): string; siglum(row: PositionRow): string; work(row: PositionRow): string;
  onOpen(target: OpenTarget, beside: boolean): void; onEdited(doc: PageDocument): void;
}) {
  const [editing, setEditing] = createSignal<{ position: string; field: string; value: string | null; text: string } | null>(null);
  const [error, setError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const rowById = createMemo(() => new Map(props.rows.map(row => [row.block.block.id, row])));
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
  async function commit(textDraft: string, cell?: HTMLElement, quote?: QuoteState) {
    const current = editing();
    if (!current || saving()) return;
    const row = props.rows.find(row => row.block.block.id === current.position);
    const doc = row && props.docs.get(row.block.page.id);
    if (!doc || doc.status() !== 'ready') { setError('The position is still loading.'); return; }
    if (!current.value && !textDraft.trim()) { finishEditing(cell); return; }
    setSaving(true);
    let text: string;
    try { text = withLinkedTitles(textDraft, await titleTargets(props.notebook, typedTitles(textDraft))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setSaving(false); return; }
    if (editing() !== current) { setSaving(false); return; }
    if (current.value && doc.block(current.value)?.text === text && !quote) { finishEditing(cell); setSaving(false); return; }
    const entry = doc.outline.children(current.position).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === current.field);
    const result = doc.edit(current.value ? quote ? { kind: 'quote', id: current.value, text, value: quote } : { kind: 'text', id: current.value, text }
      : entry ? { kind: 'insert', parentId: entry, after: doc.outline.children(entry).at(-1) ?? null, text, quote }
      : { kind: 'addFieldEntries', parentId: current.position, after: doc.outline.children(current.position).at(-1) ?? null, entries: [{ fieldId: current.field, value: text, quote }] });
    if (!result.ok) { setError(result.reason); setSaving(false); return; }
    finishEditing(cell); setError(''); props.onEdited(doc);
    try { await doc.flush(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); }
  }
  function start(row: PositionRow, field: string, value: { id: string; text: string } | undefined) {
    setEditing({ position: row.block.block.id, field, value: value?.id ?? null, text: value?.text ?? '' });
  }
  function CellValue(valueProps: { value: CriterionValue; position: string; field: string; editable?: boolean }) {
    let valueHost!: HTMLDivElement;
    const row = () => rowById().get(valueProps.position)!;
    const doc = () => props.docs.get(row().block.page.id);
    const target = createMemo(() => quoteTarget(valueProps.value.text));
    return <Show when={target() && doc()?.status() === 'ready'} fallback={<Show when={valueProps.editable}
      fallback={<div class="criteria-value"><BlockText text={valueProps.value.text} notebook={props.notebook} interactive={false} /></div>}>
      <button type="button" class="criteria-value" onClick={() => start(row(), valueProps.field, valueProps.value)}><BlockText text={valueProps.value.text} notebook={props.notebook} interactive={false} /></button>
    </Show>}>
      <div ref={valueHost} class="criteria-value" onClick={event => {
        if (valueProps.editable && !(event.target as HTMLElement).closest('button,.outline-reference')) { event.stopPropagation(); start(row(), valueProps.field, valueProps.value); }
      }}><Quote id={valueProps.value.id} target={target()!} doc={doc()!} notebook={props.notebook} status={quoteStatuses().get(row().block.page.id)?.().get(valueProps.value.id)} onOpen={props.onOpen} onEdited={doc => {
        props.onEdited(doc);
        queueMicrotask(() => valueHost.closest<HTMLElement>('.criteria-cell')?.focus({ preventScroll: true }));
      }} /></div>
    </Show>;
  }
  return <>
    <Show when={error()}><p class="pane-error" role="alert">{error()}</p></Show>
    <div class="criteria-overflow"><table class="criteria-matrix" style={{ '--holder-count': props.rows.length }}>
      <colgroup><col class="criteria-name-column" /><For each={props.rows}>{() => <col />}</For></colgroup>
      <thead><tr><th scope="col">Criterion</th><For each={rowIds()}>{id => <th scope="col">
        <span class="compare-siglum">{props.siglum(rowById().get(id)!)}</span>
        <Button class="compare-holder-name" title="Open this reading · Shift to open beside" onClick={event => props.onOpen({ kind: 'page', pageId: rowById().get(id)!.block.page.id, blockId: id }, event.shiftKey)}>{props.holder(rowById().get(id)!)}</Button>
        <div class="compare-work"><BlockText text={props.work(rowById().get(id)!)} notebook={props.notebook} onOpen={props.onOpen} /></div>
      </th>}</For></tr></thead>
      <tbody><For each={props.criteria}>{field => <>
        <tr class="criteria-values" classList={{ 'criteria-focused': props.focusedCriterion === field }}><th scope="row">{props.fieldName(field)}<Show when={props.focusedCriterion === field}><span class="criteria-focus-mark">Focused criterion</span></Show></th><For each={rowIds()}>{id => {
          let cell!: HTMLDivElement;
          const values = () => cells().get(id)?.get(field) ?? [];
          const current = () => editing()?.position === id && editing()?.field === field ? editing() : null;
          const repeat = () => repeats().find(repeat => repeat.criterion === field && repeat.positions.includes(id));
          return <td><div ref={cell} class="criteria-cell" tabIndex={0} role="group" aria-label={`${props.fieldName(field)} · ${props.holder(rowById().get(id)!)}`} onClick={event => { if (!(event.target as HTMLElement).closest('.cm-editor,button')) start(rowById().get(id)!, field, values()[0]); }} onKeyDown={event => { if (event.key === 'Enter' && !current()) { event.preventDefault(); start(rowById().get(id)!, field, values()[0]); } }}>
            <Show when={current()} fallback={<Show when={values().some(value => value.text.trim())} fallback={<Button class="criteria-add" onClick={() => start(rowById().get(id)!, field, values()[0])}>Add</Button>}>
              <For each={values()}>{value => <CellValue value={value} position={id} field={field} editable />}</For>
            </Show>}>{edit => <>
              <For each={values().filter(value => value.id !== edit().value)}>{value => <CellValue value={value} position={id} field={field} />}</For>
              <CriteriaCellEditor id={edit().value ?? edit().position} text={edit().text} label={`Edit ${props.fieldName(field)} · ${props.holder(rowById().get(id)!)}`} notebook={props.notebook} onCommit={(text, restoreFocus, quote) => void commit(text, restoreFocus ? cell : undefined, quote)} onCancel={() => finishEditing(cell)} />
            </>}</Show>
          </div><Show when={repeat()}>{mark => <span class="criteria-exact">≡ {mark().number} · exact repeat</span>}</Show></td>;
        }}</For></tr>
        <For each={props.questions.filter(question => question.criterion === field)}>{question => <tr class="criteria-question"><td colSpan={props.rows.length + 1}><div>
          <span class="criteria-question-mark">?</span><Button class="criteria-question-text" onClick={() => props.onFocusQuestion(question.block.block.id)}><BlockText text={question.block.block.text} notebook={props.notebook} interactive={false} /></Button>
          <span class="criteria-scope">{props.fieldName(field)} · {question.holders.length ? `${question.holders.map(id => { const row = props.allRows.find(row => row.holder_id === id); return row ? props.siglum(row) : props.notebook.lookup(id)()?.text ?? id; }).join(' ↔ ')} only` : `all ${props.allRows.length}`}</span>
          <Button onClick={event => props.onOpen({ kind: 'page', pageId: question.block.page.id, blockId: question.block.block.id }, event.shiftKey)}>Open original</Button>
        </div></td></tr>}</For>
      </>}</For></tbody>
    </table></div>
    <footer class="criteria-footnotes"><div><For each={repeats()}>{repeat => <p>≡ {repeat.number}　Identical authored value: "{repeat.text}" · {repeat.positions.map(id => props.siglum(props.rows.find(row => row.block.block.id === id)!)).join(', ')}</p>}</For></div><span class="criteria-hint">Enter to edit · Shift-open source</span></footer>
  </>;
}
