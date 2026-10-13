import { opensBeside } from '../shell/beside';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import type { QuestionInfo, QuestionRow, QuestionStatus } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { BlockText } from './BlockText';
import { foldName, plainText } from './names';
import { isStableReference, textTokens } from '../document/text-tokens';

export const questionLabels: Record<QuestionStatus, string> = { open: 'Active', answered: 'Answered', parked: 'Parked', unsettled: 'Recurrent' };

export function QuestionParent(props: { info: QuestionInfo | null | undefined; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void; onChange(anchor: HTMLElement): void; onRemove(): void; disabled: boolean }) {
  const parent = createMemo(() => props.info?.parent_id ? props.notebook.lookup(props.info.parent_id)() : null);
  return <Show when={parent()}>{block => <div class="question-parent" onMouseDown={event => event.stopPropagation()}>
    <span>Part of</span><Button class="question-parent-name" onClick={event => props.onOpen({ kind: 'page', pageId: block().page_id, blockId: block().kind === 'block' ? block().id : undefined }, opensBeside(event))}><BlockText text={block().text} notebook={props.notebook} interactive={false} /></Button>
    <Show when={props.info?.parent_explicit}><Button disabled={props.disabled} onClick={event => props.onChange(event.currentTarget)}>Change parent…</Button><Button disabled={props.disabled} onClick={props.onRemove}>Remove parent</Button></Show>
  </div>}</Show>;
}

export function QuestionParentPicker(props: { id: string; notebook: NotebookClient; anchor: PopupAnchor; onDismiss(): void; onPick(id: string): Promise<void> }) {
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [questions] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.questions({}));
  const matches = createMemo(() => {
    if (questions.error) return [];
    const rows = questions() ?? [];
    const parents = new Map(rows.map(row => [row.block.block.id, row.info.parent_id]));
    const text = foldName(query());
    return rows.filter(row => {
      const seen = new Set<string>();
      for (let id: string | null | undefined = row.block.block.id; id; id = parents.get(id)) {
        if (id === props.id || seen.has(id)) return false;
        seen.add(id);
      }
      return foldName(plainText(row.block.block.text, id => props.notebook.lookup(id))).includes(text)
        || foldName(row.block.page.text).includes(text);
    });
  });
  const pick = async (row: QuestionRow) => {
    if (busy()) return;
    setBusy(true); setError('');
    try { await props.onPick(row.block.block.id); props.onDismiss(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <Picker<QuestionRow> anchor={props.anchor} label="Set parent question" query={query()} onQuery={setQuery} placeholder="Find a question" onDismiss={props.onDismiss}
    items={matches()} key={row => row.block.block.id} busy={questions.loading || busy()} error={error() || (questions.error ? String(questions.error) : undefined)}
    disabledReason={() => busy() ? 'Saving the parent.' : undefined} empty="No matching questions." onPick={row => { void pick(row); }}
    row={row => <><Icon name="question-open" /><span class="picker-text find-result"><BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /><Show when={row.block.block.kind === 'block'}><small><BlockText text={row.block.page.text} notebook={props.notebook} interactive={false} /> · Inline question</small></Show></span></>} />;
}

export function QuestionBranches(props: { rows: QuestionRow[]; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void }) {
  return <Show when={props.rows.length}><section class="question-branches" aria-label="Branches" onMouseDown={event => event.stopPropagation()}>
    <h3>Branches</h3><For each={props.rows}>{row => <Button class="question-branch" onClick={event => props.onOpen({ kind: 'page', pageId: row.block.page.id, blockId: row.block.block.kind === 'block' ? row.block.block.id : undefined }, opensBeside(event))}>
      <span class="question-branch-title"><BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /></span>
      <span class="outline-question" data-question-status={row.info.status}><Icon name={row.info.status === 'answered' ? 'question-settled' : 'question-open'} />{questionLabels[row.info.status]}</span>
      <span class="question-branch-count">{row.position_count} {row.position_count === 1 ? 'perspective' : 'perspectives'}</span>
      <span class="question-branch-reading"><Show when={row.current} fallback="No current answer">{current => <><BlockText text={current().text} notebook={props.notebook} interactive={false} /><span class="question-branch-count"> · {current().assessed_on}</span></>}</Show></span>
      <span class="question-branch-count">Revisit {row.review_on ?? 'not set'}</span>
    </Button>}</For>
  </section></Show>;
}

export function AssessmentJournal(props: { questionId: string; doc: PageDocument; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void; onWrite(): void }) {
  const rows = createMemo(() => {
    props.doc.outline.version();
    const result = [];
    for (let index = 0; index < props.doc.outline.size(); index++) {
      const block = props.doc.block(props.doc.outline.idAt(index));
      if (block?.assessment?.question_id === props.questionId) result.push(block);
    }
    return result.sort((a, b) => b.assessment!.state.assessed_on.localeCompare(a.assessment!.state.assessed_on) || b.id.localeCompare(a.id));
  });
  const status = (id: string, accepted: boolean) => {
    if (accepted) return 'Current answer';
    const history = props.doc.block(props.questionId)?.question?.state.reading_history ?? [];
    let decision;
    for (let index = history.length - 1; index >= 0; index--) if (history[index]!.assessment_id === id) { decision = history[index]; break; }
    return decision?.status === 'superseded' ? `Superseded on ${decision.on}` : decision?.status === 'withdrawn' ? `Withdrawn on ${decision.on}` : 'Not accepted';
  };
  const citations = (id: string) => {
    const links: { id: string; text: string }[] = [];
    const visit = (blockId: string) => {
      const block = props.doc.block(blockId);
      if (!block || (blockId !== id && (block.question || block.assessment))) return;
      for (const token of textTokens(block.text)) if (isStableReference(token) && !links.some(link => link.id === token.id)) links.push({ id: token.id!, text: token.value });
      for (const citation of block.citations) links.push({ id: blockId, text: `${props.notebook.lookup(citation.source_id)()?.text ?? 'Passage'} · ${citation.locator || `¶${citation.ordinal + 1}`}` });
      for (const child of props.doc.outline.children(blockId)) visit(child);
    };
    visit(id);
    return links;
  };
  return <Show when={rows().length}><section class="assessment-journal question-branches" aria-label="Decision journal" onMouseDown={event => event.stopPropagation()}>
    <div class="assessment-journal-head"><h3>Decision journal</h3><Button disabled={props.doc.block(props.questionId)?.question?.state.parked} onClick={props.onWrite}>Write assessment</Button></div>
    <Show when={props.doc.block(props.questionId)?.question?.state.parked}><p class="question-branch-count">Resume the question before writing an assessment.</p></Show>
      <For each={rows()}>{block => <article class="assessment-journal-entry" data-assessment-id={block.id}>
        <p class="question-branch-count">{block.assessment!.state.assessed_on} · {status(block.id, block.assessment!.accepted)}<Show when={block.assessment!.state.aporia}> · Aporia</Show></p>
        <Button class="assessment-journal-title" onClick={event => props.onOpen({ kind: 'page', pageId: props.doc.pageId, blockId: block.id }, opensBeside(event))}><BlockText text={block.text.split('\n')[0] ?? ''} notebook={props.notebook} interactive={false} /></Button>
        <div class="assessment-journal-citations"><For each={citations(block.id)}>{link => <Button onClick={event => { const target = props.notebook.lookup(link.id)(); if (target) props.onOpen({ kind: 'page', pageId: target.page_id, blockId: target.kind === 'block' ? target.id : undefined }, opensBeside(event)); }}><BlockText text={link.text} notebook={props.notebook} interactive={false} /></Button>}</For></div>
      </article>}</For>
  </section></Show>;
}
