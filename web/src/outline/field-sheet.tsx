import { For, Show, createEffect, createMemo, createResource, createSignal, mapArray, on, untrack } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import type { ChangeEvent, FieldDefinition, SubjectCriteria } from '../api/types';
import { FieldPicker } from '../fields/FieldPicker';
import { InstancePicker } from '../fields/InstancePicker';
import { fieldHide } from '../fields/hide';
import { entryAnchor, typeKeys } from '../fields/templates';
import { isCatalogueField } from '../library/details';
import { fieldEntryId } from '../table/query';
import { Icon } from '../ui/Icon';
import type { OutlineContext } from './context';
import { ensureField } from './source-fields';

interface SheetState {
  owner: string;
  entries: readonly { id: string; field: string }[];
  template: readonly string[];
  present: ReadonlySet<string>;
  missing: readonly string[];
}
interface PlacedSheet extends SheetState { anchor: string; depth: number }

export interface FieldSheet {
  FieldSlots(props: { id: string }): JSX.Element;
  Popups(): JSX.Element;
  /** Open the shared picker, including for an owner that does not yet have a field area. */
  pick(owner: string, anchor: HTMLElement): void;
  hover(id: string | null): void;
  fill(entry: string): void;
  toggle(value: string, checked: boolean): void;
}

/** One resource per visible subject; responses only notify owners of that subject. */
function createSubjectCriteria(
  subjects: Accessor<readonly string[]>,
  lastChange: Accessor<ChangeEvent | null>,
  load: (subject: string) => Promise<SubjectCriteria>,
) {
  const resources = mapArray(subjects, subject => {
    const [criteria, { refetch }] = createResource(() => subject, load);
    createEffect(on(lastChange, change => {
      if (change?.blocks.some(block => block.id === subject) || change?.removed.includes(subject)) void refetch();
    }, { defer: true }));
    const fields = createMemo(() => !criteria.error && criteria()?.explicit ? criteria()!.fields : [], undefined, {
      equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
    });
    return [subject, fields] as const;
  });
  return createMemo(() => new Map(resources()));
}

