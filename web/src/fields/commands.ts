import { ulid } from 'ulid';
import type { Block, Committed, FieldChoiceCandidate, FieldDefinition, FieldDetail, FieldKind, Operation, PageView, Type, View } from '../api/types';
import type { DocumentChange, NotebookClient, PageDocument } from '../document/contract';
import { fieldEntryId, queryFieldIds, remapQueryField } from '../table/query';
import { documentReady } from '../outline/source-fields';
import { fieldNameProblem } from './kinds';

type Write = Extract<Operation, { op: 'insert' | 'create_page' | 'edit_text' | 'set_field_kind' | 'set_type_fields' | 'set_archived' | 'move' | 'delete' | 'restore' | 'add_type' | 'remove_type' }> | (Extract<Operation, { op: 'save_view' }> & { base_revision: number });
interface Step { forward: Write; backward: Write }
const revision = (receipt: Committed, id: string) => {
  const value = receipt.revisions.find(value => value.id === id);
  if (!value) throw new Error('The field change has no revision receipt.');
  return value.revision;
};
function insert(steps: Step[], parent: string, text: string, after: string | null = null): string {
  const id = ulid();
  steps.push({ forward: { op: 'insert', id, parent_id: parent, after, text, heading: null }, backward: { op: 'delete', id, base_revision: 0 } });
  return id;
}
function replace(steps: Step[], block: Pick<Block, 'id' | 'text' | 'revision'>, text: string) {
  if (block.text === text) return;
  steps.push({ forward: { op: 'edit_text', id: block.id, base_revision: block.revision, text }, backward: { op: 'edit_text', id: block.id, base_revision: 0, text: block.text } });
}
/** Revision-guarded forward and inverse batches; option creation and all links share a receipt. */
async function commit(notebook: NotebookClient, steps: Step[], pages: string[], reason: string): Promise<DocumentChange> {
  let applied = false;
  let pending: Promise<void> = Promise.resolve();
  const run = async (forward: boolean) => {
    if (applied === forward) return;
    const ordered = forward ? steps : [...steps].reverse();
    const revisions = new Map<string, number>();
    const operations = ordered.map(step => {
      const operation = forward ? step.forward : step.backward;
      const id = operation.op === 'set_type_fields' ? operation.type_id : operation.id;
      if (operation.op === 'insert' || operation.op === 'create_page') { revisions.set(id, 1); return operation; }
      const current = revisions.get(id) ?? (operation.op === 'restore' ? operation.revision : operation.base_revision);
      revisions.set(id, current + 1);
      return operation.op === 'restore' ? { ...operation, revision: current } : { ...operation, base_revision: current };
    });
    const receipt = await notebook.commit(operations, reason, pages);
    let deletion = 0;
    for (const step of ordered) {
      const sent = forward ? step.forward : step.backward;
      const opposite = forward ? step.backward : step.forward;
      let next: Write;
      if (sent.op === 'delete') next = { op: 'restore', id: sent.id, revision: revision(receipt, sent.id), deletion_id: receipt.deletions[deletion++]! };
      else if (sent.op === 'insert' || sent.op === 'create_page' || sent.op === 'restore') next = { op: 'delete', id: sent.id, base_revision: revision(receipt, sent.id) };
      else next = { ...opposite, base_revision: revision(receipt, sent.op === 'set_type_fields' ? sent.type_id : sent.id) } as Write;
      if (forward) step.backward = next; else step.forward = next;
    }
    applied = forward;
  };
  await run(true);
  const travel = (forward: boolean) => { const next = pending.then(() => run(forward)); pending = next.catch(() => {}); return next; };
  return { undo: () => travel(false), redo: () => travel(true) };
}

export type Interpretation = { mode: 'keep' } | { mode: 'option' | 'page' | 'create'; value: string };
export type InterpretationMap = Record<string, Interpretation>;

