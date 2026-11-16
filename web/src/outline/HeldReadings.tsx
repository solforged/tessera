import { opensBeside, besideHint } from '../core/beside';
import { For, Show, createMemo, createResource } from 'solid-js';
import type { PositionRow } from '../api/types';
import type { WorkshopClient } from '../document/contract';
import type { OpenTarget } from '../core/contract';
import { citedSigla } from '../library/sigla';
import { fieldEntryId } from '../core/field-entry';
import { Button } from '../ui/Button';
import { BlockText } from './BlockText';
import { fieldRole } from '../fields/roles';
import { IncomingRelations } from './RelationLines';
import { createCitedSources } from './source-reads';
import './held-readings.css';

interface HeldReading {
  row: PositionRow;
  gist: string | undefined;
  work: string;
  source: string | null;
}
/** A holder's readings lead with their arguments, grouped by their stored subjects. */
export function HeldReadings(props: {
  rows: PositionRow[];
  workshop: WorkshopClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}) {
  const [fields] = createResource(
    () => props.workshop.changed('fields'),
    () => props.workshop.api.fields(),
  );
  const names = createMemo(() => new Map((fields()?.fields ?? []).map(field => [field.id, field.name])));
  const readings = createMemo<HeldReading[]>(() =>
    props.rows.map(row => {
      const gist = row.fields
        .find(
          field => fieldRole(fields()?.fields.find(definition => definition.id === field.field_id)) === 'standfirst',
        )
        ?.values.map(value => value.text)
        .join('\n');
      const work =
        row.fields
          .find(field => names().get(field.field_id)?.trim().toLowerCase() === 'work')
          ?.values.map(value => value.text)
          .join('\n') ?? '';
      return { row, gist, work, source: fieldEntryId(work) };
    }),
  );
  const groups = createMemo(() => {
    const groups = new Map<string | null, HeldReading[]>();
    for (const reading of readings()) {
      const subject = reading.row.subject_id;
      const rows = groups.get(subject) ?? [];
      rows.push(reading);
      groups.set(subject, rows);
    }
    return [...groups].map(([subject, readings]) => ({ subject, readings }));
  });
  const [counts] = createResource(
    () =>
      groups()
        .map(group => group.subject)
        .filter(id => id !== null),
    subjects =>
      Promise.all(
        subjects.map(
          async subject => [subject, (await props.workshop.api.positions({ subject })).rows.length] as const,
        ),
      ),
  );
  const countBySubject = createMemo(() => new Map(counts() ?? []));
  const sources = createCitedSources(props.workshop, () => [
    ...new Set(
      readings()
        .map(reading => reading.source)
        .filter(id => id !== null),
    ),
  ]);
  const sigla = createMemo(() => citedSigla(sources()));
  return (
    <section class="held-readings" aria-label="Perspectives held">
      <Show when={fields.error}>
        <p class="pane-error" role="alert">
          Couldn’t load perspective fields.
        </p>
      </Show>
      <For each={groups()}>
        {group => (
          <section class="held-subject">
            <header>
              <h2>
                <Show when={group.subject} fallback="Unfiled perspectives">
                  {subject => (
                    <Button
                      onClick={event => {
                        const block = props.workshop.lookup(subject())();
                        if (block)
                          props.onOpen(
                            {
                              kind: 'page',
                              pageId: block.page_id,
                              ...(block.kind === 'block' ? { blockId: block.id } : {}),
                            },
                            opensBeside(event),
                          );
                      }}
                    >
                      <span>
                        <BlockText
                          text={props.workshop.lookup(subject())()?.text ?? 'Loading subject…'}
                          workshop={props.workshop}
                          interactive={false}
                        />
                      </span>
                    </Button>
                  )}
                </Show>
              </h2>
              <Show when={group.subject && (countBySubject().get(group.subject) ?? 0) >= 2}>
                <Button
                  class="held-compare"
                  onClick={event => props.onOpen({ kind: 'compare', subjectId: group.subject! }, opensBeside(event))}
                >
                  Compare
                </Button>
              </Show>
            </header>
            <For each={group.readings}>
              {reading => (
                <article class="held-reading">
                  <Button
                    class="held-reading-open"
                    title={`Open perspective · ${besideHint}`}
                    onClick={event =>
                      props.onOpen(
                        { kind: 'page', pageId: reading.row.block.page.id, blockId: reading.row.block.block.id },
                        opensBeside(event),
                      )
                    }
                  >
                    <Show when={reading.source && sigla().get(reading.source)}>
                      {mark => <span class="held-siglum">{mark()}</span>}
                    </Show>
                    <span class="held-reading-title">
                      <BlockText
                        text={reading.gist || 'Perspective without a gist'}
                        workshop={props.workshop}
                        interactive={false}
                      />
                    </span>
                    <Show when={reading.work}>
                      <span class="held-work">
                        <BlockText text={reading.work} workshop={props.workshop} interactive={false} />
                      </span>
                    </Show>
                  </Button>
                  <IncomingRelations
                    target={reading.row.block.block.id}
                    version={props.workshop.changed('inquiry')}
                    workshop={props.workshop}
                    onOpen={props.onOpen}
                  />
                </article>
              )}
            </For>
          </section>
        )}
      </For>
    </section>
  );
}