/** Every eligible owner has one stable field area, independent of selection and editing. */
export function createFieldSheet(context: Pick<OutlineContext,
  | 'doc' | 'props' | 'definitionsById' | 'definitions' | 'indices' | 'selected' | 'editing' | 'zoom'
  | 'folds' | 'apply' | 'setMessage' | 'showNotice' | 'templateFor' | 'baseDepth' | 'setSelected'
>, options: {
  offerValue(id: string, field: FieldDefinition): void;
  onField(field: FieldDefinition): void;
  hiddenCounts: Accessor<ReadonlyMap<string, number>>;
  revealed: Accessor<ReadonlySet<string>>;
  reveal(owner: string): void;
}): FieldSheet {
  const { doc, props, definitionsById, definitions, indices, selected, editing, zoom, folds, apply, setMessage, templateFor, baseDepth } = context;
  const fieldOf = (id: string) => definitionsById().get(fieldEntryId(doc.block(id)?.text ?? '') ?? '');
  const memberships = new Map<string, readonly string[]>();
  const [membershipVersion, setMembershipVersion] = createSignal(0);
  // Inspect only committed changed blocks for tag changes; ordinary value typing never invalidates the owner scan.
  createEffect(on(props.notebook.lastChange, change => {
    let changed = false;
    for (const block of change?.blocks ?? []) {
      const previous = memberships.get(block.id);
      if (!previous) continue;
      const next = typeKeys(block.text, []);
      if (previous.length !== next.length || previous.some((key, index) => key !== next[index])) changed = true;
    }
    if (changed) setMembershipVersion(value => value + 1);
  }));
  // Only blocks with entries, type memberships or apparatus get per-owner memos/resources.
  const candidates = createMemo(() => {
    doc.outline.version(); doc.archivedVersion(); membershipVersion();
    const known = definitionsById(), owners = new Set<string>();
    memberships.clear();
    const consider = (id: string) => {
      const block = doc.block(id);
      if (!block || doc.isArchived(id)) return;
      const text = untrack(() => block.text), keys = typeKeys(text, []);
      memberships.set(id, keys);
      if (block.position || block.manual_types.length || keys.length) owners.add(id);
      if (known.has(fieldEntryId(text) ?? '')) owners.add(doc.outline.parentOf(id));
    };
    consider(props.pageId);
    for (let index = 0; index < doc.outline.size(); index++) consider(doc.outline.idAt(index));
    return [...owners];
  });
  function stateFor(owner: string, subjects: readonly string[] = []): SheetState {
    const known = definitionsById(), block = doc.block(owner);
    const entries = untrack(() => doc.outline.children(owner).flatMap(id => {
      const field = doc.isArchived(id) ? null : fieldEntryId(doc.block(id)?.text ?? '');
      return field && known.has(field) ? [{ id, field }] : [];
    }));
    const present = new Set(entries.map(entry => entry.field));
    const apparatus = block?.position ? definitions().filter(field => ['gist', 'work'].includes(field.name.trim().toLowerCase())).sort((a, b) => Number(a.name.trim().toLowerCase() === 'work') - Number(b.name.trim().toLowerCase() === 'work')).map(field => field.id) : [];
    const template = [...new Set([...apparatus, ...subjects, ...templateFor(typeKeys(untrack(() => block?.text ?? ''), block?.manual_types ?? []))])]
      .filter(id => known.has(id) && !(block?.source && isCatalogueField(known.get(id)!.name)));
    return { owner, entries, template, present, missing: template.filter(id => !present.has(id)) };
  }
  const subjects = createMemo(() => {
    const visible = indices(), result = new Set<string>();
    for (const owner of candidates()) {
      if (!visible.has(owner) && !(owner === props.pageId && !zoom())) continue;
      const subject = doc.block(owner)?.position?.subject_id;
      if (subject) result.add(subject);
    }
    return [...result];
  }, undefined, { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) });
  const criteria = createSubjectCriteria(subjects, props.notebook.lastChange, async subject =>
    (await props.notebook.api.positions({ subject, limit: 0 })).criteria);
  const owners = mapArray(candidates, owner => createMemo(() => {
    doc.outline.version(); doc.archivedVersion(); membershipVersion();
    const subject = doc.block(owner)?.position?.subject_id;
    return stateFor(owner, subject ? criteria().get(subject)?.() : undefined);
  }));
  const states = createMemo(() => new Map(owners().map(state => [state().owner, state()])));
  // One pass over visible rows places every area; never re-scan a 1k-row page for each owner.
  const placed = createMemo(() => {
    const all = states(), rows = indices(), closed = folds();
    const entries = new Map<string, string>();
    for (const state of all.values()) for (const entry of state.entries) entries.set(entry.id, state.owner);
    const anchors = new Map<string, string>();
    for (const row of rows.keys()) {
      for (let id = row; id !== props.pageId;) {
        const owner = entries.get(id);
        if (owner) anchors.set(owner, row);
        const parent = doc.outline.parentOf(id);
        if (parent === id) break;
        id = parent;
      }
    }
    const byAnchor = new Map<string, PlacedSheet[]>();
    for (const state of all.values()) {
      if (closed.has(state.owner) || !state.entries.length && !state.template.length) continue;
      if (!rows.has(state.owner) && !(state.owner === props.pageId && !zoom())) continue;
      const anchor = anchors.get(state.owner) ?? state.owner;
      const value = { ...state, anchor, depth: doc.outline.depth(state.owner) + 1 - baseDepth() };
      const group = byAnchor.get(anchor);
      if (group) group.unshift(value); else byAnchor.set(anchor, [value]);
    }
    return byAnchor;
  });
  const [hovered, setHovered] = createSignal<string | null>(null);
  function belongs(id: string | null, owner: string): boolean {
    if (!id) return false;
    if (id === owner) return true;
    for (let child = id; child !== props.pageId;) {
      const parent = doc.outline.parentOf(child);
      if (parent === owner) return !!fieldOf(child);
      if (parent === child) break;
      child = parent;
    }
    return false;
  }
  const [picker, setPicker] = createSignal<{ owner: string; anchor: HTMLElement } | null>(null);
  const [instance, setInstance] = createSignal<{ owner: string; anchor: HTMLElement; field: FieldDefinition } | null>(null);
  function pick(owner: string, anchor: HTMLElement) { setPicker({ owner, anchor }); }
  function add(owner: string, field: FieldDefinition, valueText?: string) {
    const state = states().get(owner) ?? stateFor(owner);
    const after = entryAnchor(doc.outline.children(owner), state.entries, state.template, field.id);
    const checkbox = field.kind === 'checkbox';
    const result = apply({ kind: 'addFieldEntries', parentId: owner, after, entries: [{ fieldId: field.id, value: valueText ?? (checkbox ? 'yes' : '') }] }, !checkbox && !valueText);
    const value = result?.ok ? result.caret?.id : undefined;
    // Retain a newly chosen hidden field before the queued structural caret restore checks visible rows.
    if (value && fieldHide(field) !== 'never') context.setSelected(value);
    if (value && !checkbox && !valueText) queueMicrotask(() => options.offerValue(value, field));
  }
  function choose(owner: string, anchor: HTMLElement, field: FieldDefinition) {
    if (field.kind === 'instance') setInstance({ owner, anchor, field });
    else add(owner, field);
  }
  // A source's catalogue fields belong to its header and card, so its own Add field never offers or creates them.
  async function create(owner: string, name: string) {
    if (doc.block(owner)?.source && isCatalogueField(name)) { context.showNotice(`Edit ${name.trim()} in the source's details.`); return; }
    try {
      const field = await ensureField(props.notebook, name);
      options.onField(field);
      add(owner, field);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  function fill(entry: string) {
    const field = fieldOf(entry);
    if (!field) return;
    const checkbox = field.kind === 'checkbox';
    const result = apply({ kind: 'insert', parentId: entry, after: null, text: checkbox ? 'yes' : '' }, !checkbox);
    const value = result?.ok ? result.caret?.id : undefined;
    if (value && !checkbox) queueMicrotask(() => options.offerValue(value, field));
  }
  function toggle(value: string, checked: boolean) {
    const result = doc.edit({ kind: 'text', id: value, text: checked ? 'no' : 'yes' });
    if (!result.ok) setMessage(result.reason);
  }
  function Area(area: { state: PlacedSheet }) {
    const root = () => area.state.owner === props.pageId;
    const missing = createMemo(() => area.state.missing.filter(id => options.revealed().has(area.state.owner) || fieldHide(definitionsById().get(id)) === 'never'));
    const hidden = () => (options.hiddenCounts().get(area.state.owner) ?? 0) + area.state.missing.filter(id => fieldHide(definitionsById().get(id)) !== 'never').length;
    const active = () => belongs(hovered(), area.state.owner) || belongs(selected(), area.state.owner) || belongs(editing(), area.state.owner);
    const Controls = () => <div class="field-area-controls" classList={{ 'field-area-active': active(), 'field-area-root': root() }}>
      <button type="button" class="field-area-add" aria-haspopup="dialog" aria-expanded={picker()?.owner === area.state.owner} onClick={event => pick(area.state.owner, event.currentTarget)}><Icon name="plus" />{root() ? 'Add field' : 'Field'}</button>
      <Show when={hidden()}><button type="button" class="field-area-hidden" aria-expanded={options.revealed().has(area.state.owner)} onClick={() => options.reveal(area.state.owner)}>{hidden()} hidden</button></Show>
    </div>;
    return <Show when={root() || missing().length} fallback={<Controls />}><div class="field-slots" data-field-owner={area.state.owner} style={{ '--slot-depth': area.state.depth }} onPointerEnter={() => setHovered(area.state.owner)} onPointerLeave={() => setHovered(null)}>
      <For each={missing()}>{id => <Show when={definitionsById().get(id)}>{field => <button type="button" class="field-slot" aria-label={`Add ${field().name} value`} onClick={event => choose(area.state.owner, event.currentTarget, field())}>
        <span class="field-slot-label"><Icon name="field" /><span>{field().name}</span></span>
        <span class="field-slot-value"><Show when={field().kind === 'checkbox'}><span class="field-checkbox" aria-hidden="true" /></Show></span>
      </button>}</Show>}</For>
      <Controls />
    </div></Show>;
  }
  function FieldSlots(slotProps: { id: string }) {
    return <For each={placed().get(slotProps.id)}>{state => <Area state={state} />}</For>;
  }
  function Popups() {
    return <>
      <Show when={picker()}>{value => <FieldPicker anchor={value().anchor} label="Add field" fields={doc.block(value().owner)?.source ? definitions().filter(field => !isCatalogueField(field.name)) : definitions()} template={(states().get(value().owner) ?? stateFor(value().owner)).template} exclude={(states().get(value().owner) ?? stateFor(value().owner)).present}
        onPick={field => { const state = value(); setPicker(null); choose(state.owner, state.anchor, field); }} onCreate={name => { const owner = value().owner; setPicker(null); void create(owner, name); }} onDismiss={() => setPicker(null)} />}</Show>
      <Show when={instance()}>{value => <InstancePicker anchor={value().anchor} field={value().field} notebook={props.notebook} onDismiss={() => setInstance(null)} onError={setMessage} onPick={page => { add(value().owner, value().field, `[[${page.id}]]`); setInstance(null); }} />}</Show>
    </>;
  }
  return { FieldSlots, Popups, pick, hover: setHovered, fill, toggle };
}
