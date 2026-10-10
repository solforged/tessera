import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { ulid } from 'ulid';
import type { FieldDefinition, Operation, Type } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { fieldEntryId } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { FieldPicker } from './FieldPicker';
import { kindLabels } from './kinds';
import { entryAnchor } from './templates';
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
 * A type page's template: its fields in order, which its tables show first and its members' sheets offer. Fill
 * missing fields gives every member an empty entry for each template field it lacks, in one command that Undo
 * removes again while those entries are still empty.
 */
export function TemplateEditor(props: { type: Type; fields: readonly FieldDefinition[]; notebook: NotebookClient; onError(message: string): void }) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [picker, setPicker] = createSignal<HTMLElement | null>(null);
  const [filled, setFilled] = createSignal<Filled | null>(null);
  const byId = createMemo(() => new Map(props.fields.map(field => [field.id, field])));
  const template = () => props.type.fields.filter(id => byId().has(id));
  // The count is a guide, recounted when the template or membership changes; Fill recounts before it writes.
  const [gaps, { refetch }] = createResource(() => open() && `${props.type.page.id}:${props.type.fields.join(',')}:${props.type.members}`, () => templateGaps(props.notebook, props.type));
  const missing = createMemo(() => (gaps() ?? []).reduce((sum, gap) => sum + gap.fields.length, 0));
  async function run(action: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    try { await action(); } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  }
  const setFields = (fields: string[]) => run(() => props.notebook.commit([{ op: 'set_type_fields', type_id: props.type.page.id, base_revision: props.type.page.revision, fields }], 'Change type template'));
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

  return <section class="template-editor" aria-label="Template">
    <Button class="template-toggle" aria-expanded={open()} onClick={() => setOpen(value => !value)}>
      <span class="template-name">Template</span><span class="section-rule" />
      <span class="template-summary">{template().length ? template().map(id => byId().get(id)!.name).join(' · ') : 'No fields'}</span><Icon name="down" />
    </Button>
    <Show when={open()}><div class="template-body" aria-busy={busy() || gaps.loading}>
      <Show when={template().length} fallback={<p class="template-note">Fields added here become this type’s table columns and wait as empty slots on its blocks.</p>}>
        <ol class="template-fields">
          <For each={template()}>{(id, index) => <li class="template-field">
            <Icon name="field" /><span class="template-field-name">{byId().get(id)!.name}</span><span class="template-field-kind">{kindLabels[byId().get(id)!.kind]}</span>
            <span class="template-field-actions">
              <Button icon="up" label={`Move ${byId().get(id)!.name} up`} disabled={busy() || index() === 0} onClick={() => move(props.type.fields.indexOf(id), -1)} />
              <Button icon="down" label={`Move ${byId().get(id)!.name} down`} disabled={busy() || index() === template().length - 1} onClick={() => move(props.type.fields.indexOf(id), 1)} />
              <Button icon="close" label={`Remove ${byId().get(id)!.name} from template`} disabled={busy()} onClick={() => void setFields(props.type.fields.filter(field => field !== id))} />
            </span>
          </li>}</For>
        </ol>
      </Show>
      <div class="template-actions">
        <Button icon="plus" disabled={busy()} aria-haspopup="dialog" aria-expanded={!!picker()} onClick={event => setPicker(event.currentTarget)}>Add field</Button>
        <Show when={filled()} fallback={<Show when={missing()}>
          <span class="template-gap">{gaps()!.length} {gaps()!.length === 1 ? 'block lacks' : 'blocks lack'} {missing()} {missing() === 1 ? 'field' : 'fields'}</span>
          <Button class="bordered" disabled={busy()} onClick={() => void fill()}>Fill missing fields</Button>
        </Show>}>{done => <>
          <span class="template-gap" role="status">Added {done().entries.length} {done().entries.length === 1 ? 'field' : 'fields'} to {done().owners} {done().owners === 1 ? 'block' : 'blocks'}</span>
          <Button disabled={busy()} onClick={() => void undoFill()}>Undo</Button>
        </>}</Show>
      </div>
    </div></Show>
    <Show when={picker()}>{anchor => <FieldPicker anchor={anchor()} label="Add field to template" fields={props.fields} exclude={new Set(props.type.fields)}
      onPick={field => { setPicker(null); void setFields([...props.type.fields, field.id]); }} onDismiss={() => setPicker(null)} />}</Show>
  </section>;
}
