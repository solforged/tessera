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
import { fieldEntryId, matchFieldEntry } from '../table/query';
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

interface Passage { id: string; text: string; heading: boolean }
interface Perspective {
  row: PositionRow;
  gist: PositionField | undefined;
  work: PositionField | undefined;
  shape: PositionField | undefined;
  source: string | null;
  passages: Passage[];
}

/** Read authored prose, not a questionnaire reconstructed from field values. */
function readingPassages(doc: PageDocument, id: string, gist: string | undefined, fieldName: (id: string) => string | undefined): Passage[] {
  doc.outline.version(); doc.archivedVersion();
  const outline = doc.outline;
  const start = outline.indexOf(id);
  const passages: Passage[] = [];
  if (start < 0) return passages;
  for (let at = start + 1, end = outline.subtreeEnd(start); at < end;) {
    const blockId = outline.idAt(at);
    const block = doc.block(blockId);
    const field = fieldEntryId(block?.text ?? '');
    if (!block || doc.isArchived(blockId) || (field && fieldName(field)) || matchFieldEntry(block.text) || block.position) {
      at = outline.subtreeEnd(at);
      continue;
    }
    const text = block.text.trim();
    if (text && text !== gist?.trim()) passages.push({ id: blockId, text, heading: block.heading !== null });
    at++;
  }
  return passages;
}

