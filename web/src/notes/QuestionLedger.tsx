import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { QuestionFilter, QuestionRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { BlockText } from '../outline/BlockText';
import { questionLabels } from '../outline/Questions';
import { Button } from '../ui/Button';
import { createSettledChanges } from '../ui/loading';

const tabs = ['Active', 'Recurrent', 'Due', 'Answered', 'Parked', 'All'] as const;
export function QuestionLedger(props: { notebook: NotebookClient; newQuestion?(members: { id: string }[]): JSX.Element; onActivate(): void; onOpen(target: OpenTarget, beside: boolean): void }) {
  const [tab, setTab] = createSignal<typeof tabs[number]>('Active');
  const changes = createSettledChanges(props.notebook);
  const [all] = createResource(changes, () => props.notebook.api.questions({ include_inline: true }));
  const [questions] = createResource(() => [tab(), changes()] as const, ([state]) => props.notebook.api.questions({ include_inline: true, ...(state === 'All' ? {} : { state: state.toLowerCase() as QuestionFilter }) }));
  const programs = createMemo(() => {
    const byId = new Map((all() ?? []).map(row => [row.block.block.id, row]));
    const groups = new Map<string, { program: QuestionRow; rows: QuestionRow[] }>();
    for (const row of questions() ?? []) {
      let program = row;
      const seen = new Set<string>();
      while (program.info.parent_id && !seen.has(program.block.block.id)) {
        seen.add(program.block.block.id);
        const parent = byId.get(program.info.parent_id);
        if (!parent) break;
        program = parent;
      }
      const id = program.block.block.id;
      const group = groups.get(id) ?? { program, rows: [] };
      group.rows.push(row); groups.set(id, group);
    }
    return [...groups.values()].map(group => {
      const id = group.program.block.block.id;
      group.rows.sort((a, b) => Number(b.block.block.id === id) - Number(a.block.block.id === id) || a.block.block.text.localeCompare(b.block.block.text));
      return group;
    }).sort((a, b) => a.program.block.block.text.localeCompare(b.program.block.block.text));
  });
  const open = (row: QuestionRow, event: MouseEvent) => props.onOpen({ kind: 'page', pageId: row.block.page.id, blockId: row.block.block.kind === 'block' ? row.block.block.id : undefined }, event.shiftKey);
  return <div class="index-pane question-ledger" role="region" tabIndex={0} aria-label="Questions index" onFocusIn={props.onActivate}><div class="index-sheet">
    <p class="index-eyebrow">Inquiry ledger</p><div class="index-head"><h1>Questions</h1><span class="index-tally">{questions()?.length ?? 0} of {all()?.length ?? 0} questions</span></div>
    <Show when={all()}>{rows => props.newQuestion?.(rows().filter(row => row.block.block.kind === 'page').map(row => ({ id: row.block.block.id })))}</Show>
    <div class="mode-tabs tab-strip" role="tablist" aria-label="Question state"><For each={tabs}>{state => <Button role="tab" aria-selected={tab() === state} onClick={() => setTab(state)}>{state}</Button>}</For></div>
    <Show when={questions.error || all.error}><p class="error" role="alert">Couldn't load questions · {String(questions.error || all.error)}</p></Show>
    <Show when={questions.loading && !questions()}><p class="empty-state">Loading questions…</p></Show>
    <Show when={!questions.loading && !questions.error && !questions()?.length}><p class="empty-state">No {tab() === 'All' ? '' : `${tab().toLowerCase()} `}questions.</p></Show>
    <For each={programs()}>{group => <section class="question-program"><Show when={!group.rows.some(row => row.block.block.id === group.program.block.block.id)}><h2><Button onClick={event => open(group.program, event)}><BlockText text={group.program.block.block.text} notebook={props.notebook} interactive={false} /></Button></h2></Show>
      <For each={group.rows}>{row => <article class="question-ledger-row" data-question-id={row.block.block.id} data-branch={row.block.block.id !== group.program.block.block.id}>
        <Button class="question-ledger-title" onClick={event => open(row, event)}><BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /></Button>
        <Show when={row.block.block.kind === 'block'}><p class="question-ledger-context">In <BlockText text={row.block.page.text} notebook={props.notebook} interactive={false} /> · Inline question</p></Show>
        <p class="index-apparatus">{questionLabels[row.info.status]} · {row.position_count} {row.position_count === 1 ? 'reading' : 'readings'} · Revisit {row.review_on ?? 'not set'}</p>
        <p class="question-ledger-reading"><Show when={row.current} fallback="No current reading">{current => <><BlockText text={current().text} notebook={props.notebook} interactive={false} /><span class="index-apparatus"> · {current().assessed_on}</span></>}</Show></p>
      </article>}</For>
    </section>}</For>
  </div></div>;
}
