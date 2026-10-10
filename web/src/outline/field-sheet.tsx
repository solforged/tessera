import { For, Show, createMemo, createSignal, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import type { FieldDefinition } from '../api/types';
import { FieldPicker } from '../fields/FieldPicker';
import { entryAnchor, typeKeys } from '../fields/templates';
import { fieldEntryId } from '../table/query';
import { Icon } from '../ui/Icon';
import type { OutlineContext } from './context';
import { ensureField } from './source-fields';

interface SheetState {
  owner: string;
  /** The owner's live field entries in outline order, with their fields. */
  entries: readonly { id: string; field: string }[];
  /** The visible row the slots render under: the end of the owner's last entry, or the owner when it has none. */
  anchor: string;
  /** Depth of the owner's entries, so slots line up with their labels whichever row carries them. */
  depth: number;
  template: readonly string[];
  present: ReadonlySet<string>;
  missing: readonly string[];
}

export interface FieldSheet {
  /** The empty template slots and Add field, rendered by the row with this ID when it ends the selected block's fields. */
  FieldSlots(props: { id: string }): JSX.Element;
  /** Give an empty entry its first value. */
  fill(entry: string): void;
  /** Flip a checkbox value. */
  toggle(value: string, checked: boolean): void;
}

/**
 * The selected block's fields read as one sheet: its entries are ordinary rows, and under the last of them the
 * template fields it lacks wait as empty slots beside an Add field control. A block with no fields and no template
 * shows nothing extra.
 */
export function createFieldSheet(context: Pick<OutlineContext,
  | 'doc' | 'props' | 'definitionsById' | 'definitions' | 'indices' | 'selected' | 'editing'
  | 'folds' | 'apply' | 'setMessage' | 'templateFor' | 'baseDepth'
>, options: { offerValue(id: string, field: FieldDefinition): void; onField(field: FieldDefinition): void }): FieldSheet {
  const { doc, props, definitionsById, definitions, indices, selected, editing, folds, apply, setMessage, templateFor, baseDepth } = context;
  const fieldOf = (id: string) => definitionsById().get(fieldEntryId(doc.block(id)?.text ?? '') ?? '');
  /** The block whose fields hold the selection: the selected block, or the owner of a selected entry or value. */
  const owner = createMemo(() => {
    const id = editing() ?? selected();
    if (!id || !doc.block(id)) return null;
    const parent = doc.outline.parentOf(id);
    const candidate = fieldOf(id) ? parent : parent !== props.pageId && fieldOf(parent) ? doc.outline.parentOf(parent) : id;
    return candidate !== props.pageId && doc.block(candidate)?.kind === 'block' ? candidate : null;
  });
  const sheet = createMemo<SheetState | null>(() => {
    const id = owner();
    const block = id ? doc.block(id) : undefined;
    if (!id || !block || folds().has(id)) return null;
    doc.outline.version(); doc.archivedVersion();
    const known = definitionsById();
    // Entries come and go structurally; their text is read untracked so typing in a value does not rebuild the sheet.
    const entries = untrack(() => doc.outline.children(id).flatMap(child => {
      const field = doc.isArchived(child) ? null : fieldEntryId(doc.block(child)?.text ?? '');
      return field && known.has(field) ? [{ id: child, field }] : [];
    }));
    const present = new Set(entries.map(entry => entry.field));
    const template = templateFor(typeKeys(block.text, block.manual_types)).filter(field => known.has(field));
    if (!entries.length && !template.length) return null;
    const rows = indices();
    const last = entries.at(-1)?.id ?? null;
    let anchor = id;
    if (last) {
      const start = doc.outline.indexOf(last);
      for (let at = doc.outline.subtreeEnd(start) - 1; at >= start; at--) {
        const row = doc.outline.idAt(at);
        if (rows.has(row)) { anchor = row; break; }
      }
    }
    if (!rows.has(anchor)) return null;
    return { owner: id, entries, anchor, depth: doc.outline.depth(id) + 1 - baseDepth(), template, present, missing: template.filter(field => !present.has(field)) };
  });
  const [picker, setPicker] = createSignal<HTMLElement | null>(null);

  /** One entry with its first value, edited at once; a checkbox is added ticked, since choosing it means yes. */
  function add(field: FieldDefinition) {
    const state = sheet();
    if (!state) return;
    const after = entryAnchor(doc.outline.children(state.owner), state.entries, state.template, field.id);
    const checkbox = field.kind === 'checkbox';
    const result = apply({ kind: 'addFieldEntries', parentId: state.owner, after, entries: [{ fieldId: field.id, value: checkbox ? 'yes' : '' }] }, !checkbox);
    const value = result?.ok ? result.caret?.id : undefined;
    if (value && !checkbox) queueMicrotask(() => options.offerValue(value, field));
  }
  async function create(name: string) {
    try {
      const field = await ensureField(props.notebook, name);
      options.onField(field);
      add(field);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  /** An empty entry gains its first value: a checkbox is ticked, anything else is edited with its picker. */
  function fill(entry: string) {
    const field = fieldOf(entry);
    if (!field) return;
    const checkbox = field.kind === 'checkbox';
    const result = apply({ kind: 'insert', parentId: entry, after: null, text: checkbox ? 'yes' : '' }, !checkbox);
    const value = result?.ok ? result.caret?.id : undefined;
    if (value && !checkbox) queueMicrotask(() => options.offerValue(value, field));
  }
  /** Writes the opposite spelling; the value keeps its block. */
  function toggle(value: string, checked: boolean) {
    const result = doc.edit({ kind: 'text', id: value, text: checked ? 'no' : 'yes' });
    if (!result.ok) setMessage(result.reason);
  }

  /** Rendered inside the anchor row, after its body. */
  function FieldSlots(slotProps: { id: string }) {
    return <Show when={sheet()?.anchor === slotProps.id ? sheet() : null}>{state => <div class="field-slots" style={{ '--slot-depth': state().depth }}>
      <For each={state().missing}>{fieldId => <Show when={definitionsById().get(fieldId)}>{field =>
        <button type="button" class="field-slot" title={`Add ${field().name}`} onClick={() => add(field())}>
          <span class="field-slot-label"><Icon name="field" /><span>{field().name}</span></span>
          <Show when={field().kind === 'checkbox'} fallback={<span class="field-slot-empty">Empty</span>}><span class="field-checkbox" aria-hidden="true" /></Show>
        </button>}</Show>}</For>
      <button type="button" class="field-slot field-slot-add" aria-haspopup="dialog" aria-expanded={!!picker()} onClick={event => setPicker(event.currentTarget)}>
        <span class="field-slot-label"><Icon name="plus" /><span>Add field</span></span>
      </button>
      <Show when={picker()}>{anchor => <FieldPicker anchor={anchor()} label="Add field" fields={definitions()} template={state().template} exclude={state().present}
        onPick={field => { setPicker(null); add(field); }} onCreate={name => { setPicker(null); void create(name); }} onDismiss={() => setPicker(null)} />}</Show>
    </div>}</Show>;
  }
  return { FieldSlots, fill, toggle };
}
