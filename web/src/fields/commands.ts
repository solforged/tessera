import { ulid } from 'ulid';
import type { Block, Committed, FieldChoiceCandidate, FieldDefinition, FieldDetail, FieldKind, Operation } from '../api/types';
import type { DocumentChange, NotebookClient, PageDocument } from '../document/contract';
import { fieldEntryId } from '../table/query';
import { documentReady } from '../outline/source-fields';

type Write = Extract<Operation, { op: 'insert' | 'edit_text' | 'set_field_kind' | 'delete' | 'restore' }>;
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
      if (operation.op === 'insert') { revisions.set(operation.id, 1); return operation; }
      const current = revisions.get(operation.id) ?? (operation.op === 'restore' ? operation.revision : operation.base_revision);
      revisions.set(operation.id, current + 1);
      return operation.op === 'restore' ? { ...operation, revision: current } : { ...operation, base_revision: current };
    });
    const receipt = await notebook.commit(operations, reason, pages);
    let deletion = 0;
    for (const step of ordered) {
      const sent = forward ? step.forward : step.backward;
      const opposite = forward ? step.backward : step.forward;
      let next: Write;
      if (sent.op === 'delete') next = { op: 'restore', id: sent.id, revision: revision(receipt, sent.id), deletion_id: receipt.deletions[deletion++]! };
      else if (sent.op === 'insert' || sent.op === 'restore') next = { op: 'delete', id: sent.id, base_revision: revision(receipt, sent.id) };
      else next = { ...opposite, base_revision: revision(receipt, sent.id) } as Write;
      if (forward) step.backward = next; else step.forward = next;
    }
    applied = forward;
  };
  await run(true);
  const travel = (forward: boolean) => { const next = pending.then(() => run(forward)); pending = next.catch(() => {}); return next; };
  return { undo: () => travel(false), redo: () => travel(true) };
}

export async function changeFieldKind(notebook: NotebookClient, detail: FieldDetail, convert: boolean): Promise<DocumentChange> {
  const steps: Step[] = [];
  const definition = await notebook.api.block(detail.field.id);
  const pages = new Set([definition.page_id]);
  if (detail.field.kind !== detail.kind) steps.push({
    forward: { op: 'set_field_kind', id: detail.field.id, base_revision: detail.field.revision, kind: detail.kind },
    backward: { op: 'set_field_kind', id: detail.field.id, base_revision: 0, kind: detail.field.kind },
  });
  if (convert && detail.kind === 'choice') addCandidates(steps, pages, detail.field, detail.choice_candidates);
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
export function choicePreview(detail: FieldDetail, convert: boolean): FieldDetail {
  if (!convert || detail.kind !== 'choice') return detail;
  const names = new Map(detail.choice_candidates.flatMap(candidate => candidate.values.map(value => [value.id, candidate.text] as const)));
  const converted = detail.problems.filter(item => names.has(item.value.id)).map(item => ({ ...item, value: { ...item.value, reading: { ok: true as const, value: names.get(item.value.id)!, target: null } } }));
  return { ...detail, problems_total: detail.problems_total - names.size, problems: detail.problems.filter(item => !names.has(item.value.id)), readable: [...detail.readable, ...converted] };
}
