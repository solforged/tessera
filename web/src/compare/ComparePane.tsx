import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import { api } from '../api/client';
import type { PositionRow } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { pageSigla } from '../library/sigla';
import { BlockText } from '../outline/BlockText';
import { isGistName } from '../outline/gloss';
import { positionFields, positionSource } from '../outline/perspectives';
import type { PositionField } from '../outline/perspectives';
import type { CompareViewState, OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { ShapeGlyph } from './ShapeGlyph';
import './compare.css';

interface ComparePaneProps {
  subjectId: string;
  view: CompareViewState;
  notebook: NotebookClient;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: CompareViewState): void;
}

interface Perspective { row: PositionRow; fields: PositionField[]; gist: PositionField | undefined; source: string | null }
interface Column { fieldId: string; name: string }

const isWorkName = (name: string) => name.trim().toLowerCase() === 'work';
const isShapeName = (name: string) => name.trim().toLowerCase() === 'shape';
const normal = (value: string) => value.trim().toLowerCase().replace(/[.\s]+$/, '');

/**
 * Perspectives filed under one subject, side by side: one row per position, one column per field that two
 * or more of them carry. Cells read live from the outline and open the value they show.
 */
export function ComparePane(props: ComparePaneProps) {
  const [version, setVersion] = createSignal(0);
  createEffect(() => {
    props.notebook.changeSequence();
    const timer = setTimeout(() => setVersion(value => value + 1), 300);
    onCleanup(() => clearTimeout(timer));
  });
  const [rows] = createResource(() => `${props.subjectId}:${version()}`, () => api.positions({ subject: props.subjectId }));
  const [fieldList] = createResource(() => version(), () => api.fields());
  const fieldName = (id: string) => fieldList()?.fields.find(field => field.id === id)?.name;
  // Positions are read from their pages' live documents, so edits show without a refetch.
  const [docs, setDocs] = createSignal(new Map<string, PageDocument>());
  createEffect(() => {
    const pages = [...new Set((rows() ?? []).map(row => row.block.page.id))];
    const opened = new Map(pages.map(id => [id, props.notebook.open(id)]));
    setDocs(opened);
    onCleanup(() => { for (const doc of opened.values()) doc.release(); });
  });
  const perspectives = createMemo<Perspective[]>(() => (rows() ?? []).flatMap(row => {
    const doc = docs().get(row.block.page.id);
    if (!doc || doc.status() !== 'ready' || !doc.block(row.block.block.id)) return [];
    const fields = positionFields(doc, row.block.block.id, fieldName);
    return [{ row, fields, gist: fields.find(field => isGistName(field.name)), source: positionSource(doc, row.block.block.id, fieldName) }];
  }));
  const columns = createMemo<Column[]>(() => {
    const counts = new Map<string, Column & { count: number }>();
    for (const perspective of perspectives()) for (const field of new Map(perspective.fields.map(field => [field.fieldId, field])).values()) {
      if (isGistName(field.name) || isWorkName(field.name)) continue;
      const column = counts.get(field.fieldId) ?? { fieldId: field.fieldId, name: field.name, count: 0 };
      column.count++;
      counts.set(field.fieldId, column);
    }
    return [...counts.values()].filter(column => column.count >= 2);
  });
  // Values two or more perspectives share mark agreement; a column where every value differs is a tension.
  const agreement = createMemo(() => {
    const result = new Map<string, Set<string>>();
    for (const column of columns()) {
      const seen = new Map<string, number>();
      for (const perspective of perspectives()) {
        const value = perspective.fields.find(field => field.fieldId === column.fieldId)?.value;
        if (value) seen.set(normal(value), (seen.get(normal(value)) ?? 0) + 1);
      }
      result.set(column.fieldId, new Set([...seen].filter(([, count]) => count > 1).map(([value]) => value)));
    }
    return result;
  });
  const [siglumRecords] = createResource(() => { const ids = [...new Set(perspectives().map(item => item.source).filter(id => id !== null))]; return ids.length ? ids : false; },
    ids => Promise.all(ids.map(id => api.source(id).then(view => ({ id, siglum: view.source.siglum, basis: view.source.siglum_basis }), () => null))));
  const sigla = createMemo(() => pageSigla((siglumRecords.error ? [] : siglumRecords() ?? []).filter(record => record !== null)));
  const subject = () => props.notebook.lookup(props.subjectId)();
  const open = (pageId: string, blockId: string | null, beside: boolean) => props.onOpen({ kind: 'page', pageId, ...(blockId ? { blockId } : {}) }, beside);
  let scroll!: HTMLDivElement;
  requestAnimationFrame(() => { if (scroll) scroll.scrollTop = props.view.scroll; });

  return <div class="compare-pane" role="region" tabIndex={0} aria-label="Compare perspectives" onFocusIn={props.onActivate}>
    <div class="compare-toolbar">
      <h2><Button class="compare-subject" title="Open the subject · Shift to open beside" onClick={event => open(props.subjectId, null, event.shiftKey)}>{subject()?.text ?? 'Loading…'}</Button></h2>
      <span class="compare-count">{perspectives().length} perspectives · {columns().length} shared fields</span>
    </div>
    <Show when={rows.error}><div class="pane-error" role="alert">Couldn’t load perspectives.</div></Show>
    <div ref={scroll} class="compare-scroll" onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })}>
      <Show when={rows()} fallback={<Show when={!rows.error}><p class="empty-state" role="status">Loading perspectives…</p></Show>}>
        <Show when={perspectives().length >= 2} fallback={<p class="empty-state">Compare needs two or more perspectives filed under this page. Make a block a perspective from its menu, then give each one the same fields, such as <code>Shape::</code>.</p>}>
          <table class="compare-table">
            <thead><tr><th scope="col" class="compare-holder-column">Perspective</th><For each={columns()}>{column => <th scope="col" classList={{ 'compare-tension': (agreement().get(column.fieldId)?.size ?? 0) === 0 }} title={(agreement().get(column.fieldId)?.size ?? 0) === 0 ? 'Every perspective differs here' : undefined}>{column.name}</th>}</For></tr></thead>
            <tbody><For each={perspectives()}>{perspective => {
              const page = perspective.row.block.page.id;
              const id = perspective.row.block.block.id;
              const holder = () => perspective.row.holder_id ? props.notebook.lookup(perspective.row.holder_id)() : null;
              return <tr>
                <th scope="row" class="compare-holder">
                  <Show when={perspective.source && sigla().get(perspective.source)}>{mark => <span class="compare-siglum" title={props.notebook.lookup(perspective.source!)()?.text}>{mark()}</span>}</Show>
                  <Button class="compare-holder-name" title="Open this perspective · Shift to open beside" onClick={event => open(page, id, event.shiftKey)}>{holder()?.text ?? 'No holder'}</Button>
                  <Show when={perspective.gist?.value}>{gist => <span class="compare-gist"><BlockText text={gist()} notebook={props.notebook} onOpen={props.onOpen} /></span>}</Show>
                </th>
                <For each={columns()}>{column => {
                  const field = () => perspective.fields.find(item => item.fieldId === column.fieldId);
                  return <td classList={{ 'compare-agrees': !!field()?.value && !!agreement().get(column.fieldId)?.has(normal(field()!.value)) }}>
                    <Show when={field()} fallback={<span class="compare-missing">None</span>}>{value =>
                      <button type="button" class="compare-cell" title="Open this value · Shift to open beside" onClick={event => open(page, value().valueId ?? value().entryId, event.shiftKey)}>
                        <Show when={isShapeName(column.name)}><ShapeGlyph value={value().value} /></Show>
                        <Show when={value().value} fallback={<span class="compare-missing">Empty</span>}><BlockText text={value().value} notebook={props.notebook} onOpen={props.onOpen} /></Show>
                      </button>}</Show>
                  </td>;
                }}</For>
              </tr>;
            }}</For></tbody>
          </table>
        </Show>
      </Show>
    </div>
    <footer class="compare-footer"><span>Shared values are marked; a field where every perspective differs is ruled in red.</span></footer>
  </div>;
}