export async function changeFieldKind(notebook: NotebookClient, detail: FieldDetail, convert: InterpretationMap): Promise<DocumentChange> {
  const steps: Step[] = [];
  const definition = await notebook.api.block(detail.field.id);
  const pages = new Set([definition.page_id]);
  if (detail.field.kind !== detail.kind) steps.push({
    forward: { op: 'set_field_kind', id: detail.field.id, base_revision: detail.field.revision, kind: detail.kind },
    backward: { op: 'set_field_kind', id: detail.field.id, base_revision: 0, kind: detail.field.kind },
  });
  const options = new Map(detail.field.options.map(option => [option.text.trim().toLocaleLowerCase(), option.id]));
  const created = new Map<string, string>();
  // A created page joins the field's only target type, so it reads as a member at once; with several, the choice is the author's.
  const [only, ...others] = detail.kind === 'instance' ? detail.field.targets : [];
  const fileUnder = only && !others.length && Object.values(convert).some(mapping => mapping.mode === 'create') ? (await notebook.api.block(only)).text : null;
  let after = detail.field.options.at(-1)?.id ?? null;
  for (const row of detail.interpretations) {
    const mapping = convert[row.text];
    if (!mapping || mapping.mode === 'keep') continue;
    let target: string;
    if (mapping.mode === 'option') {
      const name = mapping.value.trim();
      if (!name) throw new Error('An option needs a name.');
      const key = name.toLocaleLowerCase();
      target = options.get(key) ?? insert(steps, detail.field.id, name, after);
      if (!options.has(key)) { after = target; options.set(key, target); }
    } else if (mapping.mode === 'create') {
      const title = mapping.value.trim();
      if (!title) throw new Error('A page needs a title.');
      target = created.get(title) ?? ulid();
      if (!created.has(title)) {
        steps.push({ forward: { op: 'create_page', id: target, title }, backward: { op: 'delete', id: target, base_revision: 0 } });
        if (fileUnder) steps.push({ forward: { op: 'add_type', id: target, base_revision: 1, title: fileUnder }, backward: { op: 'remove_type', id: target, base_revision: 0, title: fileUnder } });
        created.set(title, target); pages.add(target);
      }
    } else target = mapping.value;
    for (const value of row.values) { pages.add(value.page_id); replace(steps, value, `[[${target}]]`); }
  }
  return commit(notebook, steps, [...pages], 'Change field kind');
}
function addCandidates(steps: Step[], pages: Set<string>, field: FieldDefinition, candidates: FieldChoiceCandidate[]) {
  let after = field.options.at(-1)?.id ?? null;
  for (const candidate of candidates) {
    const id = candidate.option_id ?? insert(steps, field.id, candidate.text, after);
    if (!candidate.option_id) after = id;
    for (const value of candidate.values) { pages.add(value.page_id); replace(steps, value, `[[${id}]]`); }
  }
}
export async function makeFieldOption(notebook: NotebookClient, detail: FieldDetail, text: string): Promise<DocumentChange> {
  const steps: Step[] = [];
  const definition = await notebook.api.block(detail.field.id);
  const candidates = detail.choice_candidates.filter(candidate => candidate.text.toLowerCase() === text.trim().toLowerCase());
  if (!candidates.length) throw new Error('The value changed. Open the field again.');
  const pages = new Set([definition.page_id]);
  addCandidates(steps, pages, detail.field, candidates);
  return commit(notebook, steps, [...pages], 'Make field option');
}

/** A fresh field's kind, set from its first value; Undo returns it to text. Nothing else needs reinterpreting yet. */
export async function setFreshFieldKind(notebook: NotebookClient, fieldId: string, kind: FieldKind): Promise<DocumentChange> {
  const definition = await notebook.api.block(fieldId);
  return commit(notebook, [{
    forward: { op: 'set_field_kind', id: fieldId, base_revision: definition.revision, kind },
    backward: { op: 'set_field_kind', id: fieldId, base_revision: 0, kind: 'text' },
  }], [definition.page_id], 'Set field kind');
}

/** An existing field placed last in a type's template; Undo restores the template it had. */
export async function addTemplateField(notebook: NotebookClient, type: Type, fieldId: string): Promise<DocumentChange> {
  return commit(notebook, [{
    forward: { op: 'set_type_fields', type_id: type.page.id, base_revision: type.page.revision, fields: [...type.fields, fieldId] },
    backward: { op: 'set_type_fields', type_id: type.page.id, base_revision: 0, fields: type.fields },
  }], [type.page.id], 'Add field to template');
}

/** A new definition placed last in a type's template, as one undoable change. */
export async function createTemplateField(notebook: NotebookClient, type: Type, name: string, kind: FieldKind): Promise<DocumentChange> {
  const register = await notebook.api.fields();
  const problem = fieldNameProblem(name, register.fields);
  if (problem) throw new Error(problem);
  const steps: Step[] = [];
  const id = insert(steps, register.page_id, name.trim());
  if (kind !== 'text') steps.push({ forward: { op: 'set_field_kind', id, base_revision: 1, kind }, backward: { op: 'set_field_kind', id, base_revision: 0, kind: 'text' } });
  steps.push({
    forward: { op: 'set_type_fields', type_id: type.page.id, base_revision: type.page.revision, fields: [...type.fields, id] },
    backward: { op: 'set_type_fields', type_id: type.page.id, base_revision: 0, fields: type.fields },
  });
  return commit(notebook, steps, [register.page_id, type.page.id], 'Create template field');
}

