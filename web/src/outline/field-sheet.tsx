import { For, Show, createEffect, createMemo, createResource, createSignal, mapArray, on, onCleanup, untrack } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import type { ChangeEvent, FieldDefinition, FieldKind, SubjectCriteria } from '../api/types';
import { FieldPicker } from '../fields/FieldPicker';
import { InstancePicker } from '../fields/InstancePicker';
import { fieldHide } from '../fields/hide';
import { entryAnchor, typeKeys } from '../fields/templates';
import { isCatalogueField } from '../library/details';
import { fieldEntryId } from '../table/query';
import { Icon } from '../ui/Icon';
import type { OutlineContext } from './context';
import { createFieldEntry } from '../fields/commands';

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
  start(id: string): boolean;
  key(event: KeyboardEvent, id: string): boolean;
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
    const fields = createMemo(() => !criteria.error ? criteria()?.fields ?? [] : [], undefined, {
      equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
    });
    return [subject, fields] as const;
  });
  return createMemo(() => new Map(resources()));
}

/** Every eligible owner has one stable field area, independent of selection and editing. */
export function createFieldSheet(context: Pick<OutlineContext,
  | 'doc' | 'props' | 'definitionsById' | 'definitions' | 'indices' | 'selected' | 'editing' | 'zoom'
  | 'folds' | 'apply' | 'setMessage' | 'showNotice' | 'templateFor' | 'baseDepth' | 'setSelected' | 'editAt' | 'rowFocus'
>, options: {
  offerValue(id: string, field: FieldDefinition): void;
  controlledId(): string | undefined;
  closeControlled(): void;
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
  const [filling, setFilling] = createSignal<string | null>(null);
  const emptySlots = new Map<string, string>();
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
  function start(id: string): boolean {
    const field = fieldOf(id);
    if (field) { openField(doc.outline.parentOf(id), field.id); return true; }
    const entry = doc.outline.parentOf(id);
    setFilling(fieldOf(entry) ? doc.outline.parentOf(entry) : null);
    return false;
  }
  function openField(owner: string, fieldId: string) {
    const field = definitionsById().get(fieldId);
    if (!field) return;
    setFilling(owner);
    const state = states().get(owner) ?? stateFor(owner);
    const entry = state.entries.find(entry => entry.field === fieldId);
    if (!entry) { add(owner, field); return; }
    const value = doc.outline.children(entry.id).find(id => !doc.isArchived(id));
    if (!value) fill(entry.id);
    else context.editAt(value, doc.block(value)?.text.length ?? 0, true);
  }
  function key(event: KeyboardEvent, id: string): boolean {
    const owner = filling();
    const root = zoom();
    if (root && owner && doc.outline.indexOf(owner) < doc.outline.indexOf(root)) { setFilling(null); return false; }
    if (!owner || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false;
    const entry = doc.outline.parentOf(id);
    const field = fieldOf(entry);
    if (!field || doc.outline.parentOf(entry) !== owner) { setFilling(null); return false; }
    if (event.key === 'Tab') {
      const state = states().get(owner) ?? stateFor(owner);
      const order = [...new Set([...state.template, ...state.entries.map(entry => entry.field)])];
      const next = order[order.indexOf(field.id) + (event.shiftKey ? -1 : 1)];
      options.closeControlled();
      if (next) openField(owner, next);
      return true;
    }
    if (event.key === 'Escape') {
      setFilling(null); options.closeControlled(); context.rowFocus(id); return true;
    }
    if (event.key !== 'Enter' || event.shiftKey || doc.block(id)?.text.trim()) return false;
    setFilling(null); options.closeControlled();
    const createdEntry = emptySlots.get(id);
    if (createdEntry && doc.outline.children(createdEntry).length === 1 && !doc.outline.children(id).length) {
      apply({ kind: 'delete', ids: [createdEntry] }, false);
      emptySlots.delete(id);
    }
    const ordinary = doc.outline.children(owner).find(child => !doc.isArchived(child) && !fieldOf(child));
    if (ordinary) context.editAt(ordinary, 0, true);
    else {
      const after = doc.outline.children(owner).at(-1) ?? null;
      apply({ kind: 'insert', parentId: owner, after }, true);
    }
    return true;
  }
  const controlledKey = (event: KeyboardEvent) => {
    const id = options.controlledId();
    if (id && key(event, id)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  document.addEventListener('keydown', controlledKey, true);
  onCleanup(() => document.removeEventListener('keydown', controlledKey, true));
  function add(owner: string, field: FieldDefinition, valueText?: string) {
    setFilling(owner);
    const state = states().get(owner) ?? stateFor(owner);
    const after = entryAnchor(doc.outline.children(owner), state.entries, state.template, field.id);
    const checkbox = field.kind === 'checkbox';
    const result = apply({ kind: 'addFieldEntries', parentId: owner, after, entries: [{ fieldId: field.id, value: valueText ?? (checkbox ? 'yes' : '') }] }, !checkbox && !valueText);
    const value = result?.ok ? result.caret?.id : undefined;
    if (value && !checkbox && !valueText) emptySlots.set(value, doc.outline.parentOf(value));
    // Retain a newly chosen hidden field before the queued structural caret restore checks visible rows.
    if (value && fieldHide(field) !== 'never') context.setSelected(value);
    if (value && !checkbox && !valueText) queueMicrotask(() => options.offerValue(value, field));
  }
  function choose(owner: string, anchor: HTMLElement, field: FieldDefinition) {
    if (field.kind === 'instance') setInstance({ owner, anchor, field });
    else add(owner, field);
  }
  // A source's catalogue fields belong to its header and card, so its own Add field never offers or creates them.
  async function create(owner: string, name: string, kind: FieldKind) {
    if (doc.block(owner)?.source && isCatalogueField(name)) { context.showNotice(`Edit ${name.trim()} in the source's details.`); return; }
    try {
      const { field, value, change } = await createFieldEntry(props.notebook, doc, owner, name, kind);
      options.onField(field);
      context.setSelected(value);
      context.showNotice(`${field.name} created.`, change.undo);
      if (kind !== 'checkbox') queueMicrotask(() => options.offerValue(value, field));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  function fill(entry: string) {
    const field = fieldOf(entry);
    if (!field) return;
    setFilling(doc.outline.parentOf(entry));
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
    const focused = () => filling() === area.state.owner || belongs(selected(), area.state.owner) || belongs(editing(), area.state.owner);
    const missing = createMemo(() => focused() ? area.state.missing.filter(id => options.revealed().has(area.state.owner) || fieldHide(definitionsById().get(id)) === 'never') : []);
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
      <Show keyed when={picker()}>{value => <FieldPicker anchor={value.anchor} label="Add field" fields={doc.block(value.owner)?.source ? definitions().filter(field => !isCatalogueField(field.name)) : definitions()} template={(states().get(value.owner) ?? stateFor(value.owner)).template} templateLabel={doc.block(value.owner)?.position ? 'From this recipe' : 'Template'} exclude={(states().get(value.owner) ?? stateFor(value.owner)).present}
        onPick={field => { setPicker(null); choose(value.owner, value.anchor, field); }} onCreate={(name, kind) => { setPicker(null); void create(value.owner, name, kind); }} onDismiss={() => setPicker(null)} />}</Show>
      <Show when={instance()}>{value => <InstancePicker anchor={value().anchor} field={value().field} notebook={props.notebook} onDismiss={() => setInstance(null)} onError={setMessage} onPick={page => { add(value().owner, value().field, `[[${page.id}]]`); setInstance(null); }} />}</Show>
    </>;
  }
  return { FieldSlots, Popups, pick, hover: setHovered, fill, toggle, start, key };
}
