import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { PageDocument, NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { BlockText } from './BlockText';
import type { ReadingRegister as Register } from './read-register';
import type { ReadingField } from './read-register';
import { isReadingSubject, readingCounts } from './read-register';

export function ReadRegister(props: { register: Register; doc: PageDocument; notebook: NotebookClient; disclosures: ReadonlySet<string>; onDisclosure(key: string): void; row(id: string): JSX.Element; onCompare(): void; onAddReading(anchor: HTMLElement): void; onOpenReading(id: string, beside: boolean): void }) {
  const values = (fields: ReadingField[]) => fields.flatMap(field => props.doc.outline.children(field.entryId).filter(id => !props.doc.isArchived(id)));
  return <div class="reading-register">
    <div class="reading-opening"><For each={props.register.opening}>{props.row}</For></div>
      <Show when={props.register.sectionId}>{id => props.row(id())}</Show>
      <Show when={isReadingSubject(props.doc)}><div class="reading-register-actions"><span>{readingCounts(props.register.slips)}</span><Button disabled={props.register.slips.length < 2} onClick={props.onCompare}>Compare</Button><Button onClick={event => props.onAddReading(event.currentTarget)}>Add reading</Button><Show when={props.register.slips.length < 2}><span>Compare needs two readings.</span></Show></div></Show>
    <Show when={props.register.slips.length}>
      <div class="reading-slips"><For each={props.register.slips}>{slip => <article class="reading-slip" data-reading-id={slip.id}>
        <div class="reading-holder">{props.row(slip.id)}</div>
        <div class="reading-gist"><For each={values(slip.gist)}>{props.row}</For><Show when={!slip.gist.length}><span class="empty-state">No gist yet</span></Show></div>
        <div class="reading-work"><For each={values(slip.work)}>{props.row}</For></div>
        <Show when={slip.account.length}><div class="reading-account"><span class="relation-label">Account</span><For each={values(slip.account)}>{props.row}</For></div></Show>
        <div class="reading-field-prose"><For each={values(slip.prose)}>{props.row}</For></div>
        <div class="reading-relations"><For each={slip.relations}>{props.row}</For></div>
        <div class="reading-disclosures"><Show when={slip.passages.length}><Button aria-expanded={props.disclosures.has(`${slip.id}:prose`)} onClick={() => props.onDisclosure(`${slip.id}:prose`)}>Prose</Button></Show><Show when={slip.facts.length}><Button aria-expanded={props.disclosures.has(`${slip.id}:facts`)} onClick={() => props.onDisclosure(`${slip.id}:facts`)}>Facts</Button></Show><Button title="Open this reading · Shift to open beside" onClick={event => props.onOpenReading(slip.id, event.shiftKey)}>Open reading</Button></div>
        <Show when={props.disclosures.has(`${slip.id}:prose`)}><div class="reading-prose"><For each={slip.passages}>{props.row}</For></div></Show>
        <Show when={props.disclosures.has(`${slip.id}:facts`)}><div class="reading-facts"><For each={slip.facts}>{field => <div><span class="relation-label">{field.name}</span><For each={values([field])}>{props.row}</For></div>}</For></div></Show>
      </article>}</For></div>
    </Show>
    <Show when={props.register.disagreements.length}><section class="reading-disagreements" aria-label="Where they disagree"><h2>Where they disagree</h2><For each={props.register.disagreements}>{group => <div class="reading-criterion"><h3>{props.notebook.lookup(group.criterion)()?.text ?? 'Loading criterion…'}</h3><For each={group.questions}>{question => <div class="reading-disagreement">{props.row(question.id)}<div class="reading-question-holders"><For each={question.holders}>{id => <span><BlockText text={`[[${id}]]`} notebook={props.notebook} interactive={false} /></span>}</For><Show when={!question.holders.length}>All holders</Show></div></div>}</For></div>}</For></section></Show>
    <For each={props.register.remaining}>{props.row}</For>
  </div>;
}
