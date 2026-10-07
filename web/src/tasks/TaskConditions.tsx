import { For, Show, createMemo, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { DateRange, FieldDefinition, Filter, Query, TaskFilter, TaskPriority, TaskQuery, TaskSelection, TaskStatus } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { FilterPopup } from '../table/FilterPopup';
import { addFilter, filterLabel, removeFilter, typeQuery } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { DatePicker } from './DatePicker';
import { taskRange } from './query';

interface TaskConditionsProps {
  notebook: NotebookClient;
  query: TaskQuery;
  date: string;
  fields: readonly FieldDefinition[];
  projects: ReadonlyMap<string, string>;
  metadataLoading: boolean;
  metadataError: string;
  disabled: boolean;
  recentInput: string;
  limitInput: string;
  onRecentInput(value: string): void;
  onLimitInput(value: string): void;
  onChange(query: TaskQuery): void;
  children?: JSX.Element;
}

type ConditionKind = 'selection' | 'statuses' | 'priority' | 'project' | 'scheduled' | 'deadline' | 'limit' | 'type' | 'text';
type ConditionChoice = { kind: ConditionKind; section: 'Task' | 'Source'; label: string } | { kind: 'field'; section: 'Fields'; label: string; field: string };
type ConditionPopup =
  | { kind: 'conditions' | ConditionKind; anchor: HTMLElement }
  | { kind: 'range'; anchor: HTMLElement; field: 'scheduled' | 'deadline'; edge: keyof DateRange }
  | { kind: 'field'; anchor: HTMLElement; field: string; edit?: { index: number; filter: Filter } };
type NamedChoice = { id: string | null; name: string };

const conditionChoices: ConditionChoice[] = [
  { kind: 'selection', section: 'Task', label: 'Selection' },
  { kind: 'statuses', section: 'Task', label: 'Status' },
  { kind: 'priority', section: 'Task', label: 'Priority' },
  { kind: 'project', section: 'Task', label: 'Project' },
  { kind: 'scheduled', section: 'Task', label: 'Scheduled' },
  { kind: 'deadline', section: 'Task', label: 'Deadline' },
  { kind: 'limit', section: 'Task', label: 'Result limit' },
  { kind: 'type', section: 'Source', label: 'Type' },
  { kind: 'text', section: 'Source', label: 'Text' },
];
const selectionLabels: Record<TaskSelection, string> = { unfinished: 'Unfinished', unfinished_or_recent: 'Unfinished or recently completed', all: 'All' };
const statusLabels: Record<TaskStatus, string> = { todo: 'Todo', doing: 'Doing', waiting: 'Waiting', done: 'Done', cancelled: 'Cancelled' };
const statuses: TaskStatus[] = ['todo', 'doing', 'waiting', 'done', 'cancelled'];
const priorityLabels = { high: 'High', medium: 'Medium', low: 'Low' };

export function TaskConditions(props: TaskConditionsProps) {
  const [popup, setPopup] = createSignal<ConditionPopup | null>(null);
  const [search, setSearch] = createSignal('');
  const emptySource = typeQuery(null);
  const source = () => props.query.source ?? emptySource;
  const needle = () => search().trim().toLocaleLowerCase();
  const choices = createMemo((): ConditionChoice[] => [
    ...conditionChoices,
    ...props.fields.map((field): ConditionChoice => ({ kind: 'field', section: 'Fields', label: field.name, field: field.id })),
  ].filter(item => `${item.section} ${item.label}`.toLocaleLowerCase().includes(needle())));
  const projects = createMemo((): NamedChoice[] => [{ id: null, name: 'Any project' }, ...[...props.projects].map(([id, name]) => ({ id, name })).filter(item => item.name.toLocaleLowerCase().includes(needle()))]);
  const types = createMemo((): NamedChoice[] => [{ id: null, name: 'Any type' }, ...props.notebook.roots().filter(block => block.kind === 'page' && !block.archived && block.text.toLocaleLowerCase().includes(needle())).map(block => ({ id: block.id, name: block.text }))]);
  const update = (query: TaskQuery) => { if (!props.disabled) props.onChange(query); };
  const updateFilter = (patch: Partial<TaskFilter>) => update({ ...props.query, filter: { ...props.query.filter, ...patch } });
  const updateSource = (value: Query) => update({ ...props.query, source: value.type || value.text?.trim() || value.filters.length ? value : null });
  const open = (next: ConditionPopup) => {
    if (props.disabled) return;
    // Replacement popups retain a connected focus target, not the retired picker input.
    next.anchor.focus({ preventScroll: true });
    setSearch('');
    setPopup(next);
  };
  const recentInput = (text: string) => {
    props.onRecentInput(text);
    const value = Number(text);
    if (Number.isInteger(value) && value >= 1 && value <= 3660) updateFilter({ recent_days: value });
  };
  const limitInput = (text: string) => {
    props.onLimitInput(text);
    const value = Number(text);
    if (!text || Number.isInteger(value) && value >= 1 && value <= 2000) update({ ...props.query, limit: text ? value : null });
  };
  let addButton!: HTMLButtonElement;

  return <div class="task-condition-bar" role="group" aria-label="Task conditions">
    <For each={source().filters}>{(filter, index) => <span class="table-chip task-condition-chip">
      <Button disabled={props.disabled} label={`Edit ${filterLabel(filter, props.fields)}`} aria-haspopup="dialog" onClick={event => open({ kind: 'field', anchor: event.currentTarget, field: filter.field, edit: { index: index(), filter: { ...filter } } })}>{filterLabel(filter, props.fields)}</Button>
      <Button disabled={props.disabled} label={`Remove ${filterLabel(filter, props.fields)}`} onClick={() => updateSource(removeFilter(source(), index()))}>×</Button>
    </span>}</For>
    <Button ref={addButton} class="bordered" disabled={props.disabled} aria-haspopup="dialog" aria-expanded={popup()?.anchor === addButton} onClick={event => popup()?.anchor === addButton ? setPopup(null) : open({ kind: 'conditions', anchor: event.currentTarget })}>Add condition<Icon name="down" /></Button>
    {props.children}
    <Show keyed when={popup()}>{state => {
      const dismiss = () => { if (popup() === state) setPopup(null); };
      if (state.kind === 'conditions') return <Picker<ConditionChoice> class="task-condition-popup" anchor={state.anchor} width={320} label="Add condition" query={search()} onQuery={setSearch} placeholder="Find a condition" items={choices()} section={item => item.section} key={item => item.kind === 'field' ? `field:${item.field}` : item.kind} busy={props.metadataLoading} error={props.metadataError} onDismiss={dismiss} onPick={item => open(item.kind === 'field' ? { kind: 'field', anchor: state.anchor, field: item.field } : { kind: item.kind, anchor: state.anchor })} row={item => <span class="picker-text">{item.label}</span>} empty="No matching conditions." />;
      if (state.kind === 'field') return <FilterPopup anchor={state.anchor} fields={props.fields} initialField={state.field} initialFilter={state.edit?.filter} label={state.edit ? 'Edit condition' : 'Add condition'} onDismiss={dismiss} onAdd={filter => {
        if (props.disabled) return;
        const current = source();
        const edited = state.edit;
        if (edited) {
          const previous = current.filters[edited.index];
          if (!previous || previous.field !== edited.filter.field || previous.op !== edited.filter.op || previous.value !== edited.filter.value) throw new Error('Condition changed. Reopen it to edit.');
        }
        const next = addFilter(current, filter);
        if (edited) next.filters[edited.index] = next.filters.pop()!;
        updateSource(next);
        dismiss();
      }} />;
      if (state.kind === 'selection') return <Menu anchor={state.anchor} label="Task selection" onDismiss={dismiss} header={<div class="task-condition-popup">
        <h2 class="popup-title">Selection</h2>
        <Show when={props.query.filter.selection === 'unfinished_or_recent'}>
          <label class="task-condition-row agenda-number">Recent days<input class="input" type="number" min="1" max="3660" step="1" disabled={props.disabled} value={props.recentInput} onInput={event => recentInput(event.currentTarget.value)} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.stopPropagation(); }} /></label>
          <div class="popup-actions"><Button disabled={props.disabled} onClick={dismiss}>Done</Button></div>
        </Show>
      </div>} items={(['unfinished', 'unfinished_or_recent', 'all'] as TaskSelection[]).map(selection => ({ label: selectionLabels[selection], icon: props.query.filter.selection === selection ? 'check' as const : undefined, disabledReason: props.disabled ? 'Saving task view…' : undefined, action: () => { updateFilter({ selection }); if (selection === 'unfinished_or_recent') open({ ...state }); } }))} />;
      if (state.kind === 'statuses') return <Menu anchor={state.anchor} label="Task statuses" onDismiss={dismiss} items={[
        { label: 'Any status', icon: !props.query.filter.statuses.length ? 'check' : undefined, disabledReason: props.disabled ? 'Saving task view…' : undefined, action: () => updateFilter({ statuses: [] }) },
        ...statuses.map(status => ({ label: statusLabels[status], icon: props.query.filter.statuses.includes(status) ? 'check' as const : undefined, disabledReason: props.disabled ? 'Saving task view…' : undefined, action: () => updateFilter({ statuses: props.query.filter.statuses.includes(status) ? props.query.filter.statuses.filter(value => value !== status) : [...props.query.filter.statuses, status] }) })),
      ]} />;
      if (state.kind === 'priority') return <Menu anchor={state.anchor} label="Task priority" onDismiss={dismiss} items={([null, 'high', 'medium', 'low'] as (TaskPriority | null)[]).map(priority => ({ label: priority ? priorityLabels[priority] : 'Any priority', icon: props.query.filter.priority === priority ? 'check' as const : undefined, disabledReason: props.disabled ? 'Saving task view…' : undefined, action: () => updateFilter({ priority }) }))} />;
      if (state.kind === 'project') return <Picker<NamedChoice> class="task-condition-popup" anchor={state.anchor} width={320} label="Project" query={search()} onQuery={setSearch} placeholder="Find a project" items={projects()} key={item => item.id ?? 'any'} busy={props.metadataLoading} error={props.metadataError} disabledReason={() => props.disabled ? 'Saving task view…' : undefined} onDismiss={dismiss} onPick={item => { updateFilter({ project_id: item.id }); dismiss(); }} row={item => <><Icon name={props.query.filter.project_id === item.id ? 'check' : 'page'} /><span class="picker-text">{item.name}</span></>} empty="No matching projects." />;
      if (state.kind === 'type') return <Picker<NamedChoice> class="task-condition-popup" anchor={state.anchor} width={320} label="Source type" query={search()} onQuery={setSearch} placeholder="Type name" items={types()} key={item => item.id ?? 'any'} disabledReason={() => props.disabled ? 'Saving task view…' : undefined} onDismiss={dismiss} onPick={item => { updateSource({ ...source(), type: item.id }); dismiss(); }} row={item => <><Icon name={source().type === item.id ? 'check' : 'tag'} /><span class="picker-text">{item.name}</span></>} empty="No matching types." />;
      if (state.kind === 'range') return <DatePicker notebook={props.notebook} anchor={state.anchor} label={`${state.field === 'scheduled' ? 'Scheduled' : 'Deadline'} ${state.edge}`} value={props.query.filter[state.field]?.[state.edge] ?? null} contextDate={props.date} onDismiss={dismiss} onSelect={value => { update(taskRange(props.query, state.field, state.edge, value.date)); open({ kind: state.field, anchor: state.anchor }); }} />;
      if (state.kind === 'scheduled' || state.kind === 'deadline') {
        const field = state.kind;
        const title = field === 'scheduled' ? 'Scheduled' : 'Deadline';
        return <Popup class="task-condition-popup" anchor={state.anchor} label={`${title} range`} width={320} fitContent onDismiss={dismiss}>
          <h2 class="popup-title">{title}</h2>
          <For each={['from', 'through'] as const}>{edge => <div class="task-condition-row">
            <span class="task-condition-label">{edge === 'from' ? 'From' : 'Through'}</span>
            <Button class="bordered task-condition-value" disabled={props.disabled} aria-haspopup="dialog" label={`${title} ${edge}: ${props.query.filter[field]?.[edge] ?? 'Any date'}`} onClick={() => open({ kind: 'range', anchor: state.anchor, field, edge })}>{props.query.filter[field]?.[edge] ?? 'Any date'}</Button>
          </div>}</For>
          <div class="popup-actions"><Button disabled={props.disabled} onClick={() => updateFilter({ [field]: null })}>Clear</Button><Button disabled={props.disabled} onClick={dismiss}>Done</Button></div>
        </Popup>;
      }
      const limit = state.kind === 'limit';
      return <Popup class="task-condition-popup" anchor={state.anchor} label={limit ? 'Result limit' : 'Source text'} width={320} fitContent onDismiss={dismiss}>
        <h2 class="popup-title">{limit ? 'Result limit' : 'Source text'}</h2>
        <form noValidate onSubmit={event => { event.preventDefault(); dismiss(); }}>
          {limit
            ? <label class="task-condition-row agenda-number">Result limit<input class="input" type="number" min="1" max="2000" step="1" placeholder="Default" disabled={props.disabled} value={props.limitInput} onInput={event => limitInput(event.currentTarget.value)} /></label>
            : <label class="task-condition-row">Text<input class="input" type="search" aria-label="Search source text" placeholder="Search source text" value={source().text ?? ''} disabled={props.disabled} onInput={event => updateSource({ ...source(), text: event.currentTarget.value || null })} /></label>}
          <div class="popup-actions"><Button disabled={props.disabled} onClick={() => limit ? limitInput('') : updateSource({ ...source(), text: null })}>Clear</Button><Button type="submit" disabled={props.disabled}>Done</Button></div>
        </form>
      </Popup>;
    }}</Show>
  </div>;
}
