import { createEffect, createResource, createSignal, onCleanup } from 'solid-js';
import type { FieldDefinition, Type } from '../api/types';
import type { PageDocument } from '../document/contract';
import type { OutlineContext } from '../outline/context';
import { fieldEntryId } from '../table/query';
import type { MenuItem } from '../ui/Menu';
import { fieldHide, fieldHides, hideLabels } from './hide';
import type { FieldHide } from './hide';
import { fieldKinds, kindLabels } from './kinds';
import { typeKeys } from './templates';

export function createFieldMenu(context: Pick<OutlineContext,
  'doc' | 'props' | 'fields' | 'definitionsById' | 'setMenu' | 'setMessage' | 'showNotice' | 'apply'
>) {
  const { doc, props, fields, definitionsById, setMenu, setMessage, apply } = context;
  const [definitionDocument, setDefinitionDocument] = createSignal<PageDocument>();
  const [types] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.types());
  createEffect(() => {
    const id = fields()?.page_id;
    if (!id) return;
    const document = props.notebook.open(id);
    setDefinitionDocument(document);
    onCleanup(() => { setDefinitionDocument(undefined); document.release(); });
  });
  const failure = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));
  function fieldEntry(id: string) {
    const own = definitionsById().get(fieldEntryId(doc.block(id)?.text ?? '') ?? '');
    if (own) return { id, field: own, owner: doc.outline.parentOf(id) };
    const parent = doc.outline.parentOf(id);
    const field = definitionsById().get(fieldEntryId(doc.block(parent)?.text ?? '') ?? '');
    return field ? { id: parent, field, owner: doc.outline.parentOf(parent) } : undefined;
  }
  async function saveHide(field: FieldDefinition, value: FieldHide) {
    const document = definitionDocument();
    if (!document) throw new Error('Field definitions are loading.');
    const current = (await props.notebook.api.fields()).fields.find(item => item.id === field.id);
    if (!current) throw new Error('Field no longer exists.');
    const result = document.edit({ kind: 'fieldHide', definition: current, value });
    if (!result.ok) throw new Error(result.reason);
    await document.flush();
    if (document.saveState() !== 'saved') throw new Error(document.saveMessage());
  }
  async function changeHide(field: FieldDefinition, value: FieldHide) {
    const previous = fieldHide(field);
    if (previous === value) return;
    try {
      await doc.flush();
      await saveHide(field, value);
      const label = value === 'when_empty' ? `${field.name} hidden when empty.` : value === 'always' ? `${field.name} hidden.` : `${field.name} always shown.`;
      context.showNotice(label, () => saveHide(field, previous));
    } catch (error) { failure(error); }
  }
  async function changeTemplate(type: Type, field: FieldDefinition, remove: boolean) {
    try {
      await doc.flush();
      const current = await props.notebook.api.type(type.page.id);
      await props.notebook.commit([{ op: 'set_type_fields', type_id: current.page.id, base_revision: current.page.revision,
        fields: remove ? current.fields.filter(id => id !== field.id) : [...new Set([...current.fields, field.id])],
      }], 'Change type template');
      context.showNotice(`${field.name} ${remove ? 'removed from' : 'added to'} ${type.page.text} template.`, async () => {
        const fresh = await props.notebook.api.type(type.page.id);
        await props.notebook.commit([{ op: 'set_type_fields', type_id: fresh.page.id, base_revision: fresh.page.revision, fields: current.fields }], 'Undo type template change');
      });
    } catch (error) { failure(error); }
  }
  function fieldMenu(id: string, anchor: HTMLElement) {
    const entry = fieldEntry(id);
    if (!entry) return;
    const { field, owner } = entry;
    const label = `${field.name} · ${kindLabels[field.kind]}`;
    const open = (beside = false, extra: { previewKind?: FieldDefinition['kind']; section?: 'options' | 'targets' } = {}) => props.onOpen({ kind: 'field', fieldId: field.id, ...extra }, beside);
    const submenu = (title: string, items: MenuItem[]) => setMenu({ anchor, label: title, header: <div class="menu-section">{title}</div>, items: [
      { label: `Back to ${field.name}`, icon: 'left', action: () => fieldMenu(id, anchor) }, ...items,
    ] });
    const block = doc.block(owner);
    const keys = typeKeys(block?.text ?? '', block?.manual_types ?? []);
    const ownerTypes = (types() ?? []).filter(type => keys.includes(type.page.text.toLowerCase()) || keys.includes(type.page.id.toLowerCase()));
    const document = definitionDocument();
    const unavailable = document?.status() !== 'ready' ? 'Field definitions are loading.' : document.saveState() !== 'saved' ? 'Wait for field changes to save.' : undefined;
    setMenu({ anchor, label, header: <div class="menu-section">{label}</div>, items: [
      { label: 'Open field page', icon: 'field', action: event => open(event?.shiftKey) },
      { label: 'Kind', section: 'Definition', action: () => submenu('Kind', fieldKinds.map(kind => ({ label: kindLabels[kind], checked: kind === field.kind, action: event => { if (kind !== field.kind) open(event?.shiftKey, { previewKind: kind }); } }))) },
      ...(field.kind === 'choice' ? [{ label: 'Options…', action: (event?: MouseEvent | KeyboardEvent) => open(event?.shiftKey, { section: 'options' }) }] : []),
      ...(field.kind === 'instance' ? [{ label: 'Links to…', action: (event?: MouseEvent | KeyboardEvent) => open(event?.shiftKey, { section: 'targets' }) }] : []),
      { label: 'Hide', action: () => submenu('Hide', fieldHides.map(value => ({ label: hideLabels[value], checked: value === fieldHide(field), disabledReason: unavailable, action: () => { void changeHide(field, value); } }))) },
      ...ownerTypes.map((type): MenuItem => {
        const present = type.fields.includes(field.id);
        return { label: `${present ? 'Remove from' : 'Add to'} ${type.page.text} template`, section: 'Templates', action: () => { void changeTemplate(type, field, present); } };
      }),
      ...(keys.length && types.loading ? [{ label: 'Loading templates…', section: 'Templates', disabledReason: 'Types are loading.', action: () => {} }] : []),
      ...(types.error ? [{ label: 'Templates unavailable', section: 'Templates', disabledReason: 'Could not load types.', action: () => {} }] : []),
      { label: 'Remove from this note', section: 'This note', icon: 'trash', danger: true, action: () => apply({ kind: 'delete', ids: [entry.id] }, false) },
    ] });
  }
  return { fieldEntry, fieldMenu };
}
