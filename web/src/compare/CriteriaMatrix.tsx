import { For, Show, createMemo, createSignal } from 'solid-js';
import type { PositionQuestion, PositionRow } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { BlockText } from '../outline/BlockText';
import { fieldEntryId } from '../table/query';
import { Button } from '../ui/Button';
import { exactRepeats } from './criteria';
import { titleTargets, typedTitles, withLinkedTitles } from '../outline/link-titles';

export function CriteriaMatrix(props: {
  rows: PositionRow[]; allRows: PositionRow[]; criteria: string[]; questions: PositionQuestion[]; notebook: NotebookClient;
  docs: Map<string, PageDocument>; fieldName(id: string): string | undefined;
  holder(row: PositionRow): string; siglum(row: PositionRow): string; work(row: PositionRow): string;
  onOpen(target: OpenTarget, beside: boolean): void; onEdited(doc: PageDocument): void;
}) {
  const [editing, setEditing] = createSignal<{ position: string; field: string; value: string | null; text: string } | null>(null);
  const [error, setError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
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
  async function commit() {
    const current = editing();
    if (!current || saving()) return;
    const row = props.rows.find(row => row.block.block.id === current.position);
    const doc = row && props.docs.get(row.block.page.id);
    if (!doc || doc.status() !== 'ready') { setError('The position is still loading.'); return; }
    if (!current.value && !current.text.trim()) { setEditing(null); return; }
    setSaving(true);
    let text: string;
    try { text = withLinkedTitles(current.text, await titleTargets(props.notebook, typedTitles(current.text))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setSaving(false); return; }
    if (editing() !== current) { setSaving(false); return; }
    if (current.value && doc.block(current.value)?.text === text) { setEditing(null); setSaving(false); return; }
    const entry = doc.outline.children(current.position).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === current.field);
    const result = doc.edit(current.value ? { kind: 'text', id: current.value, text }
      : entry ? { kind: 'insert', parentId: entry, after: doc.outline.children(entry).at(-1) ?? null, text }
      : { kind: 'addFieldEntries', parentId: current.position, after: doc.outline.children(current.position).at(-1) ?? null, entries: [{ fieldId: current.field, value: text }] });
    if (!result.ok) { setError(result.reason); setSaving(false); return; }
    const focusedCell = document.activeElement?.closest<HTMLElement>('.criteria-cell');
    setEditing(null); setError(''); props.onEdited(doc);
    queueMicrotask(() => focusedCell?.focus());
    try { await doc.flush(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); }
  }
  function start(row: PositionRow, field: string, value: { id: string; text: string } | undefined) {
    setEditing({ position: row.block.block.id, field, value: value?.id ?? null, text: value?.text ?? '' });
  }
  return <>
    <Show when={error()}><p class="pane-error" role="alert">{error()}</p></Show>
    <div class="criteria-overflow"><table class="criteria-matrix" style={{ '--holder-count': props.rows.length }}>
      <colgroup><col class="criteria-name-column" /><For each={props.rows}>{() => <col />}</For></colgroup>
      <thead><tr><th scope="col">Criterion</th><For each={props.rows}>{row => <th scope="col">
        <span class="compare-siglum">{props.siglum(row)}</span>
        <Button class="compare-holder-name" title="Open this reading · Shift to open beside" onClick={event => props.onOpen({ kind: 'page', pageId: row.block.page.id, blockId: row.block.block.id }, event.shiftKey)}>{props.holder(row)}</Button>
        <div class="compare-work"><BlockText text={props.work(row)} notebook={props.notebook} onOpen={props.onOpen} /></div>
      </th>}</For></tr></thead>
      <tbody><For each={props.criteria}>{field => <>
        <tr class="criteria-values"><th scope="row">{props.fieldName(field)}</th><For each={props.rows}>{row => {
          const id = row.block.block.id;
          const values = () => cells().get(id)?.get(field) ?? [];
          const current = () => editing()?.position === id && editing()?.field === field ? editing() : null;
          const repeat = () => repeats().find(repeat => repeat.criterion === field && repeat.positions.includes(id));
          return <td><div class="criteria-cell" tabIndex={0} role="group" aria-label={`${props.fieldName(field)} · ${props.holder(row)}`} onClick={event => { if (!(event.target as HTMLElement).closest('textarea,button')) start(row, field, values()[0]); }} onKeyDown={event => { if (event.key === 'Enter' && !current()) { event.preventDefault(); start(row, field, values()[0]); } }}>
            <Show when={current()} fallback={<Show when={values().some(value => value.text.trim())} fallback={<Button class="criteria-add" onClick={() => start(row, field, values()[0])}>Add</Button>}>
              <For each={values()}>{value => <button type="button" class="criteria-value" onClick={() => start(row, field, value)}><BlockText text={value.text} notebook={props.notebook} interactive={false} /></button>}</For>
            </Show>}>{edit => <>
              <For each={values().filter(value => value.id !== edit().value)}>{value => <div class="criteria-value"><BlockText text={value.text} notebook={props.notebook} interactive={false} /></div>}</For>
              <textarea class="criteria-input" aria-label={`Edit ${props.fieldName(field)} · ${props.holder(row)}`} disabled={saving()} value={edit().text} ref={input => queueMicrotask(() => { input.focus(); input.select(); })} onInput={event => setEditing(current => current ? { ...current, text: event.currentTarget.value } : null)} onBlur={() => void commit()} onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void commit(); }
                else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); }
              }} />
            </>}</Show>
          </div><Show when={repeat()}>{mark => <span class="criteria-exact">≡ {mark().number} · exact repeat</span>}</Show></td>;
        }}</For></tr>
        <For each={props.questions.filter(question => question.criterion === field)}>{question => <tr class="criteria-question"><td colSpan={props.rows.length + 1}><div>
          <span class="criteria-question-mark">?</span><span class="criteria-question-text"><BlockText text={question.block.block.text} notebook={props.notebook} onOpen={props.onOpen} /></span>
          <span class="criteria-scope">{props.fieldName(field)} · {question.holders.length ? `${question.holders.map(id => { const row = props.allRows.find(row => row.holder_id === id); return row ? props.siglum(row) : props.notebook.lookup(id)()?.text ?? id; }).join(' ↔ ')} only` : `all ${props.allRows.length}`}</span>
          <Button onClick={event => props.onOpen({ kind: 'page', pageId: question.block.page.id, blockId: question.block.block.id }, event.shiftKey)}>Open</Button>
        </div></td></tr>}</For>
      </>}</For></tbody>
    </table></div>
    <footer class="criteria-footnotes"><div><For each={repeats()}>{repeat => <p>≡ {repeat.number}　Identical authored value: "{repeat.text}" · {repeat.positions.map(id => props.siglum(props.rows.find(row => row.block.block.id === id)!)).join(', ')}</p>}</For></div><span class="criteria-hint">Enter to edit · Shift-open source</span></footer>
  </>;
}
