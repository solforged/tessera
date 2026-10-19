import { opensBeside, listOpensBeside } from '../shell/beside';
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { FieldDefinition, PositionRow, Query, QueryGroup, QueryResult, QueryRow } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { CriteriaMatrix } from '../compare/CriteriaMatrix';
import { fieldRole } from '../fields/roles';
import { citedSigla } from '../library/sigla';
import { createCitedSources } from '../outline/source-reads';
import { BlockText } from '../outline/BlockText';
import { positionRelations, positionSource } from '../outline/perspectives';
import { OutgoingRelations } from '../outline/RelationLines';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { attributeDefinitions } from './attributes';
import { cardFields, defaultEntityColumns, registerMembers, sourceDefinition } from './register';
import { fieldEntryId } from './query';
import { TableGrid } from './TableGrid';
import { ViewValue } from './ViewValue';
import { taskFieldName } from '../tasks/task-fields';
import '../compare/compare.css';
import './view-body.css';

export interface ViewBodyProps {
  query: Query; result: QueryResult; notebook: NotebookClient; neighbour?: boolean;
  onOpen(target: OpenTarget, beside: boolean): void;
  onEdited?(doc: PageDocument): void;
  onUndo?(redo: boolean): void;
  onQueryChange?(query: Query): void;
  /** The managed table supplies its grid; embeds use the same grid directly. */
  table?: () => JSX.Element;
}

