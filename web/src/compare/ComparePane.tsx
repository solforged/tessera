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
import { CriteriaEditor } from './CriteriaEditor';
import { CriteriaMatrix } from './CriteriaMatrix';
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
  account: PositionField | undefined;
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
    if (text && text !== gist?.trim()) passages.push({ id: blockId, text: block.text, heading: block.heading !== null });
    at++;
  }
  return passages;
}

/** Readings and criteria share authored positions and their page documents. */
export function ComparePane(props: ComparePaneProps) {
  const [version, setVersion] = createSignal(0);
  createEffect(() => {
    props.notebook.changeSequence();
    const timer = setTimeout(() => setVersion(value => value + 1), 300);
    onCleanup(() => clearTimeout(timer));
  });
  const [result] = createResource(() => `${props.subjectId}:${version()}`, () => api.positions({ subject: props.subjectId }));
  const rows = createMemo(() => result()?.rows ?? []);
  const [tabChoice, setTabChoice] = createSignal(props.view.comparison);
  const tab = createMemo(() => tabChoice() ?? (result()?.criteria.fields.length ? 'criteria' : 'readings'));
  const [chosen, setChosen] = createSignal<string[] | null>(props.view.chosen ?? null);
  const [chooseHolders, setChooseHolders] = createSignal(false);
  const [holderLimit, setHolderLimit] = createSignal(100);
  const [criteriaEditor, setCriteriaEditor] = createSignal<HTMLElement | null>(null);
  const history: PageDocument[] = [];
  const undone: PageDocument[] = [];
  const edited = (doc: PageDocument) => { history.push(doc); undone.length = 0; };
  const selectedIds = createMemo(() => {
    const ids = chosen();
    const retained = ids === null ? [] : rows().filter(row => ids.includes(row.block.block.id));
    return (retained.length ? retained : rows().slice(0, tab() === 'criteria' ? 12 : 2)).map(row => row.block.block.id);
  });
  const [fieldList] = createResource(() => version(), () => api.fields());
  const fieldName = (id: string) => fieldList()?.fields.find(field => field.id === id)?.name;
  const [docs, setDocs] = createSignal(new Map<string, PageDocument>());
  createEffect(() => {
    const subjectPage = props.notebook.lookup(props.subjectId)()?.page_id ?? props.subjectId;
    const pages = new Set([subjectPage, ...rows().filter(row => selectedIds().includes(row.block.block.id)).map(row => row.block.page.id)]);
    const opened = new Map([...pages].map(id => [id, props.notebook.open(id)]));
    setDocs(opened);
    onCleanup(() => { for (const doc of opened.values()) doc.release(); });
  });
  const perspectives = createMemo<Perspective[]>(() => rows().map(row => {
    const doc = docs().get(row.block.page.id);
    const ready = doc?.status() === 'ready' && doc.block(row.block.block.id);
    const fields = ready ? positionFields(doc!, row.block.block.id, fieldName) : row.fields.map(entry => ({
      name: fieldName(entry.field_id) ?? '', fieldId: entry.field_id, entryId: entry.entry_id,
      valueId: entry.values[0]?.id ?? null, value: entry.values[0]?.text ?? '',
    }));
    const gist = fields.find(field => isGistName(field.name));
    const work = fields.find(field => field.name.trim().toLowerCase() === 'work');
    return { row, gist, work,
      account: fields.find(field => field.name.trim().toLowerCase() === 'account'),
      shape: fields.find(field => field.name.trim().toLowerCase() === 'shape'),
      source: ready ? positionSource(doc!, row.block.block.id, fieldName) : fieldEntryId(work?.value ?? ''),
      passages: ready ? readingPassages(doc!, row.block.block.id, gist?.value, fieldName) : [],
    };
  }));
  const selected = createMemo(() => perspectives().filter(item => selectedIds().includes(item.row.block.block.id)));
  const toggle = (id: string) => {
    const ids = selected().map(item => item.row.block.block.id);
    if (ids.includes(id)) { if (ids.length > 1) setChosen(ids.filter(value => value !== id)); }
    else setChosen([...ids, id]);
    props.onViewChange({ scroll: scroll?.scrollTop ?? props.view.scroll, comparison: tab(), chosen: chosen() });
  };
  const questions = createMemo(() => (result()?.questions ?? []).filter(question => tab() === 'readings' || !question.criterion));
  const [siglumRecords] = createResource(() => { const ids = [...new Set(perspectives().map(item => item.source).filter(id => id !== null))]; return ids.length ? ids : false; },
    ids => Promise.all(ids.map(id => api.source(id).then(view => ({ id, siglum: view.source.siglum, basis: view.source.siglum_basis, authored: view.source.siglum_authored }), () => null))));
  const sigla = createMemo(() => pageSigla((siglumRecords.error ? [] : siglumRecords() ?? []).filter(record => record !== null)));
  const subject = () => props.notebook.lookup(props.subjectId)();
  const holder = (perspective: Perspective) => perspective.row.holder_id ? props.notebook.lookup(perspective.row.holder_id)()?.text ?? 'Loading holder…' : 'Unattributed';
  const open = (pageId: string, blockId: string | null, beside: boolean) => props.onOpen({ kind: 'page', pageId, ...(blockId ? { blockId } : {}) }, beside);
  const matrixSiglum = (row: PositionRow) => {
    const item = perspectives().find(item => item.row.block.block.id === row.block.block.id);
    return item?.source && sigla().get(item.source) || (row.holder_id ? props.notebook.lookup(row.holder_id)()?.text ?? '' : '').replace(/[^\p{L}]/gu, '').slice(0, 3).toUpperCase();
  };
  let scroll!: HTMLDivElement;
  requestAnimationFrame(() => { if (scroll) scroll.scrollTop = props.view.scroll; });

  return <div class="compare-pane" role="region" tabIndex={0} aria-label="Compare perspectives" onFocusIn={props.onActivate} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault(); event.stopPropagation();
      const source = event.shiftKey ? undone : history;
      const doc = source.pop();
      if (doc) { event.shiftKey ? doc.redo() : doc.undo(); (event.shiftKey ? history : undone).push(doc); }
    }
  }}>
    <header class="compare-toolbar">
      <div><span class="compare-eyebrow">Reading sheet</span><h2><Button class="compare-subject" title="Open the subject · Shift to open beside" onClick={event => open(props.subjectId, null, event.shiftKey)}>{subject()?.text ?? 'Loading…'}</Button></h2></div>
      <Show when={tab() === 'readings'}><span class="compare-count">{selected().length} of {perspectives().length} readings</span></Show>
    </header>
    <div class="compare-tabs mode-tabs tab-strip" data-mode-panel=".compare-scroll" role="tablist" aria-label="Compare mode">
      <For each={['readings', 'criteria'] as const}>{mode => <Button role="tab" aria-selected={tab() === mode} onClick={() => { setTabChoice(mode); props.onViewChange({ scroll: scroll?.scrollTop ?? 0, comparison: mode, chosen: chosen() }); }}>{mode === 'readings' ? 'Readings' : 'Criteria'}</Button>}</For>
    </div>
    <Show when={result.error || fieldList.error}><div class="pane-error" role="alert">Couldn’t load readings.</div></Show>
    <Show when={perspectives().length >= 2 && (tab() === 'readings' || chooseHolders())}>
      <div class="compare-choices mode-tabs tab-strip" role="group" aria-label="Choose readings"><For each={perspectives().slice(0, holderLimit())}>{perspective => {
        const active = () => selected().includes(perspective);
        return <Button aria-pressed={active()} disabled={active() && selected().length === 1} onClick={() => toggle(perspective.row.block.block.id)}>
          <Show when={perspective.source && sigla().get(perspective.source)}>{mark => <span class="compare-siglum">{mark()}</span>}</Show>
          {holder(perspective)}<span class="compare-choice-mark" aria-hidden="true">{active() ? '−' : '+'}</span>
        </Button>;
      }}</For><Show when={perspectives().length > holderLimit()}><Button onClick={() => setHolderLimit(value => value + 100)}>More holders</Button></Show></div>
    </Show>
    <div ref={scroll} class="compare-scroll" onScroll={() => props.onViewChange({ scroll: scroll.scrollTop, comparison: tab(), chosen: chosen() })}>
      <Show when={result()} fallback={<Show when={!result.error}><p class="empty-state" role="status">Loading readings…</p></Show>}>
        <Show when={tab() === 'criteria'}>
          <div class="compare-matrix">
            <div class="criteria-tools"><span class="compare-count">{selected().length} of {perspectives().length} holders · {result()?.criteria.fields.length ?? 0} subject criteria · {result()?.questions.length ?? 0} questions</span>
              <Button aria-expanded={chooseHolders()} onClick={() => setChooseHolders(value => !value)}>Choose holders</Button>
              <Button onClick={event => setCriteriaEditor(event.currentTarget)}>Edit criteria</Button>
            </div>
            <CriteriaMatrix rows={selected().map(item => item.row)} allRows={rows()} criteria={result()?.criteria.fields ?? []} questions={result()?.questions ?? []} notebook={props.notebook} docs={docs()} fieldName={fieldName}
              holder={row => row.holder_id ? props.notebook.lookup(row.holder_id)()?.text ?? 'Loading holder…' : 'Unattributed'} siglum={matrixSiglum}
              work={row => perspectives().find(item => item.row.block.block.id === row.block.block.id)?.work?.value ?? ''} onOpen={props.onOpen} onEdited={edited} />
          </div>
        </Show>
        <Show when={tab() === 'readings'}>
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
                <Show when={perspective.work?.value}>{work => <div class="compare-work"><BlockText text={perspective.work?.valueId ? docs().get(page)?.block(perspective.work.valueId)?.text ?? work() : work()} blockId={perspective.work?.valueId ?? undefined} notebook={props.notebook} onOpen={props.onOpen} /></div>}</Show>
                <Show when={perspective.account?.value}>{account => <div class="compare-work">as discussed by <BlockText text={perspective.account?.valueId ? docs().get(page)?.block(perspective.account.valueId)?.text ?? account() : account()} blockId={perspective.account?.valueId ?? undefined} notebook={props.notebook} onOpen={props.onOpen} /></div>}</Show>
              </header>
              <Show when={perspective.gist?.value}>{gist => <p class="compare-gist"><BlockText text={perspective.gist?.valueId ? docs().get(page)?.block(perspective.gist.valueId)?.text ?? gist() : gist()} blockId={perspective.gist?.valueId ?? undefined} notebook={props.notebook} onOpen={props.onOpen} /></p>}</Show>
              <For each={perspective.passages}>{passage => <div class="compare-passage" classList={{ 'compare-passage-heading': passage.heading }}><BlockText text={passage.text} blockId={passage.id} notebook={props.notebook} onOpen={props.onOpen} /></div>}</For>
              <Button class="compare-open" onClick={event => open(page, id, event.shiftKey)}>Open reading</Button>
            </article>;
          }}</For></div>
        </Show></Show>
          <Show when={questions().length}><section class="compare-questions" aria-label="Questions on this page">
            <h3>Questions on this page</h3><For each={questions()}>{question => <Button onClick={event => open(question.block.page.id, question.block.block.id, event.shiftKey)}><BlockText text={question.block.block.text} notebook={props.notebook} interactive={false} /></Button>}</For>
          </section></Show>
      </Show>
    </div>
    <Show when={criteriaEditor()}>{anchor => {
      const doc = [...docs().values()].find(doc => doc.block(props.subjectId));
      return <Show when={doc && doc.status() === 'ready' && result()?.criteria}>{criteria => <CriteriaEditor anchor={anchor()} subjectId={props.subjectId} criteria={criteria()} fields={fieldList()?.fields ?? []} doc={doc!} onEdited={edited} onDismiss={() => setCriteriaEditor(null)} />}</Show>;
    }}</Show>
  </div>;
}
