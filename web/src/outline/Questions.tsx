import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import type { QuestionInfo, QuestionRow, QuestionStatus } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { BlockText } from './BlockText';
import { foldName, plainText } from './names';

export const questionLabels: Record<QuestionStatus, string> = { open: 'Open', answered: 'Answered', parked: 'Parked', unsettled: 'Unsettled' };

export function QuestionParent(props: { info: QuestionInfo | null | undefined; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void; onChange(anchor: HTMLElement): void; onRemove(): void; disabled: boolean }) {
  const parent = createMemo(() => props.info?.parent_id ? props.notebook.lookup(props.info.parent_id)() : null);
  return <Show when={parent()}>{block => <div class="question-parent" onMouseDown={event => event.stopPropagation()}>
    <span>Part of</span><Button class="question-parent-name" onClick={event => props.onOpen({ kind: 'page', pageId: block().page_id, blockId: block().kind === 'block' ? block().id : undefined }, event.shiftKey)}><BlockText text={block().text} notebook={props.notebook} interactive={false} /></Button>
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
    <h3>Branches</h3><For each={props.rows}>{row => <Button class="question-branch" onClick={event => props.onOpen({ kind: 'page', pageId: row.block.page.id, blockId: row.block.block.kind === 'block' ? row.block.block.id : undefined }, event.shiftKey)}>
      <span class="question-branch-title"><BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /></span>
      <span class="outline-question" data-question-status={row.info.status}><Icon name={row.info.status === 'answered' ? 'question-settled' : 'question-open'} />{questionLabels[row.info.status]}</span>
      <span class="question-branch-count">{row.position_count} {row.position_count === 1 ? 'position' : 'positions'}</span>
    </Button>}</For>
  </section></Show>;
}
