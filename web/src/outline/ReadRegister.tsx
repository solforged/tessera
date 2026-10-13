import { opensBeside, besideHint } from '../shell/beside';
import { For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { PageDocument, NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import type { ReadingRegister as Register } from './read-register';
import type { ReadingField } from './read-register';
import { isReadingSubject, readingCounts } from './read-register';

export function ReadRegister(props: { register: Register; doc: PageDocument; notebook: NotebookClient; disclosures: ReadonlySet<string>; onDisclosure(key: string): void; row(id: string): JSX.Element; onCompare(): void; onAddReading(anchor: HTMLElement): void; onOpenReading(id: string, beside: boolean): void; siglum(positionId: string): string | undefined }) {
  const values = (fields: readonly Pick<ReadingField, 'entryId'>[]) => fields.flatMap(field => props.doc.outline.children(field.entryId).filter(id => !props.doc.isArchived(id)));
  // A refreshed projection must not replace a reading's live editor.
  const slips = createMemo(() => new Map(props.register.slips.map(slip => [slip.id, slip])));
  const slipIds = createMemo(() => [...slips().keys()]);
  const holderName = (positionId: string) => { const holder = slips().get(positionId)?.holderId; return holder ? props.notebook.lookup(holder)()?.text ?? '' : 'Unattributed'; };
  return <div class="reading-register">
    <div class="reading-opening"><For each={props.register.opening}>{props.row}</For></div>
    <div class="reading-section-head">
      <Show when={props.register.sectionId} fallback={<Show when={props.register.slips.length}><h2 class="reading-register-heading">Perspectives</h2></Show>}>{id => props.row(id())}</Show>
      <Show when={isReadingSubject(props.doc)}><div class="reading-register-actions"><span class="reading-counts">{readingCounts(props.register.slips)}</span><Show when={props.register.slips.length > 1}><Button onClick={props.onCompare}>Compare</Button></Show><Button onClick={event => props.onAddReading(event.currentTarget)}>Add perspective</Button></div></Show>
    </div>
    <Show when={props.register.slips.length}>
      <div class="reading-slips"><For each={slipIds()}>{id => {
        const slip = () => slips().get(id)!;
        return <article class="reading-slip" data-reading-id={id}>
        <div class="reading-holder">{props.row(id)}</div>
        <div class="reading-gist"><For each={values(slip().gist)}>{props.row}</For><Show when={!slip().gist.length}><span class="empty-state">No gist yet</span></Show></div>
        <div class="reading-work"><For each={values(slip().work)}>{props.row}</For></div>
        <Show when={slip().account.length}><div class="reading-account"><span class="relation-label">Account</span><For each={values(slip().account)}>{props.row}</For></div></Show>
        <div class="reading-field-prose"><For each={values(slip().prose)}>{props.row}</For></div>
        <div class="reading-relations"><For each={slip().relations}>{props.row}</For></div>
        <div class="reading-disclosures"><Show when={slip().passages.length}><Button aria-expanded={props.disclosures.has(`${id}:prose`)} onClick={() => props.onDisclosure(`${id}:prose`)}>Prose</Button></Show><Show when={slip().facts.length}><Button aria-expanded={props.disclosures.has(`${id}:facts`)} onClick={() => props.onDisclosure(`${id}:facts`)}>Facts</Button></Show><Button class="reading-open" title={`Open this perspective · ${besideHint}`} onClick={event => props.onOpenReading(id, opensBeside(event))}>Open perspective</Button></div>
        <Show when={props.disclosures.has(`${id}:prose`)}><div class="reading-prose"><For each={slip().passages}>{props.row}</For></div></Show>
        <Show when={props.disclosures.has(`${id}:facts`)}><div class="reading-facts"><For each={slip().facts.map(field => field.entryId)}>{entryId => <div><span class="relation-label">{slip().facts.find(field => field.entryId === entryId)?.name}</span><For each={values([{ entryId }])}>{props.row}</For></div>}</For></div></Show>
      </article>;
      }}</For></div>
    </Show>
    <Show when={props.register.disagreements.length}><section class="reading-disagreements" aria-label="Where they disagree"><h2>Where they disagree</h2>
      {/* The question links its criterion, so each group leads with its questions and the readings answer beneath. */}
      <For each={props.register.disagreements}>{group => <div class="reading-criterion" role="group" aria-label={props.notebook.lookup(group.criterion)()?.text ?? 'Criterion'}>
        <For each={group.questions}>{question => <div class="reading-disagreement">{props.row(question.id)}</div>}</For>
        <div class="reading-answers"><For each={group.answers}>{answer => {
          const rows = () => answer.entryId ? values([{ entryId: answer.entryId }]) : [];
          return <div class="reading-answer">
            <span class="reading-answer-holder" title={holderName(answer.slipId)}>{props.siglum(answer.slipId) ?? holderName(answer.slipId)}</span>
            <div class="reading-answer-value"><Show when={rows().length} fallback={<span class="reading-answer-empty">Not stated</span>}><For each={rows()}>{props.row}</For></Show></div>
          </div>;
        }}</For></div>
      </div>}</For>
    </section></Show>
    <For each={props.register.remaining}>{props.row}</For>
  </div>;
}
