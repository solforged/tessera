import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { ulid } from 'ulid';
import type { FieldDefinition, FieldKind, FieldSummary, Operation, Type } from '../api/types';
import type { DocumentChange, NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { besideHint, opensBeside } from '../shell/beside';
import { fieldEntryId } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { FieldPicker } from './FieldPicker';
import { LinksToPopup } from './LinksToPopup';
import { changeFieldKind, createTemplateField, renameField, setFieldTargets } from './commands';
import { fieldKinds, kindLabels, kindNoun } from './kinds';
import { TypePresentation } from './TypePresentation';
import { requiredIds, requiredReason } from './required';
import { entryAnchor } from './templates';
import { linksToSummary } from './targets';
import './fields.css';

interface Gap { owner: string; page: string; fields: string[] }
interface Filled { entries: { id: string; page: string; field: string }[]; owners: number }

/** Members lacking a template field: owners without a live entry for it, empty entries included as present. */
async function templateGaps(notebook: NotebookClient, type: Type): Promise<Gap[]> {
  if (!type.fields.length || !type.members) return [];
  const query = (filters: { field: string; op: 'present'; value: null }[]) => notebook.api.query({ type: type.page.id, text: null, filters, sort: [], limit: null });
  const [members, ...present] = await Promise.all([query([]), ...type.fields.map(field => query([{ field, op: 'present', value: null }]))]);
  const owners = present.map(result => new Set(result.rows.map(row => row.block.block.id)));
  return members.rows.flatMap(row => {
    const fields = type.fields.filter((_, index) => !owners[index]!.has(row.block.block.id));
    return fields.length ? [{ owner: row.block.block.id, page: row.block.page.id, fields }] : [];
  });
}

/**
 * A type's fields, edited the same way on its page and in its register: each row renames its field, changes its
 * kind and Links to, and reorders or removes it, while the field page keeps the rest. Fill missing fields gives
 * every member an empty entry for each template field it lacks, in one command that Undo removes again while those
 * entries are still empty.
 */
export function TemplateEditor(props: { type: Type; fields: readonly FieldDefinition[]; notebook: NotebookClient; onError(message: string): void; onOpen(target: OpenTarget, beside: boolean): void; register?: { fields: readonly FieldSummary[]; pageId: string } }) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [picker, setPicker] = createSignal<HTMLElement | null>(null);
  const [filled, setFilled] = createSignal<Filled | null>(null);
  const byId = createMemo(() => new Map(props.fields.map(field => [field.id, field])));
  // The type page has no register of its own; it reads usage once its template is open.
  const [ownSummaries] = createResource(() => !props.register && open() && props.notebook.changeSequence(), () => props.notebook.api.fields());
  const summaries = createMemo(() => new Map((props.register?.fields ?? ownSummaries()?.fields ?? []).map(field => [field.id, field])));
  const [renaming, setRenaming] = createSignal<{ id: string; text: string } | null>(null);
  const [kindMenu, setKindMenu] = createSignal<{ id: string; anchor: HTMLElement } | null>(null);
  const [linksMenu, setLinksMenu] = createSignal<{ id: string; anchor: HTMLElement } | null>(null);
  const [changed, setChanged] = createSignal<{ label: string; change: DocumentChange } | null>(null);
  const template = () => props.type.fields.filter(id => byId().has(id));
  const required = createMemo(() => requiredIds(props.type));
  // The count is a guide, recounted when the template or membership changes; Fill recounts before it writes.
  const [gaps, { refetch }] = createResource(() => (props.register || open()) && `${props.type.page.id}:${props.type.fields.join(',')}:${props.type.members}`, () => templateGaps(props.notebook, props.type));
  const missing = createMemo(() => (gaps() ?? []).reduce((sum, gap) => sum + gap.fields.length, 0));
  async function run(action: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    try { await action(); } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  }
  const remember = (label: string) => (change: DocumentChange) => { setChanged({ label, change }); setFilled(null); };
  const rename = () => run(async () => {
    const edit = renaming(); const field = edit && byId().get(edit.id);
    if (!edit || !field) return;
    const name = edit.text.trim();
    setRenaming(null);
    if (name === field.name) return;
    remember(`${field.name} renamed to ${name}.`)(await renameField(props.notebook, field, name));
  });
  /** A kind every value already reads as applies in place; otherwise the field page reviews the values first. */
  const changeKind = (field: FieldDefinition, kind: FieldKind, beside: boolean) => run(async () => {
    const detail = await props.notebook.api.fieldDetail(field.id, kind);
    if (detail.problems_total) { props.onOpen({ kind: 'field', fieldId: field.id, previewKind: kind }, beside); return; }
    remember(`${field.name} is now a ${kindNoun(kind)} field.`)(await changeFieldKind(props.notebook, detail, {}));
  });
  const kindSummary = (field: FieldDefinition) => field.kind === 'instance'
    ? `${kindLabels.instance} → ${linksToSummary(props.notebook, field.targets, 'any atom')}`
    : field.kind === 'choice' ? `${kindLabels.choice} · ${field.options.length} ${field.options.length === 1 ? 'option' : 'options'}` : kindLabels[field.kind];
  const setFields = (fields: string[]) => run(() => props.notebook.commit([{ op: 'set_type_fields', type_id: props.type.page.id, base_revision: props.type.page.revision, fields }], 'Change tag template'));
  function move(index: number, by: -1 | 1) {
    const fields = [...props.type.fields];
    const [field] = fields.splice(index, 1);
    fields.splice(index + by, 0, field!);
    void setFields(fields);
  }
  /** New entries take their template places among each member's field entries, ahead of its notes. */
  const fill = () => run(async () => {
    const pending = await templateGaps(props.notebook, props.type);
    const pages = new Map(await Promise.all([...new Set(pending.map(gap => gap.page))].map(async id => [id, await props.notebook.api.page(id)] as const)));
    const operations: Operation[] = [];
    const entries: Filled['entries'] = [];
    for (const gap of pending) {
      const rows = pages.get(gap.page)?.rows ?? [];
      const children = rows.filter(row => row.block.parent_id === gap.owner).map(row => row.block.id);
      const placed = rows.flatMap(row => {
        const field = row.block.parent_id === gap.owner && !row.block.archived ? fieldEntryId(row.block.text) : null;
        return field && byId().has(field) ? [{ id: row.block.id, field }] : [];
      });
      for (const field of gap.fields) {
        const id = ulid();
        const after = entryAnchor(children, placed, props.type.fields, field);
        operations.push({ op: 'insert', id, parent_id: gap.owner, after, text: `[[${field}]]`, heading: null });
        entries.push({ id, page: gap.page, field });
        children.splice(after ? children.indexOf(after) + 1 : 0, 0, id);
        placed.splice(after ? placed.findIndex(entry => entry.id === after) + 1 : 0, 0, { id, field });
      }
    }
    if (!operations.length) return;
    await props.notebook.commit(operations, 'Fill template fields');
    setFilled({ entries, owners: pending.length });
    await refetch();
  });
  /** Removes the filled entries that are still empty; one that gained a value or note stays. */
  const undoFill = () => run(async () => {
    const done = filled();
    if (!done) return;
    const pages = await Promise.all([...new Set(done.entries.map(entry => entry.page))].map(id => props.notebook.api.page(id)));
    const rows = new Map(pages.flatMap(page => page.rows.map(row => [row.block.id, row.block] as const)));
    const parents = new Set(pages.flatMap(page => page.rows.map(row => row.block.parent_id)));
    const operations: Operation[] = done.entries.flatMap(entry => {
      const block = rows.get(entry.id);
      return block && !parents.has(entry.id) && fieldEntryId(block.text) === entry.field ? [{ op: 'delete' as const, id: entry.id, base_revision: block.revision }] : [];
    });
    if (operations.length) await props.notebook.commit(operations, 'Undo fill template fields');
    setFilled(null);
    await refetch();
  });

  const fieldActions = (id: string, index: number) => <span class="template-field-actions">
    <Button icon="edit" label={byId().get(id)!.built_in ? `${byId().get(id)!.name} is built in and cannot be renamed.` : `Rename ${byId().get(id)!.name}`} disabled={busy() || !!byId().get(id)!.built_in} onClick={() => setRenaming({ id, text: byId().get(id)!.name })} />
    <Button icon="up" label={`Move ${byId().get(id)!.name} up`} disabled={busy() || index === 0} onClick={() => move(props.type.fields.indexOf(id), -1)} />
    <Button icon="down" label={`Move ${byId().get(id)!.name} down`} disabled={busy() || index === template().length - 1} onClick={() => move(props.type.fields.indexOf(id), 1)} />
    <Button icon="close" label={required().has(id) ? requiredReason(props.type, byId().get(id)!.name) : `Remove ${byId().get(id)!.name} from template`} disabled={busy() || required().has(id)} onClick={() => void setFields(props.type.fields.filter(field => field !== id))} />
  </span>;
  return <section class={`template-editor ${props.register ? 'template-register' : ''}`} aria-label="Template">
    <TypePresentation type={props.type} notebook={props.notebook} onError={props.onError} />
    <Show when={!props.register}><Button class="template-toggle" aria-expanded={open()} onClick={() => setOpen(value => !value)}>
      <span class="template-name">Template</span><span class="section-rule" />
      <span class="template-summary">{template().length ? template().map(id => byId().get(id)!.name).join(' · ') : 'No fields'}</span><Icon name="down" />
    </Button></Show>
    <Show when={props.register || open()}><div class="template-body" aria-busy={busy() || gaps.loading}>
      <Show when={props.type.starting.length}><div class="template-actions">
        <Button disabled={busy()} onClick={() => void run(() => props.notebook.api.startingTemplate(props.type.page.id))}>Start from the {props.type.page.text} template</Button>
        <span class="template-note">{props.type.starting.join(' · ')}</span>
      </div></Show>
      <Show when={template().length} fallback={<p class="template-note">Fields added here become this tag’s table columns and wait as empty slots on its atoms.</p>}>
        <table class="template-field-table">
          <colgroup><col class="template-name-column" /><col class="template-kind-column" /><col class="template-usage-column" /><col class="template-actions-column" /></colgroup>
          <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Used by</th><th scope="col"><span class="visually-hidden">Field actions</span></th></tr></thead>
          <tbody><For each={template()}>{(id, index) => <Show when={byId().get(id)}>{field => <tr>
            <td><Show when={renaming()?.id === id} fallback={<><Button class="template-definition" title={`Open ${field().name} · ${besideHint}`} onClick={event => props.onOpen({ kind: 'field', fieldId: id }, opensBeside(event))}>{field().name}</Button><Show when={required().has(id)}> <span class="template-required" title={requiredReason(props.type, field().name)}>required</span></Show></>}>
              <form class="template-rename" onSubmit={event => { event.preventDefault(); void rename(); }}><input class="input" aria-label={`New name for ${field().name}`} value={renaming()!.text} onInput={event => setRenaming({ id, text: event.currentTarget.value })} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setRenaming(null); } }} onBlur={() => { if (renaming()?.id === id) void rename(); }} ref={input => queueMicrotask(() => { input.focus(); input.select(); })} /></form>
            </Show></td>
            <td class="template-field-kind"><Button class="template-kind" aria-haspopup="menu" aria-expanded={kindMenu()?.id === id} aria-label={`Kind for ${field().name}: ${kindSummary(field())}`} disabled={busy()} onClick={event => setKindMenu({ id, anchor: event.currentTarget })}>{kindSummary(field())} <Icon name="down" /></Button></td>
            <td class="template-field-usage"><Show when={summaries().get(id)?.owners} fallback={<span title="No atom uses this field yet">Unused</span>}><Button title={`Atoms using ${field().name}: ${summaries().get(id)!.owners} · ${besideHint}`} onClick={event => props.onOpen({ kind: 'table', typeId: null, viewId: null, query: { type: null, text: null, filters: [{ field: id, op: 'present', value: null }], sort: [], limit: null } }, opensBeside(event))}>{summaries().get(id)!.owners}</Button></Show></td>
            <td>{fieldActions(id, index())}</td>
          </tr>}</Show>}</For></tbody>
        </table>
      </Show>
      <div class="template-actions">
        <Button icon="plus" disabled={busy()} aria-haspopup="dialog" aria-expanded={!!picker()} onClick={event => setPicker(event.currentTarget)}>Add field</Button>
        <Show when={changed()}>{done => <>
          <span class="template-gap" role="status">{done().label}</span>
          <Button disabled={busy()} onClick={() => void run(async () => { await done().change.undo(); setChanged(null); })}>Undo</Button>
        </>}</Show>
        <Show when={filled()} fallback={<Show when={missing() && !changed()}>
          <span class="template-gap">{gaps()!.length} {gaps()!.length === 1 ? 'atom lacks' : 'atoms lack'} {missing()} {missing() === 1 ? 'field' : 'fields'}</span>
          <Button class="bordered" disabled={busy()} onClick={() => void fill()}>Fill missing fields</Button>
        </Show>}>{done => <>
          <span class="template-gap" role="status">Added {done().entries.length} {done().entries.length === 1 ? 'field' : 'fields'} to {done().owners} {done().owners === 1 ? 'atom' : 'atoms'}</span>
          <Button disabled={busy()} onClick={() => void undoFill()}>Undo</Button>
        </>}</Show>
      </div>
    </div></Show>
    <Show when={kindMenu()}>{menu => <Show when={byId().get(menu().id)}>{field => {
      // The menu closes before an item runs, so items keep their own copy of the row they belong to.
      const { anchor } = menu(); const current = field();
      return <Menu anchor={anchor} label={`Kind for ${current.name}`} onDismiss={() => setKindMenu(null)} items={[
        ...fieldKinds.map(kind => ({ label: kindLabels[kind], checked: kind === current.kind, action: () => { if (kind !== current.kind) void changeKind(current, kind, false); } })),
        ...(current.kind === 'instance' ? [{ label: 'Links to…', divider: true, action: () => setLinksMenu({ id: current.id, anchor }) }] : []),
        ...(current.kind === 'choice' ? [{ label: 'Options…', divider: true, action: () => props.onOpen({ kind: 'field', fieldId: current.id, section: 'options' }, false) }] : []),
        { label: 'Open field page', divider: current.kind !== 'instance' && current.kind !== 'choice', action: () => props.onOpen({ kind: 'field', fieldId: current.id }, false) },
      ]} />;
    }}</Show>}</Show>
    <Show when={linksMenu()}>{menu => <Show when={byId().get(menu().id)}>{field => <LinksToPopup anchor={menu().anchor} notebook={props.notebook} targets={field().targets} disabled={busy()} onDismiss={() => setLinksMenu(null)}
      onApply={targets => { const current = field(); setLinksMenu(null); void run(async () => remember(`${current.name} links to ${linksToSummary(props.notebook, targets, 'any atom')}.`)(await setFieldTargets(props.notebook, current, targets))); }} />}</Show>}</Show>
    <Show when={picker()}>{anchor => <FieldPicker anchor={anchor()} label="Add field to template" fields={props.fields} exclude={new Set(props.type.fields)}
      onPick={field => { setPicker(null); void setFields([...props.type.fields, field.id]); }}
      onCreate={(name, kind) => { setPicker(null); void run(() => createTemplateField(props.notebook, props.type, name, kind)); }} onDismiss={() => setPicker(null)} />}</Show>
  </section>;
}
