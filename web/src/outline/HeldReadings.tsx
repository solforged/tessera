import { For, Show, createMemo, createResource } from 'solid-js';
import type { PositionRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { citedSigla } from '../library/sigla';
import { fieldEntryId } from '../table/query';
import { Button } from '../ui/Button';
import { BlockText } from './BlockText';
import { fieldRole } from '../fields/roles';
import { IncomingRelations } from './RelationLines';
import { citedSource } from './references';
import './held-readings.css';

interface HeldReading { row: PositionRow; gist: string | undefined; work: string; source: string | null }
/** A holder's readings lead with their arguments, grouped by their stored subjects. */
export function HeldReadings(props: {
  rows: PositionRow[]; notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}) {
  const [fields] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.fields());
  const names = createMemo(() => new Map((fields()?.fields ?? []).map(field => [field.id, field.name])));
  const readings = createMemo<HeldReading[]>(() => props.rows.map(row => {
    const gist = row.fields.find(field => fieldRole(fields()?.fields.find(definition => definition.id === field.field_id)) === 'standfirst')?.values.map(value => value.text).join('\n');
    const work = row.fields.find(field => names().get(field.field_id)?.trim().toLowerCase() === 'work')?.values.map(value => value.text).join('\n') ?? '';
    return { row, gist, work, source: fieldEntryId(work) };
  }));
  const groups = createMemo(() => {
    const groups = new Map<string | null, HeldReading[]>();
    for (const reading of readings()) {
      const subject = reading.row.subject_id;
      const rows = groups.get(subject) ?? [];
      rows.push(reading); groups.set(subject, rows);
    }
    return [...groups].map(([subject, readings]) => ({ subject, readings }));
  });
  const [counts] = createResource(() => groups().map(group => group.subject).filter(id => id !== null),
    subjects => Promise.all(subjects.map(async subject => [subject, (await props.notebook.api.positions({ subject })).rows.length] as const)));
  const countBySubject = createMemo(() => new Map(counts() ?? []));
  const [sources] = createResource(() => [...new Set(readings().map(reading => reading.source).filter(id => id !== null))],
    ids => Promise.all(ids.map(async id => ({ id, source: await citedSource(props.notebook, id).catch(() => null) }))));
  const sigla = createMemo(() => citedSigla(sources() ?? []));
  return <section class="held-readings" aria-label="Perspectives held">
    <Show when={fields.error}><p class="pane-error" role="alert">Couldn’t load perspective fields.</p></Show>
    <For each={groups()}>{group => <section class="held-subject">
      <header><h2><Show when={group.subject} fallback="Unfiled perspectives">{subject => <Button onClick={event => {
        const block = props.notebook.lookup(subject())();
        if (block) props.onOpen({ kind: 'page', pageId: block.page_id, ...(block.kind === 'block' ? { blockId: block.id } : {}) }, event.shiftKey);
      }}><span><BlockText text={props.notebook.lookup(subject())()?.text ?? 'Loading subject…'} notebook={props.notebook} interactive={false} /></span></Button>}</Show></h2>
        <Show when={group.subject && (countBySubject().get(group.subject) ?? 0) >= 2}><Button class="held-compare" onClick={event => props.onOpen({ kind: 'compare', subjectId: group.subject! }, event.shiftKey)}>Compare</Button></Show>
      </header>
      <For each={group.readings}>{reading => <article class="held-reading">
        <Button class="held-reading-open" title="Open perspective · Shift opens beside" onClick={event => props.onOpen({ kind: 'page', pageId: reading.row.block.page.id, blockId: reading.row.block.block.id }, event.shiftKey)}>
          <Show when={reading.source && sigla().get(reading.source)}>{mark => <span class="held-siglum">{mark()}</span>}</Show>
          <span class="held-reading-title"><BlockText text={reading.gist || 'Perspective without a gist'} notebook={props.notebook} interactive={false} /></span>
          <Show when={reading.work}><span class="held-work"><BlockText text={reading.work} notebook={props.notebook} interactive={false} /></span></Show>
        </Button>
        <IncomingRelations target={reading.row.block.block.id} version={props.notebook.changeSequence()} notebook={props.notebook} onOpen={props.onOpen} />
      </article>}</For>
    </section>}</For>
  </section>;
}