/** Attributed readings stay side by side; their source outlines remain the place to edit fields. */
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
  const [docs, setDocs] = createSignal(new Map<string, PageDocument>());
  createEffect(() => {
    const pages = new Set([props.subjectId, ...(rows() ?? []).map(row => row.block.page.id)]);
    const opened = new Map([...pages].map(id => [id, props.notebook.open(id)]));
    setDocs(opened);
    onCleanup(() => { for (const doc of opened.values()) doc.release(); });
  });
  const perspectives = createMemo<Perspective[]>(() => (rows() ?? []).flatMap(row => {
    const doc = docs().get(row.block.page.id);
    if (!doc || doc.status() !== 'ready' || !doc.block(row.block.block.id)) return [];
    const fields = positionFields(doc, row.block.block.id, fieldName);
    const gist = fields.find(field => isGistName(field.name));
    return [{ row, gist,
      work: fields.find(field => field.name.trim().toLowerCase() === 'work'),
      shape: fields.find(field => field.name.trim().toLowerCase() === 'shape'),
      source: positionSource(doc, row.block.block.id, fieldName),
      passages: readingPassages(doc, row.block.block.id, gist?.value, fieldName),
    }];
  }));
  const [chosen, setChosen] = createSignal<string[] | null>(null);
  const selected = createMemo(() => {
    const all = perspectives();
    const ids = chosen();
    const retained = ids === null ? [] : all.filter(item => ids.includes(item.row.block.block.id));
    return retained.length ? retained : all.slice(0, 2);
  });
  const toggle = (id: string) => {
    const ids = selected().map(item => item.row.block.block.id);
    if (ids.includes(id)) { if (ids.length > 1) setChosen(ids.filter(value => value !== id)); }
    else setChosen([...ids, id]);
  };
  const questions = createMemo(() => {
    const doc = docs().get(props.subjectId);
    if (!doc || doc.status() !== 'ready') return [];
    doc.outline.version(); doc.archivedVersion();
    const result: Passage[] = [];
    for (let at = 0; at < doc.outline.size();) {
      const id = doc.outline.idAt(at);
      const block = doc.block(id);
      if (doc.isArchived(id) || block?.position) { at = doc.outline.subtreeEnd(at); continue; }
      if (block?.question && block.text.trim()) result.push({ id, text: block.text, heading: false });
      at++;
    }
    return result;
  });
  const [siglumRecords] = createResource(() => { const ids = [...new Set(perspectives().map(item => item.source).filter(id => id !== null))]; return ids.length ? ids : false; },
    ids => Promise.all(ids.map(id => api.source(id).then(view => ({ id, siglum: view.source.siglum, basis: view.source.siglum_basis, authored: view.source.siglum_authored }), () => null))));
  const sigla = createMemo(() => pageSigla((siglumRecords.error ? [] : siglumRecords() ?? []).filter(record => record !== null)));
  const subject = () => props.notebook.lookup(props.subjectId)();
  const holder = (perspective: Perspective) => perspective.row.holder_id ? props.notebook.lookup(perspective.row.holder_id)()?.text ?? 'Loading holder…' : 'Unattributed';
  const open = (pageId: string, blockId: string | null, beside: boolean) => props.onOpen({ kind: 'page', pageId, ...(blockId ? { blockId } : {}) }, beside);
  let scroll!: HTMLDivElement;
  requestAnimationFrame(() => { if (scroll) scroll.scrollTop = props.view.scroll; });

  return <div class="compare-pane" role="region" tabIndex={0} aria-label="Compare perspectives" onFocusIn={props.onActivate}>
    <header class="compare-toolbar">
      <div><span class="compare-eyebrow">Reading sheet</span><h2><Button class="compare-subject" title="Open the subject · Shift to open beside" onClick={event => open(props.subjectId, null, event.shiftKey)}>{subject()?.text ?? 'Loading…'}</Button></h2></div>
      <span class="compare-count">{selected().length} of {perspectives().length} readings</span>
    </header>
    <Show when={rows.error || fieldList.error}><div class="pane-error" role="alert">Couldn’t load readings.</div></Show>
    <Show when={perspectives().length >= 2}>
      <div class="compare-choices" role="group" aria-label="Choose readings"><For each={perspectives()}>{perspective => {
        const active = () => selected().includes(perspective);
        return <Button aria-pressed={active()} disabled={active() && selected().length === 1} onClick={() => toggle(perspective.row.block.block.id)}>
          <Show when={perspective.source && sigla().get(perspective.source)}>{mark => <span class="compare-siglum">{mark()}</span>}</Show>
          {holder(perspective)}<span class="compare-choice-mark" aria-hidden="true">{active() ? '−' : '+'}</span>
        </Button>;
      }}</For></div>
    </Show>
    <div ref={scroll} class="compare-scroll" onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })}>
      <Show when={rows()} fallback={<Show when={!rows.error}><p class="empty-state" role="status">Loading readings…</p></Show>}>
        <Show when={perspectives().length >= 2} fallback={<p class="empty-state">Compare needs two or more perspectives filed under this page. Make a block a perspective from its menu and write its reading beneath it.</p>}>
          <div class="compare-readings" style={{ '--reading-count': selected().length }}><For each={selected()}>{perspective => {
            const page = perspective.row.block.page.id;
            const id = perspective.row.block.block.id;
            return <article class="compare-reading" aria-label={holder(perspective)}>
              <header>
                <Show when={perspective.source && sigla().get(perspective.source)}>{mark => <span class="compare-siglum" title={props.notebook.lookup(perspective.source!)()?.text}>{mark()}</span>}</Show>
                <h3><Button class="compare-holder-name" title="Open this reading · Shift to open beside" onClick={event => open(page, id, event.shiftKey)}>{holder(perspective)}</Button>
                  <Show when={perspective.shape?.value}>{shape => <span class="compare-shape" title={shape()} role="img" aria-label={shape()}><ShapeGlyph value={shape()} /></span>}</Show>
                </h3>
                <Show when={perspective.work?.value}>{work => <div class="compare-work"><BlockText text={work()} notebook={props.notebook} onOpen={props.onOpen} /></div>}</Show>
              </header>
              <Show when={perspective.gist?.value}>{gist => <p class="compare-gist"><BlockText text={gist()} notebook={props.notebook} onOpen={props.onOpen} /></p>}</Show>
              <For each={perspective.passages}>{passage => <div class="compare-passage" classList={{ 'compare-passage-heading': passage.heading }}><BlockText text={passage.text} notebook={props.notebook} onOpen={props.onOpen} /></div>}</For>
              <Button class="compare-open" onClick={event => open(page, id, event.shiftKey)}>Open reading</Button>
            </article>;
          }}</For></div>
          <Show when={questions().length}><section class="compare-questions" aria-label="Questions on this page">
            <h3>Questions on this page</h3><For each={questions()}>{question => <Button onClick={event => open(props.subjectId, question.id, event.shiftKey)}><BlockText text={question.text} notebook={props.notebook} interactive={false} /></Button>}</For>
          </section></Show>
        </Show>
      </Show>
    </div>
  </div>;
}
