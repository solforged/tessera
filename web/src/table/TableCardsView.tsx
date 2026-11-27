import { For, Index, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { FieldDefinition, Filter, Query, QueryRow, SortKey, View } from '../api/types';
import { opensBeside } from '../core/beside';
import type { OpenTarget, PaneId } from '../core/contract';
import type { WorkshopClient } from '../document/contract';
import { fieldLabel } from '../fields/kinds';
import { RequiredGaps } from '../fields/RequiredGaps';
import { NoteFind } from '../notes/NoteFind';
import { taskFieldName } from '../tasks/task-fields';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ListGroup, ListRow } from '../ui/List';
import { InlinePopups, Popup } from '../ui/Popup';
import { SearchWell } from '../ui/SearchWell';
import { sourceName } from './attributes';
import { clampTitleWidth, refsColumn, titleWidthLimits } from './createColumnResize';
import { removeFilter, removeSort } from './query';
import { cardFields } from './register';
import type { TableSource } from './sources';

export function phoneFieldsForRow(params: {
  row: QueryRow;
  query: Query;
  phone: boolean;
  visibleColumns: string[];
  fields: FieldDefinition[];
  sourceField: FieldDefinition | undefined;
  fieldById: (id: string) => FieldDefinition | undefined;
}): FieldDefinition[] {
  const selected =
    params.query.card ??
    (params.phone
      ? params.visibleColumns
      : cardFields(params.row, params.visibleColumns, params.fields, params.sourceField).map(field => field.id));
  const sorted = params.query.sort
    .map(key => (key.by === 'field' ? key.field! : `@${key.by}`))
    .filter(key => key !== '@title');
  return [...new Set([...selected, ...sorted])].flatMap(id => {
    const field = params.fieldById(id);
    return field && !(params.phone && id === params.query.group?.key) ? [field] : [];
  });
}

