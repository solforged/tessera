import { Show, createMemo, createSignal } from 'solid-js';
import { ulid } from 'ulid';
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
  const choices = createMemo(() => {
    const query = search().trim();
    const items: { id: string | null; name: string; create?: boolean }[] = [{ id: null, name: 'None' }, ...(projects.metadata()?.projects ?? []).map(project => ({ id: project.block_id, name: props.notebook.lookup(project.block_id)()?.text ?? project.state.outcome }))]
      .filter(item => item.name.toLowerCase().includes(query.toLowerCase()));
    // A project can start from the slip that needs it: a name nothing matches exactly becomes a new project page.
    if (query && !items.some(item => item.id && item.name.toLowerCase() === query.toLowerCase())) items.push({ id: null, name: query, create: true });
    return items;
  });
  const choose = async (projectId: string | null, create?: string) => {
    if (busy() || props.disabled) return;
    setBusy(true); setError('');
    try {
      if (create) {
        // A page of that name that is not yet a project becomes one, rather than a second page with the same title.
        const existing = await props.notebook.pageByTitle(create, false);
        projectId = existing ?? ulid();
        const revision = existing ? (await props.notebook.api.block(existing)).revision : 1;
        await props.notebook.commit([
          ...(existing ? [] : [{ op: 'create_page' as const, id: projectId, title: create }]),
          { op: 'set_project', id: projectId, base_revision: revision, project: { status: 'active', outcome: '', deadline: null } },
        ], 'New project');
      }
      const field = projectId ? await ensureField(props.notebook, 'project', 'instance') : projects.metadata()?.fields.find(field => field.name.toLowerCase() === 'project' && field.kind === 'instance');
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
    <Show when={anchor()}>{value => <Picker anchor={value()} label="Project" class="task-condition-popup" query={search()} onQuery={setSearch} placeholder="Find or name a project" items={choices()} key={item => item.create ? `new:${item.name}` : item.id ?? 'none'} busy={busy() || projects.metadata.loading} error={error() || (projects.metadata.error ? String(projects.metadata.error) : '')} disabledReason={() => busy() || props.disabled ? 'Saving…' : undefined} onDismiss={() => { if (!busy()) setAnchor(null); }} onPick={item => { void choose(item.id, item.create ? item.name : undefined); }} row={item => <><Icon name={item.create ? 'plus' : current() === item.id ? 'check' : 'page'} /><span class="picker-text">{item.create ? `New project “${item.name}”` : item.name}</span></>} empty="No matching projects." />}</Show>
  </>;
}
