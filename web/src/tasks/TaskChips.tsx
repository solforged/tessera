import { Show, createMemo, createSignal } from 'solid-js';
import type { TaskPriority, TaskQuery, TaskStatus } from '../api/types';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { chipLabels, dueFields, dueMatches, duePresets, taskPriorities, taskStatuses, withDue, withPriority, withProject, withStatus } from './task-chips';
import type { DueField } from './task-chips';

type ChipKind = 'status' | 'due' | 'project' | 'priority';
interface NamedChoice { id: string | null; name: string }

/**
 * The phone's Tasks filters: Status, Due, Project and Priority, each a capsule that opens a pull-down or, for projects, a
 * short sheet. They edit the same task query as the query line and the condition bar (see task-chips.ts), so the syntax
 * field stays a desktop tool and both read back what the other wrote.
 */
export function TaskChips(props: {
  query: TaskQuery;
  today: string;
  projects: ReadonlyMap<string, string>;
  metadataLoading: boolean;
  metadataError: string;
  disabled: boolean;
  onChange(query: TaskQuery): void;
}) {
  const [popup, setPopup] = createSignal<{ kind: ChipKind; anchor: HTMLElement } | null>(null);
  const [search, setSearch] = createSignal('');
  const labels = createMemo(() => chipLabels(props.query, props.today, id => props.projects.get(id)));
  const update = (query: TaskQuery) => { if (!props.disabled) props.onChange(query); };
  const dismiss = () => setPopup(null);
  const chip = (kind: ChipKind, name: string) => {
    const value = () => labels()[kind];
    return <Button kind="tint" size="sm" class="agenda-chip" classList={{ 'agenda-chip-on': !!value() }} disabled={props.disabled} aria-haspopup={kind === 'project' ? 'dialog' : 'menu'} aria-expanded={popup()?.kind === kind}
      onClick={event => { setSearch(''); setPopup(popup()?.kind === kind ? null : { kind, anchor: event.currentTarget }); }}>{value() ?? name}<Icon name="down" /></Button>;
  };
  const duePage = (field: DueField) => () => ({
    title: dueFields.find(item => item.value === field)!.label,
    items: duePresets.map((preset): MenuItem => ({ label: preset.label, checked: dueMatches(props.query, field, preset.value, props.today), action: () => update(withDue(props.query, field, preset.value, props.today)) })),
  });
  const projects = createMemo((): NamedChoice[] => {
    const needle = search().trim().toLocaleLowerCase();
    return [{ id: null, name: 'Any project' }, ...[...props.projects].map(([id, name]) => ({ id, name })).filter(item => item.name.toLocaleLowerCase().includes(needle))];
  });
  return <div class="agenda-chips" role="group" aria-label="Task filters">
    {chip('status', 'Status')}
    {chip('due', 'Due')}
    {chip('project', 'Project')}
    {chip('priority', 'Priority')}
    <Show keyed when={popup()}>{state => {
      if (state.kind === 'status') return <Menu anchor={state.anchor} label="Task statuses" onDismiss={dismiss} items={[
        { label: 'Any status', checked: !props.query.filter.statuses.length, action: () => update(withStatus(props.query, null)) },
        ...taskStatuses.map(({ value, label }: { value: TaskStatus; label: string }): MenuItem => ({ label, checked: props.query.filter.statuses.includes(value), action: () => update(withStatus(props.query, value)) })),
      ]} />;
      if (state.kind === 'priority') return <Menu anchor={state.anchor} label="Task priority" onDismiss={dismiss} items={[
        { label: 'Any priority', checked: !props.query.filter.priority, action: () => update(withPriority(props.query, null)) },
        ...taskPriorities.map(({ value, label }: { value: TaskPriority; label: string }): MenuItem => ({ label, checked: props.query.filter.priority === value, action: () => update(withPriority(props.query, value)) })),
      ]} />;
      if (state.kind === 'due') return <Menu anchor={state.anchor} label="Task dates" onDismiss={dismiss} items={[
        { label: 'Any date', checked: !props.query.filter.scheduled && !props.query.filter.deadline, action: () => update(withDue(props.query, null, null, props.today)) },
        ...dueFields.map(({ value, label }): MenuItem => ({ label, checked: !!props.query.filter[value], submenu: duePage(value) })),
      ]} />;
      return <Picker<NamedChoice> placement="sheet" autofocus={false} anchor={state.anchor} label="Project" query={search()} onQuery={setSearch} placeholder="Find a project" items={projects()} key={item => item.id ?? 'any'}
        busy={props.metadataLoading} error={props.metadataError} onDismiss={dismiss} onPick={item => { update(withProject(props.query, item.id)); dismiss(); }}
        row={item => <><Icon name={props.query.filter.project_id === item.id ? 'check' : 'page'} /><span class="picker-text">{item.name}</span></>} empty="No matching projects." />;
    }}</Show>
  </div>;
}
