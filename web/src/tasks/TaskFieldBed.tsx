import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import type { FieldDefinition, FieldKind } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { createFieldEntry, createOptionValue } from '../fields/commands';
import { FieldPicker } from '../fields/FieldPicker';
import { checkboxValue } from '../fields/kinds';
import { PlainValueInput, ValueEditor, writeFieldValue } from '../fields/value-editor';
import { hasValueEditor } from '../fields/value-options';
import { BlockText } from '../outline/BlockText';
import { createTaskProjects } from '../projects/task-project';
import { fieldEntryId } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { InlinePopups, Popup } from '../ui/Popup';
import { TaskFieldEditor } from './TaskFieldEditor';
import { taskFieldLabel, taskFieldName, taskFieldPlaceholder, taskFieldText, type TaskFieldName } from './task-fields';

/** Task values and ordinary entries share one bed, without copying task state into child atoms. */
export function TaskFieldBed(props: {
  notebook: NotebookClient; doc: PageDocument; id: string; fields: readonly FieldDefinition[]; template: readonly string[];
  contextDate: string; sheet?: boolean; initialField?: TaskFieldName; onFieldOpened(): void; onDismiss(): void;
}) {
  const [editor, setEditor] = createSignal<{ field: FieldDefinition; anchor: HTMLElement; value?: string }>();
  const [picker, setPicker] = createSignal<HTMLElement>();
  const [extra, setExtra] = createSignal<string[]>([]);
  const [error, setError] = createSignal('');
  const [draft, setDraft] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const projects = createTaskProjects(props.doc, props.notebook);
  let bed!: HTMLDivElement;
  const task = () => props.doc.block(props.id)?.task;
  const entries = createMemo(() => {
    props.doc.outline.version();
    return props.doc.outline.children(props.id).flatMap(id => {
      const field = !props.doc.isArchived(id) && fieldEntryId(props.doc.block(id)?.text ?? '');
      return field ? [{ id, field }] : [];
    });
  });
  const values = (field: string) => entries().filter(entry => entry.field === field).flatMap(entry => props.doc.outline.children(entry.id).filter(id => !props.doc.isArchived(id)));
  const project = () => projects.project(props.id);
  const explicitProject = () => props.fields.filter(field => taskFieldName(field) === 'project').some(field => values(field.id).some(id => fieldEntryId(props.doc.block(id)?.text ?? '') === project()));
  const fields = createMemo(() => {
    const byId = new Map(props.fields.map(field => [field.id, field]));
    const builtins = props.fields.filter(field => {
      const name = taskFieldName(field);
      return name && (task()?.status ? (name === 'project' ? !!project() : !!taskFieldText(task(), name)) : name === 'scheduled');
    }).map(field => field.id);
    const requested = props.fields.find(field => props.initialField && taskFieldName(field) === props.initialField);
    const ordered = [...new Set([...(task()?.status ? props.template : builtins), ...builtins, ...entries().map(entry => entry.field), ...extra(), ...(requested ? [requested.id] : [])])];
    return ordered.flatMap(id => { const field = byId.get(id); return field ? [field] : []; });
  });
  const label = (field: FieldDefinition) => { const name = taskFieldName(field); return name ? taskFieldLabel(name) : field.name; };
  const message = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const open = (field: FieldDefinition, anchor: HTMLElement, value?: string) => {
    if (!taskFieldName(field) && field.kind === 'checkbox') {
      try {
        writeFieldValue(props.doc, { field, ownerId: props.id, valueId: value }, checkboxValue(value ? props.doc.block(value)?.text ?? '' : '') ? 'no' : 'yes');
        void props.doc.flush().catch(message);
      } catch (reason) { message(reason); }
      return;
    }
    setError(''); setDraft(value ? props.doc.block(value)?.text ?? '' : ''); setEditor({ field, anchor, value });
  };
  const closeEditor = () => {
    const field = editor()?.field.id; setEditor(undefined);
    queueMicrotask(() => bed?.querySelector<HTMLButtonElement>(`[data-task-field="${field}"]`)?.focus({ preventScroll: true }));
  };
  const write = async (text: string, relationPick?: Parameters<typeof writeFieldValue>[4]) => {
    const state = editor(); if (!state) return;
    writeFieldValue(props.doc, { field: state.field, ownerId: props.id, valueId: state.value }, text, undefined, relationPick);
    await props.doc.flush();
  };
  const savePlain = async () => {
    if (busy() || !editor()) return;
    setBusy(true);
    try { await write(draft()); closeEditor(); } catch (reason) { message(reason); }
    finally { setBusy(false); }
  };
  const choose = (field: FieldDefinition, anchor: HTMLElement) => {
    setPicker(undefined); setExtra(ids => [...new Set([...ids, field.id])]);
    queueMicrotask(() => open(field, bed?.querySelector<HTMLElement>(`[data-task-field="${field.id}"]`) ?? anchor, values(field.id)[0]));
  };
  const create = async (name: string, kind: FieldKind, anchor: HTMLElement) => {
    setBusy(true); setError('');
    try {
      const register = await props.notebook.api.fields();
      const result = await createFieldEntry(props.notebook, props.doc, register, props.id, name, kind);
      setPicker(undefined); open(result.field, anchor, result.value);
    } catch (reason) { message(reason); }
    finally { setBusy(false); }
  };
  const Editor = () => <Show keyed when={editor()}>{state => <Show when={taskFieldName(state.field)} fallback={
    <Show when={hasValueEditor(state.field, state.value ? props.doc.block(state.value)?.text ?? '' : '', props.contextDate)} fallback={<div class="task-field-input"><PlainValueInput field={state.field} text={draft()} onInput={setDraft} onCommit={() => { void savePlain(); }} onCancel={closeEditor} /></div>}>
      <ValueEditor anchor={state.anchor} field={state.field} text={state.value ? props.doc.block(state.value)?.text ?? '' : ''} notebook={props.notebook} contextDate={props.contextDate} owner={{ id: props.id, page: props.doc.pageId }} onWrite={write} onDismiss={closeEditor} onError={setError} onCreateOption={async text => { await createOptionValue(props.notebook, props.doc, { field: state.field, ownerId: props.id, valueId: state.value }, text); }} />
    </Show>
  }>{name => <TaskFieldEditor notebook={props.notebook} doc={props.doc} id={props.id} field={name()} anchor={state.anchor} contextDate={props.contextDate} onDismiss={closeEditor} />}</Show>}</Show>;
  const rich = () => {
    const field = editor()?.field, name = field && taskFieldName(field);
    return !!picker() || !!field && (name === 'repeat' || name !== 'scheduled' && name !== 'deadline' && hasValueEditor(field, draft(), props.contextDate));
  };
  const Picker = () => <Show when={picker()}>{anchor => <FieldPicker anchor={anchor()} label="Add field" fields={props.fields} template={props.template} exclude={new Set(fields().map(field => field.id))} onPick={field => choose(field, anchor())} onCreate={(name, kind) => { void create(name, kind, anchor()); }} onDismiss={() => setPicker(undefined)} />}</Show>;
  const Contents = () => <div ref={bed} class="task-field-bed" onKeyDown={event => {
    if (event.key === 'Escape' && !editor() && !picker()) { event.preventDefault(); event.stopPropagation(); props.onDismiss(); }
    // Field controls own Tab and Enter, never the outline's structural commands.
    if (event.key === 'Tab' || event.key === 'Enter') event.stopPropagation();
  }} onPointerDown={event => event.stopPropagation()}>
    <Show when={props.sheet}><header class="task-field-heading"><p class="task-planning-kicker">{task()?.status ? 'Task fields' : 'Fields'}</p><h2><BlockText text={props.doc.block(props.id)?.text ?? ''} notebook={props.notebook} interactive={false} /></h2></header></Show>
    <Show when={!props.sheet || !rich()} fallback={<><Button onClick={() => { setPicker(undefined); closeEditor(); }}><Icon name="left" />Back to fields</Button><InlinePopups><Editor /><Picker /></InlinePopups></>}>
      <For each={fields()}>{field => {
        const name = taskFieldName(field);
        const text = () => name === 'project' ? project() ? props.notebook.lookup(project()!)()?.text ?? 'Project' : '' : name ? taskFieldText(task(), name) : '';
        return <div class="task-field-row" data-field-id={field.id}>
          <span class="task-field-label">{label(field)}</span>
          <div class="task-field-values">
            <Show when={!name && values(field.id).length} fallback={<Button class="task-field-value" data-task-field={field.id} classList={{ 'task-field-empty': name ? !text() : true, 'task-field-machine': name === 'scheduled' || name === 'deadline' || name === 'repeat' }} label={`Edit ${label(field)}`} onClick={event => open(field, event.currentTarget)}>{text() || (name ? taskFieldPlaceholder(name) : 'Add…')}<Show when={name === 'status' || name === 'priority'}><Icon name="down" /></Show><Show when={name === 'project' && project() && !explicitProject()}><span class="task-field-inherited">inherited</span></Show></Button>}>
              <For each={values(field.id)}>{id => <Button class="task-field-value" data-task-field={field.id} label={`Edit ${label(field)}`} onClick={event => open(field, event.currentTarget, id)}><BlockText text={props.doc.block(id)?.text ?? ''} notebook={props.notebook} interactive={false} /></Button>}</For>
            </Show>
            <Show when={editor()?.field.id === field.id && (!props.sheet && !name && !hasValueEditor(field, draft(), props.contextDate) || props.sheet && !rich())}><InlinePopups><Editor /></InlinePopups></Show>
          </div>
        </div>;
      }}</For>
      <Show when={!task()?.status}><Button class="task-field-make" onClick={() => { const value = task(); if (!value) return; const result = props.doc.edit({ kind: 'task', id: props.id, value: { ...value, status: 'todo' } }); if (!result.ok) setError(result.reason); else void props.doc.flush().catch(message); }}>Make task</Button></Show>
      <footer class="task-field-footer"><Button class="field-area-add" onClick={event => setPicker(event.currentTarget)}><Icon name="plus" />{props.sheet ? 'Add field' : 'Field'}</Button><Show when={props.sheet}><span>Each change saves to this atom.</span></Show></footer>
    </Show>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={!props.sheet}><Show when={editor() && (taskFieldName(editor()!.field) || hasValueEditor(editor()!.field, draft(), props.contextDate))}><Editor /></Show><Picker /></Show>
  </div>;
  createEffect(on(() => props.initialField, name => {
    if (name) queueMicrotask(() => {
      const control = bed?.querySelector<HTMLButtonElement>(`[data-task-field][aria-label="Edit ${taskFieldLabel(name)}"]`);
      if (control) { control.click(); props.onFieldOpened(); }
    });
  }));
  return <Show when={props.sheet} fallback={<Contents />}><Popup anchor={() => bed?.getBoundingClientRect() ?? null} label="Task fields" placement="sheet" class="task-field-sheet" onDismiss={props.onDismiss}><Contents /></Popup></Show>;
}
