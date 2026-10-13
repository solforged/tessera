import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { api } from '../api/client';
import type { PositionRow } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { citedSigla } from '../library/sigla';
import { citedSource } from '../outline/references';
import { BlockText } from '../outline/BlockText';
import { fieldRole } from '../fields/roles';
import { positionFields, positionRelations, positionSource, readingPassages } from '../outline/perspectives';
import type { PositionField, ReadingPassage } from '../outline/perspectives';
import { OutgoingRelations } from '../outline/RelationLines';
import type { CompareViewState, OpenTarget } from '../shell/contract';
import { fieldEntryId } from '../table/query';
import { Button } from '../ui/Button';
import { ShapeGlyph } from './ShapeGlyph';
import { CriteriaEditor } from './CriteriaEditor';
import { CriteriaMatrix } from './CriteriaMatrix';
import { questionReadingIds } from './criteria';
import './compare.css';

interface ComparePaneProps {
  subjectId: string;
  view: CompareViewState;
  notebook: NotebookClient;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: CompareViewState): void;
  embedded?: boolean;
}

interface Perspective {
  row: PositionRow;
  gist: PositionField | undefined;
  work: PositionField | undefined;
  account: PositionField | undefined;
  shape: PositionField | undefined;
  source: string | null;
  passages: ReadingPassage[];
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
  const [historyDoc, setHistoryDoc] = createSignal<PageDocument>();
  const edited = (doc: PageDocument) => setHistoryDoc(doc);
  const [focusedQuestionId, setFocusedQuestionId] = createSignal(props.view.focusedQuestion ?? null);
  const focusedQuestion = createMemo(() => (result()?.questions ?? []).find(question => question.block.block.id === focusedQuestionId()));
  const selectedIds = createMemo(() => {
    const focus = focusedQuestion();
    if (focus) return questionReadingIds(rows(), focus.holders);
    const ids = chosen();
    const retained = ids === null ? [] : rows().filter(row => ids.includes(row.block.block.id));
    return (retained.length ? retained : rows()).map(row => row.block.block.id);
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
    const gist = fields.find(field => fieldRole(fieldList()?.fields.find(definition => definition.id === field.fieldId)) === 'standfirst');
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
    reportView();
  };
  function reportView() {
    props.onViewChange({ scroll: scroll?.scrollTop ?? props.view.scroll, comparison: tab(), chosen: chosen(), focusedQuestion: focusedQuestionId() });
  }
  function focusQuestion(id: string | null) {
    setFocusedQuestionId(id);
    reportView();
  }
  const questions = createMemo(() => (result()?.questions ?? []).filter(question => tab() === 'readings' || !question.criterion));
  const [siglumRecords] = createResource(() => { const ids = [...new Set(perspectives().map(item => item.source).filter(id => id !== null))]; return ids.length ? ids : false; },
    ids => Promise.all(ids.map(async id => ({ id, source: await citedSource(props.notebook, id).catch(() => null) }))));
  const sigla = createMemo(() => citedSigla(siglumRecords.error ? [] : siglumRecords() ?? []));
  const subject = () => props.notebook.lookup(props.subjectId)();
  const holder = (perspective: Perspective) => perspective.row.holder_id ? props.notebook.lookup(perspective.row.holder_id)()?.text ?? 'Loading holder…' : 'Unattributed';
  const open = (pageId: string, blockId: string | null, beside: boolean) => props.onOpen({ kind: 'page', pageId, ...(blockId ? { blockId } : {}) }, beside);
  const matrixSiglum = (row: PositionRow) => {
    const item = perspectives().find(item => item.row.block.block.id === row.block.block.id);
    return item?.source && sigla().get(item.source) || (row.holder_id ? props.notebook.lookup(row.holder_id)()?.text ?? '' : '').replace(/[^\p{L}]/gu, '').slice(0, 3).toUpperCase();
  };
  let scroll!: HTMLDivElement;
  let pane!: HTMLDivElement;
  onMount(() => {
    const clearQuestion = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !focusedQuestion()) return;
      if (!pane.closest('.pane.active') || !pane.getClientRects().length || pane.querySelector('.cm-editor') || document.querySelector('.popup:not(.popup-exit)')) return;
      event.preventDefault(); event.stopPropagation(); focusQuestion(null);
    };
    document.addEventListener('keydown', clearQuestion);
    onCleanup(() => document.removeEventListener('keydown', clearQuestion));
  });
  requestAnimationFrame(() => { if (scroll) scroll.scrollTop = props.view.scroll; });

  const count = createMemo(() => `${perspectives().length} perspectives by ${new Set(rows().flatMap(row => row.holder_id ? [row.holder_id] : [])).size} holders`);
  return <div ref={pane} class="compare-pane" classList={{ 'compare-embedded': props.embedded ?? false, 'compare-focused': !!focusedQuestion() }} role="region" tabIndex={0} aria-label="Compare perspectives" onFocusIn={props.onActivate} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !(event.target as HTMLElement).closest('.cm-editor')) {
      event.preventDefault(); event.stopPropagation();
      const doc = historyDoc() ?? docs().values().next().value;
      if (doc) event.shiftKey ? doc.redo() : doc.undo();
    }
  }}>
    <Show when={!props.embedded}><header class="compare-toolbar">
      <div><span class="compare-eyebrow">Perspective sheet</span><h2><Button class="compare-subject" title="Open the subject · Shift to open beside" onClick={event => { const target = subject(); if (target) open(target.page_id, target.kind === 'block' ? target.id : null, event.shiftKey); }}><span><BlockText text={subject()?.text ?? 'Loading…'} notebook={props.notebook} interactive={false} /></span></Button></h2></div>
      <span class="compare-count">{count()}</span>
    </header></Show>
    <div class="compare-tabs mode-tabs tab-strip" data-mode-panel=".compare-scroll" role="tablist" aria-label="Compare mode">
      <For each={['readings', 'criteria'] as const}>{mode => <Button role="tab" aria-selected={tab() === mode} onClick={() => { setTabChoice(mode); reportView(); }}>{mode === 'readings' ? 'Perspectives' : 'Criteria'}</Button>}</For>
    </div>
    <Show when={focusedQuestion()}>{question => <section class="compare-focus" aria-label="Focused question">
      <Button class="compare-focus-question" onClick={() => focusQuestion(null)}><BlockText text={question().block.block.text} notebook={props.notebook} interactive={false} /></Button>
      <div><Button onClick={() => { setChosen(null); focusQuestion(null); }}>Show all {perspectives().length} perspectives</Button>
        <Button onClick={event => open(question().block.page.id, question().block.block.id, event.shiftKey)}>Open original question</Button></div>
    </section>}</Show>
    <Show when={result.error || fieldList.error}><div class="pane-error" role="alert">Couldn’t load perspectives.</div></Show>
    <Show when={!focusedQuestion() && perspectives().length >= 2 && (tab() === 'readings' || chooseHolders())}>
      <div class="compare-choices mode-tabs tab-strip" role="group" aria-label="Choose perspectives"><For each={perspectives().slice(0, holderLimit())}>{perspective => {
        const active = () => selected().includes(perspective);
        return <Button aria-pressed={active()} disabled={active() && selected().length === 1} onClick={() => toggle(perspective.row.block.block.id)}>
          <Show when={perspective.source && sigla().get(perspective.source)}>{mark => <span class="compare-siglum">{mark()}</span>}</Show>
          {holder(perspective)}<span class="compare-choice-mark" aria-hidden="true">{active() ? '−' : '+'}</span>
        </Button>;
      }}</For><Show when={perspectives().length > holderLimit()}><Button onClick={() => setHolderLimit(value => value + 100)}>More holders</Button></Show></div>
    </Show>
    <div ref={scroll} class="compare-scroll" onScroll={reportView}>
      <Show when={result()} fallback={<Show when={!result.error}><p class="empty-state" role="status">Loading perspectives…</p></Show>}>
        <Show when={tab() === 'criteria'}>
          <div class="compare-matrix">
            <div class="criteria-tools"><span class="compare-count"><Show when={props.embedded}>{count()} · </Show>{result()?.criteria.fields.length ?? 0} criteria · {result()?.questions.length ?? 0} questions</span>
              <Show when={!focusedQuestion()}><Button aria-expanded={chooseHolders()} onClick={() => setChooseHolders(value => !value)}>Choose perspectives</Button></Show>
              <Button onClick={event => setCriteriaEditor(event.currentTarget)}>Edit criteria</Button>
            </div>
            <CriteriaMatrix rows={selected().map(item => item.row)} allRows={rows()} criteria={result()?.criteria.fields ?? []} questions={result()?.questions ?? []} focusedCriterion={focusedQuestion()?.criterion ?? null} onFocusQuestion={id => focusQuestion(id)} notebook={props.notebook} docs={docs()} field={id => fieldList()?.fields.find(field => field.id === id)}
              holder={row => row.holder_id ? props.notebook.lookup(row.holder_id)()?.text ?? 'Loading holder…' : 'Unattributed'} siglum={matrixSiglum}
              work={row => perspectives().find(item => item.row.block.block.id === row.block.block.id)?.work?.value ?? ''} onOpen={props.onOpen} onEdited={edited} />
          </div>
        </Show>
        <Show when={tab() === 'readings'}>
        <Show when={perspectives().length >= 2} fallback={<p class="empty-state">Compare needs two or more perspectives filed under this page. Make a block a perspective from its menu and write its Gist beneath it.</p>}>
          <div class="compare-readings" style={{ '--reading-count': selected().length }}><For each={selected()}>{perspective => {
            const page = perspective.row.block.page.id;
            const id = perspective.row.block.block.id;
            return <article class="compare-reading" aria-label={holder(perspective)}>
              <header>
                <Show when={perspective.source && sigla().get(perspective.source)}>{mark => <span class="compare-siglum" title={props.notebook.lookup(perspective.source!)()?.text}>{mark()}</span>}</Show>
                <h3><Button class="compare-holder-name" title="Open this perspective · Shift to open beside" onClick={event => open(page, id, event.shiftKey)}>{holder(perspective)}</Button>
                  <Show when={perspective.shape?.value}>{shape => <span class="compare-shape" title={shape()} role="img" aria-label={shape()}><ShapeGlyph value={shape()} /></span>}</Show>
                </h3>
                <Show when={perspective.work?.value}>{work => <div class="compare-work"><BlockText text={perspective.work?.valueId ? docs().get(page)?.block(perspective.work.valueId)?.text ?? work() : work()} blockId={perspective.work?.valueId ?? undefined} notebook={props.notebook} onOpen={props.onOpen} /></div>}</Show>
                <Show when={perspective.account?.value}>{account => <div class="compare-work"><span class="relation-label">Account</span> <BlockText text={perspective.account?.valueId ? docs().get(page)?.block(perspective.account.valueId)?.text ?? account() : account()} blockId={perspective.account?.valueId ?? undefined} notebook={props.notebook} onOpen={props.onOpen} /></div>}</Show>
              </header>
              <Show when={perspective.gist?.value}>{gist => <p class="compare-gist"><BlockText text={perspective.gist?.valueId ? docs().get(page)?.block(perspective.gist.valueId)?.text ?? gist() : gist()} blockId={perspective.gist?.valueId ?? undefined} notebook={props.notebook} onOpen={props.onOpen} /></p>}</Show>
              <For each={perspective.passages}>{passage => <div class="compare-passage" classList={{ 'compare-passage-heading': passage.heading }}><BlockText text={passage.text} blockId={passage.id} notebook={props.notebook} onOpen={props.onOpen} /></div>}</For>
              <OutgoingRelations rows={docs().get(page)?.status() === 'ready' ? positionRelations(docs().get(page)!, id) : []} notebook={props.notebook} onOpen={props.onOpen} />
              <Button class="compare-open" onClick={event => open(page, id, event.shiftKey)}>Open perspective</Button>
            </article>;
          }}</For></div>
        </Show></Show>
          <Show when={questions().length}><section class="compare-questions" aria-label="Questions on this page">
            <h3>Questions on this page</h3><For each={questions()}>{question => <div class="compare-question"><Button onClick={() => focusQuestion(question.block.block.id)}><BlockText text={question.block.block.text} notebook={props.notebook} interactive={false} /></Button><Button onClick={event => open(question.block.page.id, question.block.block.id, event.shiftKey)}>Open original</Button></div>}</For>
          </section></Show>
      </Show>
    </div>
    <Show when={criteriaEditor()}>{anchor => {
      const doc = [...docs().values()].find(doc => doc.block(props.subjectId));
      return <Show when={doc && doc.status() === 'ready' && result()?.criteria}>{criteria => <CriteriaEditor anchor={anchor()} subjectId={props.subjectId} criteria={criteria()} fields={fieldList()?.fields ?? []} doc={doc!} onEdited={edited} onDismiss={() => setCriteriaEditor(null)} />}</Show>;
    }}</Show>
  </div>;
}