/** Recipes share query rows and canonical page documents in every live-view surface. */
export function ViewBody(props: ViewBodyProps) {
  let region!: HTMLDivElement;
  const [error, setError] = createSignal('');
  const [docs, setDocs] = createSignal(new Map<string, PageDocument>());
  const history: PageDocument[] = [], undone: PageDocument[] = [];
  const [fields] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.fields());
  const definitions = createMemo(() => [...new Map([...(fields()?.fields ?? []), ...props.result.fields].map(field => [field.id, field])).values()]);
  const definition = (id: string) => definitions().find(field => field.id === id);
  const rows = createMemo(() => {
    const next = props.result.rows;
    const focusedElement = document.activeElement;
    const active = focusedElement?.closest<HTMLElement>('.view-value, .criteria-cell, .table-cell');
    const row = active?.dataset.positionId ?? active?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
    const field = active?.dataset.fieldId;
    if (active && row && field && region?.contains(active)) queueMicrotask(() => {
      if (focusedElement?.isConnected) return;
      region.querySelector<HTMLElement>(`[data-block-id="${row}"] .view-value[data-field-id="${field}"], .criteria-cell[data-position-id="${row}"][data-field-id="${field}"]`)?.focus({ preventScroll: true });
    });
    return next;
  });
  const rowIds = createMemo(() => rows().map(row => row.block.block.id));
  const rowById = createMemo(() => new Map(rows().map(row => [row.block.block.id, row])));
  const positionLayout = () => props.query.source === 'positions' && (props.query.layout === 'register' || props.query.layout === 'matrix');
  const documentPages = createMemo(() => positionLayout() || !props.table ? [...new Set(rows().map(row => row.block.page.id))].sort().join(',') : '');
  createEffect(() => {
    const opened = new Map(documentPages().split(',').filter(Boolean).map(id => [id, props.notebook.open(id)]));
    setDocs(opened);
    onCleanup(() => { for (const doc of opened.values()) doc.release(); });
  });
  const positions = createMemo<PositionRow[]>(() => positionLayout() ? rows().map(row => {
    const holder = row.attributes?.['@holder']?.[0]?.reading;
    const subject = row.attributes?.['@subject']?.[0]?.reading;
    return {
      block: row.block, holder_id: holder?.ok ? holder.target : null,
      subject_id: subject?.ok ? subject.target ?? row.block.page.id : row.block.page.id,
      fields: Object.entries(row.values).map(([field_id, values]) => ({ field_id, entry_id: '', values: values.map(value => ({ id: value.id, text: value.text })) })),
    };
  }) : []);
  const positionById = createMemo(() => new Map(positions().map(row => [row.block.block.id, row])));
  const subjects = createMemo(() => [...new Set(positions().map(row => row.subject_id))]);
  const [subjectResults] = createResource(() => positionLayout() ? `${subjects().join(',')}:${props.notebook.changeSequence()}` : false,
    () => Promise.all(subjects().map(async subject => [subject, await props.notebook.api.positions({ subject })] as const)));
  const criteria = createMemo(() => new Map((subjectResults() ?? []).map(([id, result]) => [id, result.criteria.fields])));
  const sources = createMemo(() => positions().map(row => {
    const doc = docs().get(row.block.page.id);
    return { id: row.block.block.id, source: doc?.status() === 'ready' ? positionSource(doc, row.block.block.id, id => definition(id)?.name) : fieldEntryId(row.fields.find(field => definition(field.field_id)?.name.trim().toLowerCase() === 'work')?.values[0]?.text ?? '') };
  }));
  const sourceRecords = createCitedSources(props.notebook, () => [...new Set(sources().flatMap(row => row.source ? [row.source] : []))].sort());
  const sigla = createMemo(() => citedSigla(sourceRecords()));
  function edited(doc: PageDocument) {
    history.push(doc); undone.length = 0;
    props.onEdited?.(doc);
  }
  function openRow(row: QueryRow, beside: boolean) {
    if (props.query.source === 'highlights') {
      void props.notebook.api.capabilities(row.block.block.id).then(value => {
        const citation = value.citations?.[0];
        if (!citation) throw new Error('This highlight has no passage.');
        props.onOpen({ kind: 'reader', sourceId: citation.source_id, snapshotId: citation.snapshot_id, citationId: citation.id }, beside);
      }).catch(reason => setError(String(reason)));
    } else props.onOpen({ kind: 'page', pageId: row.block.page.id, ...(row.block.block.kind === 'block' ? { blockId: row.block.block.id } : {}) }, beside);
  }
  async function openTarget(id: string, beside: boolean) {
    const target = props.notebook.lookup(id)() ?? await props.notebook.api.block(id);
    props.onOpen({ kind: 'page', pageId: target.page_id, ...(target.kind === 'block' ? { blockId: id } : {}) }, beside);
  }
  const groups = createMemo<QueryGroup[]>(() => {
    if (props.query.group && props.result.groups?.length) return props.result.groups;
    if (props.query.layout !== 'register') return [];
    const grouped = new Map<string, string[]>();
    for (const row of positions()) grouped.set(row.subject_id, [...grouped.get(row.subject_id) ?? [], row.block.block.id]);
    return [...grouped].map(([id, row_ids]) => ({ key: id, title: props.notebook.lookup(id)()?.text ?? 'Loading subject…', target: id, row_ids, count: row_ids.length }));
  });
  const groupKeys = createMemo(() => groups().map(group => group.key));
  const groupByKey = createMemo(() => new Map(groups().map(group => [group.key, group])));
  const groupedRows = createMemo(() => groups().length ? groups().flatMap(group => group.row_ids.flatMap((id, index) => {
    const row = rowById().get(id);
    return row ? [{ row, group: index === 0 ? group : undefined, hidden: props.query.group?.collapsed?.includes(group.key) ?? false }] : [];
  })) : rows().map(row => ({ row, group: undefined, hidden: false })));
  function toggleGroup(key: string) {
    const group = props.query.group ?? { key: '@subject' };
    const collapsed = group.collapsed ?? [];
    props.onQueryChange?.({ ...props.query, group: { ...group, collapsed: collapsed.includes(key) ? collapsed.filter(id => id !== key) : [...collapsed, key] } });
  }
  function RegisterRow(rowProps: { id: string }) {
    let slip!: HTMLElement;
    const fillStarts = new Map<string, () => void>();
    const row = () => rowById().get(rowProps.id)!;
    const position = () => positionById().get(rowProps.id)!;
    const doc = () => docs().get(row().block.page.id);
    const ordered = createMemo(() => {
      const present = doc()?.status() === 'ready' ? doc()!.outline.children(rowProps.id).flatMap(id => { const field = fieldEntryId(doc()!.block(id)?.text ?? ''); return field && !doc()!.isArchived(id) ? [field] : []; }) : Object.keys(row().values);
      const standfirst = definitions().filter(field => fieldRole(field) === 'standfirst' && (present.includes(field.id) || field.name.trim().toLowerCase() === 'gist')).map(field => field.id);
      const work = definitions().find(field => field.name.trim().toLowerCase() === 'work')?.id;
      return [...new Set([...standfirst, ...(work ? [work] : []), ...criteria().get(position().subject_id) ?? [], ...present])].flatMap(id => { const field = definition(id); return field ? [field] : []; });
    });
    const fieldIds = createMemo(() => ordered().map(field => field.id));
    function fill(field: string, direction: -1 | 1) {
      const next = fieldIds()[fieldIds().indexOf(field) + direction];
      const host = next ? slip.querySelector<HTMLElement>(`.view-value[data-field-id="${next}"]`) : slip.querySelector<HTMLElement>('.view-open-reading');
      host?.focus({ preventScroll: true });
      if (next) fillStarts.get(next)?.();
    }
    return <article ref={slip} class="position-register-row" data-block-id={rowProps.id}>
      <header><span class="compare-siglum">{sigla().get(sources().find(item => item.id === rowProps.id)?.source ?? '') ?? ''}</span><Button class="compare-holder-name" onClick={event => openRow(row(), listOpensBeside(event, !!props.neighbour))}>{position().holder_id ? props.notebook.lookup(position().holder_id!)()?.text ?? 'Loading holder…' : 'Unattributed'}</Button><Button class="view-open-reading" onClick={event => openRow(row(), listOpensBeside(event, !!props.neighbour))}>Open perspective</Button></header>
      <div class="position-field-bed"><For each={fieldIds()}>{id => { const field = () => definition(id)!; return <div class="position-register-field" data-field-role={fieldRole(field())}><Show when={fieldRole(field()) !== 'standfirst'}><span class="position-field-label">{field().name}</span></Show><ViewValue row={row()} field={field()} doc={doc()} notebook={props.notebook} onEdited={edited} onError={setError} onFill={fill} onReady={start => fillStarts.set(id, start)} /></div>; }}</For></div>
      <Show when={doc()?.status() === 'ready'}><OutgoingRelations rows={positionRelations(doc()!, rowProps.id)} notebook={props.notebook} onOpen={props.onOpen} /></Show>
      <div class="position-register-subject">on <Button onClick={event => void openTarget(position().subject_id, opensBeside(event)).catch(reason => setError(String(reason)))}>{props.notebook.lookup(position().subject_id)()?.text ?? 'Loading subject…'}</Button></div>
    </article>;
  }
  const columns = createMemo(() => (props.query.columns?.map(column => column.key) ?? (props.query.source ? defaultEntityColumns(props.query.source, props.result) : props.result.columns)).filter(id => id !== '@title'));
  const allFields = createMemo(() => [...attributeDefinitions(props.query.source), ...definitions()]);
  const tableField = (id: string) => allFields().find(field => field.id === id);
  const sourceField = createMemo(() => sourceDefinition(props.result.columns, definitions()));
  const tableValue = (row: QueryRow, id: string) => <Show when={!id.startsWith('@') || tableField(id) && taskFieldName(tableField(id)!)} fallback={<For each={row.attributes?.[id] ?? []}>{value => <BlockText text={value.text} notebook={props.notebook} onOpen={props.onOpen} />}</For>}><Show when={tableField(id)}>{field => <ViewValue row={row} field={field()} doc={docs().get(row.block.page.id)} notebook={props.notebook} onEdited={edited} onError={setError} />}</Show></Show>;
  const phoneFields = (row: QueryRow) => {
    const selected = props.query.card ?? cardFields(row, columns(), allFields(), sourceField()).map(field => field.id);
    const sorted = props.query.sort.map(key => key.by === 'field' ? key.field! : `@${key.by}`).filter(id => id !== '@title');
    return [...new Set([...selected, ...sorted])].flatMap(id => { const field = tableField(id); return field ? [field] : []; });
  };
  return <div ref={region} class="view-body" data-layout={props.query.layout ?? 'table'} onKeyDown={event => {
    if (event.target instanceof HTMLElement && event.target.closest('.cm-editor,input,textarea,.picker')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      if (props.onUndo) { event.preventDefault(); event.stopPropagation(); props.onUndo(event.shiftKey); return; }
      const source = event.shiftKey ? undone : history; const doc = source.at(-1);
      if (!doc) return;
      event.preventDefault(); event.stopPropagation();
      event.shiftKey ? doc.redo() : doc.undo(); source.pop(); (event.shiftKey ? history : undone).push(doc);
      void doc.flush().catch(reason => setError(String(reason)));
    }
  }}>
    <Show when={error() || fields.error || subjectResults.error}><p class="pane-error" role="alert">{error() || 'Could not load the perspective fields. Reopen the view to try again.'}</p></Show>
    <Switch>
      <Match when={props.query.source === 'positions' && props.query.layout === 'register'}><div class="position-register"><For each={groupKeys()}>{key => { const group = () => groupByKey().get(key)!; return <section><h2 class="view-group-heading"><Button aria-expanded={!props.query.group?.collapsed?.includes(key)} onClick={() => toggleGroup(key)}><Icon name={props.query.group?.collapsed?.includes(key) ? 'right' : 'down'} />{group().title}<span>{group().count}</span></Button></h2><Show when={!props.query.group?.collapsed?.includes(key)}><For each={group().row_ids}>{id => <Show when={rowById().has(id)}><RegisterRow id={id} /></Show>}</For></Show></section>; }}</For></div></Match>
      <Match when={props.query.source === 'positions' && props.query.layout === 'matrix'}><div class="view-matrices"><For each={subjects()}>{subject => <section class="view-subject-matrix"><h2 class="view-group-heading"><Button onClick={event => void openTarget(subject, opensBeside(event)).catch(reason => setError(String(reason)))}>{props.notebook.lookup(subject)()?.text ?? 'Loading subject…'}</Button><span>{positions().filter(row => row.subject_id === subject).length} perspectives</span></h2><Show when={criteria().get(subject)?.length} fallback={<p class="view-empty">{subjectResults.loading ? 'Loading criteria…' : 'This subject has no criteria. Open the subject and choose Edit criteria in Compare.'}</p>}><CriteriaMatrix orientation="holders" rows={positions().filter(row => row.subject_id === subject)} allRows={positions().filter(row => row.subject_id === subject)} criteria={criteria().get(subject) ?? []} questions={[]} notebook={props.notebook} docs={docs()} field={definition} focusedCriterion={null} holder={row => row.holder_id ? props.notebook.lookup(row.holder_id)()?.text ?? 'Loading holder…' : 'Unattributed'} siglum={row => sigla().get(sources().find(item => item.id === row.block.block.id)?.source ?? '') ?? ''} work={row => row.fields.find(field => definition(field.field_id)?.name.trim().toLowerCase() === 'work')?.values.map(value => value.text).join('\n') ?? ''} onOpen={props.onOpen} onEdited={edited} /></Show></section>}</For><Show when={!rowIds().length}><p class="view-empty">No perspectives match this view. Clear its filters to include more.</p></Show></div></Match>
      <Match when={true}><Show when={props.table} fallback={<div class="view-shared-table" style={{ '--table-title-width': `${props.query.columns?.find(column => column.key === '@title')?.width ?? 240}px`, '--table-width': `${(props.query.columns?.find(column => column.key === '@title')?.width ?? 240) + columns().reduce((width, id) => width + (props.query.columns?.find(column => column.key === id)?.width ?? 180), 0)}px` }}><TableGrid neighbour={props.neighbour} rows={groupedRows()} columns={columns()} notebook={props.notebook} field={tableField} fieldName={id => tableField(id)?.name ?? 'Missing field'} columnWidth={id => `${props.query.columns?.find(column => column.key === id)?.width ?? 180}px`} tagged={registerMembers(rows()).taggedGroup} grouped={!!props.query.group} onOpen={openRow} onGroup={toggleGroup} title={row => <BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} cards />} cell={tableValue} cardFields={phoneFields} cardCell={(row, field) => <div class="table-card-field"><span class="table-card-field-name">{field.name}</span>{tableValue(row, field.id)}</div>} /></div>}>{render => render()()}</Show></Match>
    </Switch>
  </div>;
}