export async function createFieldEntry(notebook: NotebookClient, doc: PageDocument, owner: string, name: string, kind: FieldKind) {
  await doc.flush();
  const register = await notebook.api.fields();
  if (register.fields.some(field => field.name.trim().toLowerCase() === name.trim().toLowerCase())) throw new Error('A field with this name already exists.');
  const steps: Step[] = [];
  const id = insert(steps, register.page_id, name.trim());
  if (kind !== 'text') steps.push({ forward: { op: 'set_field_kind', id, base_revision: 1, kind }, backward: { op: 'set_field_kind', id, base_revision: 0, kind: 'text' } });
  const entry = insert(steps, owner, `[[${id}]]`, doc.outline.children(owner).at(-1) ?? null);
  const value = insert(steps, entry, kind === 'checkbox' ? 'yes' : '');
  const change = doc.rememberChange(await commit(notebook, steps, [register.page_id, doc.pageId], 'Create field'));
  const field = (await notebook.api.fields()).fields.find(field => field.id === id)!;
  return { field, value, change };
}

export async function createOptionValue(notebook: NotebookClient, doc: PageDocument, target: { ownerId: string; valueId?: string; field: FieldDefinition }, text: string): Promise<DocumentChange> {
  await documentReady(doc);
  await doc.flush();
  const steps: Step[] = [];
  const field = (await notebook.api.fields()).fields.find(field => field.id === target.field.id);
  if (!field) throw new Error('Field no longer exists.');
  const definition = await notebook.api.block(field.id);
  const name = text.trim();
  const option = field.options.find(option => option.text.trim().toLowerCase() === name.toLowerCase())?.id ?? insert(steps, field.id, name, field.options.at(-1)?.id ?? null);
  let entry = doc.outline.children(target.ownerId).find(id => !doc.isArchived(id) && fieldEntryId(doc.block(id)?.text ?? '') === field.id);
  const value = target.valueId ?? (entry ? doc.outline.children(entry).find(id => !doc.isArchived(id) && !doc.block(id)?.text.trim()) : undefined);
  if (value) {
    const block = doc.block(value);
    if (!block) throw new Error('The value no longer exists.');
    replace(steps, block, `[[${option}]]`);
  } else {
    entry ??= insert(steps, target.ownerId, `[[${field.id}]]`, doc.outline.children(target.ownerId).at(-1) ?? null);
    insert(steps, entry, `[[${option}]]`, doc.outline.children(entry).at(-1) ?? null);
  }
  return doc.rememberChange(await commit(notebook, steps, [doc.pageId, definition.page_id], 'Add field option'));
}

/** Predict the selected conversion without relaxing Choice's link-only reading rule. */
export function choicePreview(detail: FieldDetail, mappings: InterpretationMap): FieldDetail {
  const names = new Map(detail.interpretations.flatMap(row => {
    const mapping = mappings[row.text];
    return mapping && mapping.mode !== 'keep' && mapping.value.trim() ? row.values.map(value => [value.id, mapping.value] as const) : [];
  }));
  const converted = detail.problems.filter(item => names.has(item.value.id)).map(item => ({ ...item, value: { ...item.value, reading: { ok: true as const, value: names.get(item.value.id)!, target: null } } }));
  const remaining = detail.interpretations.filter(row => !row.reading.ok).reduce((count, row) => count + row.values.filter(value => !names.has(value.id)).length, 0);
  return { ...detail, problems_total: remaining, problems: detail.problems.filter(item => !names.has(item.value.id)), readable: [...detail.readable, ...converted] };
}

export interface FieldImpact {
  detail: FieldDetail;
  definition: Block;
  entries: Block[];
  pages: PageView[];
  templates: Type[];
  views: View[];
  target?: FieldDetail;
  conflicts: Block[];
}

