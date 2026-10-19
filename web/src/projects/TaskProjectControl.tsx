import { createMemo, createSignal } from 'solid-js';
import { ulid } from 'ulid';
import type { NotebookClient, PageDocument } from '../document/contract';
import { ensureField } from '../outline/source-fields';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { createTaskProjects } from './task-project';

export function TaskProjectPicker(props: { notebook: NotebookClient; doc: PageDocument; id: string; anchor: PopupAnchor; disabled?: boolean; onDismiss(): void; onSaved?(): void | Promise<void> }) {
  const projects = createTaskProjects(props.doc, props.notebook);
  const [search, setSearch] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const current = () => projects.project(props.id);
  const choices = createMemo(() => {
    const query = search().trim();
    const items: { id: string | null; name: string; create?: boolean }[] = [{ id: null, name: 'None' }, ...(projects.metadata.error ? [] : projects.metadata()?.projects ?? []).map(project => ({ id: project.block_id, name: props.notebook.lookup(project.block_id)()?.text ?? project.state.outcome }))]
      .filter(item => item.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.id === null ? -1 : b.id === null ? 1 : a.name.localeCompare(b.name));
    if (query && !items.some(item => item.id && item.name.toLowerCase() === query.toLowerCase())) items.push({ id: null, name: query, create: true });
    return items;
  });
  const choose = async (projectId: string | null, create?: string) => {
    if (busy() || props.disabled) return;
    setBusy(true); setError('');
    try {
      if (create) {
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
        if (field.kind !== 'instance') throw new Error('Project must be a relation field.');
        const result = props.doc.edit({ kind: 'taskProject', id: props.id, fieldId: field.id, projectId });
        if (!result.ok) throw new Error(result.reason);
        await props.doc.flush();
        await props.onSaved?.();
      }
      props.onDismiss();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <Picker anchor={props.anchor} label="Project" class="task-condition-popup" query={search()} onQuery={setSearch} placeholder="Find or name a project" empty="No matching projects." items={choices()} key={item => item.create ? `new:${item.name}` : item.id ?? 'none'} busy={busy() || projects.metadata.loading} error={error() || (projects.metadata.error ? String(projects.metadata.error) : '')} disabledReason={() => busy() || props.disabled ? 'Saving…' : undefined} onDismiss={() => { if (!busy()) props.onDismiss(); }} onPick={item => { void choose(item.id, item.create ? item.name : undefined); }} row={item => <><Icon name={item.create ? 'plus' : current() === item.id ? 'check' : 'page'} /><span class="picker-text">{item.create ? `New project “${item.name}”` : item.name}</span></>} />;
}