export function TableCardCell(props: {
  row: QueryRow;
  field: FieldDefinition;
  phone: boolean;
  sourceFieldId: string | undefined;
  groupKey: string | undefined;
  renderValue: (row: QueryRow, id: string, hideCount?: boolean, prose?: boolean) => JSX.Element;
  onStartEdit(row: QueryRow, field: FieldDefinition, anchor: HTMLElement): void;
  onOpenField(row: QueryRow, field: FieldDefinition): void;
}) {
  return (
    <div
      class={`table-card-field table-kind-${props.field.kind}`}
      classList={{
        'property-row': props.phone,
        'table-card-source': props.field.id === props.sourceFieldId,
        'table-card-gloss': props.field.name.trim().toLocaleLowerCase() === 'gloss',
        'table-card-grouped-field': !!props.groupKey && props.field.id === props.groupKey,
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${fieldLabel(props.field)} field`}
      onClick={event => {
        event.stopPropagation();
        if (!(event.target as HTMLElement).closest('button')) {
          if (taskFieldName(props.field)) props.onStartEdit(props.row, props.field, event.currentTarget);
          else if (!props.field.id.startsWith('@')) props.onOpenField(props.row, props.field);
        }
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          if (taskFieldName(props.field)) props.onStartEdit(props.row, props.field, event.currentTarget);
          else if (!props.field.id.startsWith('@')) props.onOpenField(props.row, props.field);
        }
      }}
    >
      <span class="table-card-field-name" classList={{ 'property-label': props.phone }}>
        {fieldLabel(props.field)}
      </span>
      <Show when={props.phone} fallback={props.renderValue(props.row, props.field.id, true)}>
        <span class="property-value">{props.renderValue(props.row, props.field.id, true, true)}</span>
      </Show>
    </div>
  );
}

/** A phone's card ends in its reference count, in a line of its own; the other cards keep the count among their fields. */
export function TableRefsButton(props: {
  sources: TableSource[];
  card: boolean;
  phone: boolean;
  sourceLabel: string;
  onOpenSources(anchor: HTMLElement, label: string, sources: TableSource[]): void;
}) {
  return (
    <Show when={props.sources.length}>
      {count => {
        const button = (
          <Button
            class={`table-source-count${props.card ? ' table-card-refs' : ''}`}
            label={`${count()} ${count() === 1 ? 'reference' : 'references'}`}
            aria-haspopup="dialog"
            onClick={event => {
              event.stopPropagation();
              props.onOpenSources(event.currentTarget, props.sourceLabel, props.sources);
            }}
          >
            {props.card && props.phone ? (
              <>
                <span class="fig">{count()}</span> {count() === 1 ? 'reference' : 'references'}
              </>
            ) : (
              <>
                {count()} {props.card ? (count() === 1 ? 'ref' : 'refs') : ''}
              </>
            )}
          </Button>
        );
        return props.card && props.phone ? <p class="table-card-foot">{button}</p> : button;
      }}
    </Show>
  );
}

export function TablePhoneHead(props: {
  heading: string;
  census: { total: number; noun: string } | undefined;
  changed: boolean;
  purposeShown: boolean;
  purpose: string;
  gaps: { field_id: string; missing: number }[] | undefined;
  definedFieldName: (id: string) => string | undefined;
  onShowMissing: (field: string) => void;
  onPurposeChange: (purpose: string) => void;
}) {
  return (
    <div class="index-head table-phone-head">
      <h1>{props.heading}</h1>
      <Show when={props.census}>
        {value => (
          <span class="index-census">
            <span class="fig">{value().total.toLocaleString()}</span> {value().noun}
            <Show when={props.changed}> · modified</Show>
          </span>
        )}
      </Show>
      <Show when={props.purposeShown}>
        <input
          class="table-purpose"
          aria-label="View purpose"
          placeholder="Add a one-line purpose…"
          value={props.purpose}
          maxlength={240}
          onChange={event => props.onPurposeChange(event.currentTarget.value.trim())}
        />
      </Show>
      <RequiredGaps gaps={props.gaps} name={props.definedFieldName} onShow={props.onShowMissing} />
    </div>
  );
}

export function TableQueryChips(props: {
  ready: boolean;
  query: Query;
  labelSort: (key: SortKey) => string;
  labelFilter: (filter: Filter) => string;
  onUpdateQuery: (next: Query) => void;
}) {
  return (
    <Show when={props.ready && (props.query.sort.length || props.query.filters.length)}>
      <div class="table-query-chips">
        <For each={props.query.sort}>
          {(key, index) => (
            <span class="table-chip">
              <span class="table-sort-priority">{index() + 1}</span>
              {props.labelSort(key)}
              <Show when={index() > 0}>
                <Button
                  label={`Make ${props.labelSort(key)} higher priority`}
                  onClick={() => {
                    const sort = [...props.query.sort];
                    [sort[index() - 1], sort[index()]] = [sort[index()]!, sort[index() - 1]!];
                    props.onUpdateQuery({ ...props.query, sort });
                  }}
                >
                  ←
                </Button>
              </Show>
              <Button
                label={`Remove ${props.labelSort(key)}`}
                onClick={() => props.onUpdateQuery(removeSort(props.query, index()))}
              >
                ×
              </Button>
            </span>
          )}
        </For>
        <For each={props.query.filters}>
          {(filter, index) => (
            <span class="table-chip" title={filter.value ?? undefined}>
              {props.labelFilter(filter)}
              <Button
                label={`Remove ${props.labelFilter(filter)}`}
                onClick={() => props.onUpdateQuery(removeFilter(props.query, index()))}
              >
                ×
              </Button>
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}

export function TablePhoneFind(props: {
  query: Query;
  title: string;
  workshop: WorkshopClient;
  querySheetOpen: boolean;
  chips: JSX.Element;
  onOpenQuerySheet(anchor: HTMLElement): void;
  onSearch(text: string): void;
  onUpdateQuery(next: Query): void;
}) {
  const control = (
    <Button
      kind="plain"
      class="table-phone-control"
      icon="filter"
      label="Table options"
      aria-haspopup="dialog"
      aria-expanded={props.querySheetOpen}
      onClick={event => props.onOpenQuerySheet(event.currentTarget)}
    />
  );
  return (
    <>
      <Show
        when={props.query.note_kind}
        fallback={
          <SearchWell
            class="table-phone-find"
            label={`Find in ${props.title || 'atoms'}`}
            placeholder={`Find in ${props.title || 'atoms'}`}
            value={props.query.text ?? ''}
            onInput={event => {
              const value = event.currentTarget.value;
              props.onSearch(value);
              props.onUpdateQuery({ ...props.query, text: value.trim() || null, offset: 0 });
            }}
          >
            {control}
          </SearchWell>
        }
      >
        <NoteFind query={props.query} plural={props.title} workshop={props.workshop} onChange={props.onUpdateQuery}>
          {control}
        </NoteFind>
      </Show>
      {props.chips}
    </>
  );
}

export function TablePhoneOptions(props: {
  query: Query;
  savedName: string | undefined;
  title: string;
  definitionsLoaded: boolean;
  visibleColumnsCount: number;
  columnsOpen: boolean;
  showLayout: boolean;
  layoutName: string;
  labelSort: (key: SortKey) => string;
  fieldName: (id: string) => string;
  onViewMenu(anchor: HTMLElement): void;
  onSourceMenu(anchor: HTMLElement): void;
  onShowFilter(anchor: HTMLElement): void;
  onSortMenu(anchor: HTMLElement): void;
  onGroupMenu(anchor: HTMLElement): void;
  onLayoutMenu(anchor: HTMLElement): void;
  onToggleColumns(anchor: HTMLElement): void;
  onOpenCardFields(anchor: HTMLElement): void;
}) {
  return (
    <>
      <ListGroup>
        <ListRow
          push
          aria-haspopup="menu"
          value={props.savedName ?? (props.title ? `All ${props.title}` : 'All atoms')}
          onClick={event => props.onViewMenu(event.currentTarget)}
        >
          Views
        </ListRow>
        <ListRow
          push
          aria-haspopup="menu"
          value={sourceName(props.query.source)}
          onClick={event => props.onSourceMenu(event.currentTarget)}
        >
          From
        </ListRow>
      </ListGroup>
      <ListGroup>
        <ListRow
          push
          aria-haspopup="dialog"
          count={props.query.filters.length || undefined}
          onClick={event => props.onShowFilter(event.currentTarget)}
        >
          Filters
        </ListRow>
        <ListRow
          push
          aria-haspopup="menu"
          value={props.query.sort.length ? props.query.sort.map(props.labelSort).join(', ') : undefined}
          onClick={event => props.onSortMenu(event.currentTarget)}
        >
          Sort
        </ListRow>
        <ListRow
          push
          aria-haspopup="menu"
          value={props.definitionsLoaded && props.query.group ? props.fieldName(props.query.group.key) : undefined}
          onClick={event => props.onGroupMenu(event.currentTarget)}
        >
          Group
        </ListRow>
        <Show when={props.showLayout}>
          <ListRow
            push
            aria-haspopup="menu"
            value={props.layoutName}
            onClick={event => props.onLayoutMenu(event.currentTarget)}
          >
            Layout
          </ListRow>
        </Show>
      </ListGroup>
      <ListGroup>
        <ListRow
          push
          aria-haspopup="dialog"
          aria-expanded={props.columnsOpen}
          count={props.visibleColumnsCount}
          onClick={event => props.onToggleColumns(event.currentTarget)}
        >
          Columns
        </ListRow>
        <ListRow push aria-haspopup="dialog" onClick={event => props.onOpenCardFields(event.currentTarget)}>
          Card fields
        </ListRow>
      </ListGroup>
    </>
  );
}

export function TableQueryToolbar(props: {
  query: Query;
  title: string;
  search: string;
  definitionsLoaded: boolean;
  narrow: boolean;
  columnsOpen: boolean;
  showLayout: boolean;
  layoutName: string;
  fieldName: (id: string) => string;
  workshop: WorkshopClient;
  chips: JSX.Element;
  onUpdateQuery(next: Query): void;
  onSearch(text: string): void;
  onSourceMenu(anchor: HTMLElement): void;
  onShowFilter(anchor: HTMLElement): void;
  onSortMenu(anchor: HTMLElement): void;
  onGroupMenu(anchor: HTMLElement): void;
  onLayoutMenu(anchor: HTMLElement): void;
  onToggleColumns(anchor: HTMLElement): void;
  onOpenCardFields(anchor: HTMLElement): void;
  onSaveView?(anchor: HTMLElement): void;
}) {
  const controls = () => (
    <>
      <Button
        class="bordered table-filter-button"
        aria-haspopup="dialog"
        onClick={event => props.onShowFilter(event.currentTarget)}
      >
        Filters
        <Show when={props.query.filters.length}>
          <span class="table-control-count">{props.query.filters.length}</span>
        </Show>
      </Button>
      <Button class="bordered" aria-haspopup="menu" onClick={event => props.onSortMenu(event.currentTarget)}>
        Sort <Icon name="down" />
      </Button>
      <Button class="bordered" aria-haspopup="menu" onClick={event => props.onGroupMenu(event.currentTarget)}>
        Group
        <Show when={props.definitionsLoaded && props.query.group}>: {props.fieldName(props.query.group!.key)}</Show>{' '}
        <Icon name="down" />
      </Button>
      <Show when={props.showLayout}>
        <Button class="bordered" aria-haspopup="menu" onClick={event => props.onLayoutMenu(event.currentTarget)}>
          Layout: {props.layoutName} <Icon name="down" />
        </Button>
      </Show>
      <Button
        class="bordered table-columns-button"
        aria-haspopup="dialog"
        aria-expanded={props.columnsOpen}
        onClick={event => props.onToggleColumns(event.currentTarget)}
      >
        Columns <Icon name="down" />
      </Button>
      <Show when={props.query.note_kind && props.onSaveView}>
        <Button class="bordered" onClick={event => props.onSaveView!(event.currentTarget)}>
          Save as view…
        </Button>
      </Show>
      <Show when={props.narrow}>
        <Button class="bordered" aria-haspopup="dialog" onClick={event => props.onOpenCardFields(event.currentTarget)}>
          Card fields <Icon name="down" />
        </Button>
      </Show>
    </>
  );
  return (
    <>
      <Show
        when={props.query.note_kind}
        fallback={
          <div class="table-toolbar">
            <Button
              class="bordered table-chip"
              aria-haspopup="menu"
              onClick={event => props.onSourceMenu(event.currentTarget)}
            >
              From {sourceName(props.query.source)} <Icon name="down" />
            </Button>
            <input
              class="input table-search"
              placeholder="Search rows…"
              aria-label="Search rows"
              value={props.search}
              onInput={event => props.onSearch(event.currentTarget.value)}
            />
            <div class="table-query-controls">{controls()}</div>
          </div>
        }
      >
        <NoteFind query={props.query} plural={props.title} workshop={props.workshop} onChange={props.onUpdateQuery}>
          {controls()}
        </NoteFind>
      </Show>
      {props.chips}
    </>
  );
}

export function TableColumnsPopup(props: {
  pane: PaneId;
  anchor: HTMLElement;
  cards: boolean;
  query: Query;
  columnSearch: string;
  onColumnSearch(value: string): void;
  columnChoices: FieldDefinition[];
  visibleColumns: string[];
  sourceField: FieldDefinition | undefined;
  showRefs: boolean;
  titleWidth: number;
  onSetTitleWidth(width: number): void;
  recipeColumns: () => { key: string; width?: number }[];
  onShowField(id: string, visible: boolean): void;
  onUpdateQuery(next: Query): void;
  onAddColumnMenu(anchor: HTMLElement): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onDismiss(): void;
}) {
  return (
    <Popup
      anchor={props.anchor}
      label={props.cards ? 'Card fields' : 'Columns'}
      class="table-columns-popup"
      onDismiss={props.onDismiss}
      width={280}
    >
      <Show when={!props.cards}>
        <div class="table-popup-heading">Columns</div>
        <div class="table-popup-note">Visibility in this register</div>
        <div class="table-column-choice table-column-fixed">
          <Icon name="check" />
          Title<span class="table-column-fixed-note">Always visible</span>
        </div>
        <input
          class="input"
          aria-label="Find columns"
          placeholder="Find columns…"
          value={props.columnSearch}
          onInput={event => props.onColumnSearch(event.currentTarget.value)}
        />
        <Button
          onClick={() => props.onUpdateQuery({ ...props.query, columns: [{ key: '@title', width: props.titleWidth }] })}
        >
          Title only
        </Button>
        <Show when={props.columnSearch.trim() && props.columnChoices.length}>
          <Button
            onClick={() => {
              const ids = new Set(props.columnChoices.map(field => field.id));
              const columns = props.recipeColumns().filter(column => column.key === '@title' || ids.has(column.key));
              for (const field of props.columnChoices)
                if (!columns.some(column => column.key === field.id)) columns.push({ key: field.id, width: undefined });
              props.onUpdateQuery({ ...props.query, columns });
            }}
          >
            Only these
          </Button>
        </Show>
        <Index each={props.columnChoices}>
          {field => (
            <label class="table-column-choice">
              <input
                type="checkbox"
                checked={props.visibleColumns.includes(field().id)}
                onChange={event => props.onShowField(field().id, event.currentTarget.checked)}
              />
              {fieldLabel(field())}
            </label>
          )}
        </Index>
        <Show when={props.sourceField}>
          {field => (
            <label class="table-column-choice">
              <input
                type="checkbox"
                checked={props.showRefs}
                onChange={event => props.onShowField(refsColumn, event.currentTarget.checked)}
              />
              Refs<span class="table-column-fixed-note">From {fieldLabel(field())}</span>
            </label>
          )}
        </Show>
        <label class="table-width-control" for={`table-title-width-${props.pane}`}>
          <span>
            Title width <output>{props.titleWidth} px</output>
          </span>
          <input
            id={`table-title-width-${props.pane}`}
            type="range"
            min={titleWidthLimits.min}
            max={titleWidthLimits.max}
            value={props.titleWidth}
            onInput={event => {
              const width = clampTitleWidth(event.currentTarget.valueAsNumber);
              props.onSetTitleWidth(width);
              const columns = props.recipeColumns();
              columns.find(column => column.key === '@title')!.width = width;
              props.onUpdateQuery({ ...props.query, columns });
            }}
          />
        </label>
      </Show>
      <div class="table-popup-heading">Card fields</div>
      <p class="table-popup-note">Sort fields are always shown.</p>
      <Index each={props.columnChoices}>
        {field => (
          <label class="table-column-choice">
            <input
              type="checkbox"
              checked={props.query.card?.includes(field().id) ?? false}
              onChange={event =>
                props.onUpdateQuery({
                  ...props.query,
                  card: event.currentTarget.checked
                    ? [...(props.query.card ?? []), field().id]
                    : (props.query.card ?? []).filter(id => id !== field().id),
                })
              }
            />
            {fieldLabel(field())}
          </label>
        )}
      </Index>
      <Show when={props.query.type}>
        <div class="table-template-actions">
          <Button onClick={() => props.onAddColumnMenu(props.anchor)}>Add field to tag template…</Button>
          <Button onClick={event => props.onOpen({ kind: 'page', pageId: props.query.type! }, opensBeside(event))}>
            Open tag template
          </Button>
        </div>
      </Show>
    </Popup>
  );
}

export function TableQuerySheet(props: {
  anchor: HTMLElement;
  phone: boolean;
  hasPopup: boolean;
  saved: View | undefined;
  title: string;
  changed: boolean;
  savingView: boolean;
  toolbar: JSX.Element;
  phoneOptions: JSX.Element;
  popups: JSX.Element;
  onClearPopup(): void;
  onDismissSheet(): void;
  onRevert(view: View): void;
  onSaveChanges(): void;
}) {
  return (
    <Popup
      anchor={props.anchor}
      placement="sheet"
      label={props.phone ? 'Table options' : 'Query'}
      title={props.phone ? 'Table options' : undefined}
      class="table-query-sheet"
      onDismiss={() => {
        const editing = props.phone && props.hasPopup;
        props.onClearPopup();
        if (!editing) props.onDismissSheet();
      }}
    >
      <Show
        when={props.phone}
        fallback={
          <>
            <div class="table-popup-heading">Query</div>
            <p class="table-popup-note">{props.saved?.name ?? props.title}</p>
            {props.toolbar}
          </>
        }
      >
        <Show when={props.hasPopup} fallback={props.phoneOptions}>
          <button type="button" class="table-sheet-back" onClick={props.onClearPopup}>
            <Icon name="left" />
            <span>Table options</span>
          </button>
        </Show>
      </Show>
      <Show when={props.phone}>
        <InlinePopups>{props.popups}</InlinePopups>
      </Show>
      <Show when={!(props.phone && props.hasPopup) && (!props.phone || (props.saved && props.changed))}>
        <div class="popup-actions">
          <Show when={props.saved && props.changed}>
            <Button
              kind={props.phone ? 'plain' : undefined}
              onClick={() => {
                if (props.saved) props.onRevert(props.saved);
              }}
            >
              Revert changes
            </Button>
            <Button
              kind={props.phone ? 'stamp' : undefined}
              class="bordered"
              disabled={props.savingView}
              onClick={props.onSaveChanges}
            >
              Save changes
            </Button>
          </Show>
          <Show when={!props.phone}>
            <Button class="bordered" onClick={props.onDismissSheet}>
              Done
            </Button>
          </Show>
        </div>
      </Show>
    </Popup>
  );
}
