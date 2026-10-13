import { Show, createMemo, createSignal } from 'solid-js';
import type { NotebookClient, PageDocument } from '../document/contract';
import { ensureField } from '../outline/source-fields';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { createTaskProjects } from './task-project';

export function TaskProjectControl(props: { notebook: NotebookClient; doc: PageDocument; id: string; disabled?: boolean }) {
  const projects = createTaskProjects(props.doc, props.notebook);
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const [search, setSearch] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const current = () => projects.project(props.id);
  const title = () => { const id = current(); return id ? props.notebook.lookup(id)()?.text ?? 'Project' : 'None'; };
  const choices = createMemo(() => [{ id: null as string | null, name: 'None' }, ...(projects.metadata()?.projects ?? []).map(project => ({ id: project.block_id, name: props.notebook.lookup(project.block_id)()?.text ?? project.state.outcome }))].filter(item => item.name.toLowerCase().includes(search().trim().toLowerCase())));
  const choose = async (projectId: string | null) => {
    if (busy() || props.disabled) return;
    setBusy(true); setError('');
    try {
      const field = projectId ? await ensureField(props.notebook, 'Project', 'instance') : projects.metadata()?.fields.find(field => field.name.toLowerCase() === 'project' && field.kind === 'instance');
      if (field) {
        if (field.kind !== 'instance') throw new Error('Project must be an instance field.');
        const result = props.doc.edit({ kind: 'taskProject', id: props.id, fieldId: field.id, projectId });
        if (!result.ok) throw new Error(result.reason);
        await props.doc.flush();
      }
      setAnchor(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <>
    <Button class="task-metadata task-planning-row" label={`Project: ${title()}`} disabled={props.disabled || busy()} aria-haspopup="dialog" aria-expanded={!!anchor()} onClick={event => { setSearch(''); setError(''); setAnchor(event.currentTarget); }}>
      <span class="task-planning-label">Project</span><span class="task-metadata-value task-planning-value" classList={{ 'task-planning-empty': !current() }}>{title()}</span>
    </Button>
    <Show when={anchor()}>{value => <Picker anchor={value()} label="Project" class="task-condition-popup" query={search()} onQuery={setSearch} placeholder="Find a project" items={choices()} key={item => item.id ?? 'none'} busy={busy() || projects.metadata.loading} error={error() || (projects.metadata.error ? String(projects.metadata.error) : '')} disabledReason={() => busy() || props.disabled ? 'Saving…' : undefined} onDismiss={() => { if (!busy()) setAnchor(null); }} onPick={item => { void choose(item.id); }} row={item => <><Icon name={current() === item.id ? 'check' : 'page'} /><span class="picker-text">{item.name}</span></>} empty="No matching projects." />}</Show>
  </>;
}