/** Capture revisions at preview time, so a later edit rejects rather than being overwritten. */
export async function fieldImpact(notebook: NotebookClient, id: string, target?: string): Promise<FieldImpact> {
  const detail = await notebook.api.fieldDetail(id);
  const [definition, entries, templates, survivor, views] = await Promise.all([
    notebook.api.block(id), Promise.all(detail.entries.map(id => notebook.api.block(id))),
    Promise.all(detail.templates.map(type => notebook.api.type(type.type_id))),
    target ? notebook.api.fieldDetail(target) : undefined,
    notebook.api.views(),
  ]);
  const pageIds = [...new Set([definition.page_id, ...entries.map(entry => entry.page_id)])];
  const pages = await Promise.all(pageIds.map(id => notebook.api.page(id)));
  const targetEntries = survivor ? await Promise.all(survivor.entries.map(id => notebook.api.block(id))) : [];
  const targetOwners = new Set(targetEntries.map(entry => entry.parent_id));
  return { detail, definition, entries, pages, templates, views: views.filter(view => queryFieldIds(view.query).includes(id)), target: survivor, conflicts: entries.filter(entry => targetOwners.has(entry.parent_id)) };
}

export async function applyFieldImpact(notebook: NotebookClient, impact: FieldImpact, action: 'archive' | 'merge' | 'detach' | 'delete'): Promise<DocumentChange> {
  const { definition, entries, templates, target } = impact;
  const steps: Step[] = [];
  const pages = new Set(impact.pages.map(page => page.root.id));
  // Save before deleting the definition; inverse order restores it before restoring recipes.
  if (action !== 'archive') for (const view of impact.views) {
    steps.push({
      forward: { op: 'save_view', id: view.id, base_revision: view.revision, name: view.name, query: action === 'merge' && target ? remapQueryField(view.query, definition.id, target.field.id) : { ...view.query, field_names: { ...view.query.field_names, [definition.id]: definition.text } } },
      backward: { op: 'save_view', id: view.id, base_revision: 0, name: view.name, query: view.query },
    });
  }
  if (action === 'archive') {
    steps.push({ forward: { op: 'set_archived', id: definition.id, base_revision: definition.revision, archived: true }, backward: { op: 'set_archived', id: definition.id, base_revision: 0, archived: definition.archived } });
  } else {
    if (action === 'merge' && (!target || target.field.id === definition.id)) throw new Error('Choose another field.');
    for (const entry of entries) {
      if (action === 'merge') replace(steps, entry, `[[${target!.field.id}]]`);
      else if (action === 'detach') {
        const children = impact.pages.find(page => page.root.id === entry.page_id)!.rows.map(row => row.block).filter(block => block.parent_id === entry.id);
        if (!children.length) replace(steps, entry, `${definition.text}:`);
        let after = entry.id;
        for (let index = 0; index < children.length; index++) {
          const value = children[index]!;
          replace(steps, value, `${definition.text}: ${value.text}`);
          steps.push({
            forward: { op: 'move', id: value.id, base_revision: value.revision, parent_id: entry.parent_id!, after },
            backward: { op: 'move', id: value.id, base_revision: 0, parent_id: entry.id, after: null },
          });
          after = value.id;
        }
        if (children.length) steps.push({ forward: { op: 'delete', id: entry.id, base_revision: entry.revision }, backward: { op: 'delete', id: entry.id, base_revision: 0 } });
      } else steps.push({ forward: { op: 'delete', id: entry.id, base_revision: entry.revision }, backward: { op: 'delete', id: entry.id, base_revision: 0 } });
    }
    for (const template of templates) {
      const fields = template.fields.flatMap(id => id === definition.id ? action === 'merge' ? [target!.field.id] : [] : [id]);
      steps.push({
        forward: { op: 'set_type_fields', type_id: template.page.id, base_revision: template.page.revision, fields: [...new Set(fields)] },
        backward: { op: 'set_type_fields', type_id: template.page.id, base_revision: 0, fields: template.fields },
      });
      pages.add(template.page.id);
    }
    if (action === 'merge') {
      const definitions = impact.pages.find(page => page.root.id === definition.page_id)!;
      const children = definitions.rows.map(row => row.block).filter(block => block.parent_id === definition.id);
      let after = target!.field.options.at(-1)?.id ?? null;
      for (let index = 0; index < children.length; index++) {
        const child = children[index]!;
        steps.push({
          forward: { op: 'move', id: child.id, base_revision: child.revision, parent_id: target!.field.id, after },
          backward: { op: 'move', id: child.id, base_revision: 0, parent_id: definition.id, after: null },
        });
        after = child.id;
      }
    }
    steps.push({ forward: { op: 'delete', id: definition.id, base_revision: definition.revision }, backward: { op: 'delete', id: definition.id, base_revision: 0 } });
  }
  return commit(notebook, steps, [...pages], action === 'merge' ? 'Merge field' : action === 'archive' ? 'Archive field' : action === 'detach' ? 'Detach field values' : 'Delete field values');
}
