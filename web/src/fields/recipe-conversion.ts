import { ulid } from 'ulid';
import type { BlockInPage, CardTemplateInfo, CardUnit, Committed, FieldDefinition, Operation, Type } from '../api/types';
import type { DocumentChange, NotebookClient } from '../document/contract';
import { cardMarks, parseCardText } from '../review/card-text';
import { fieldEntryId } from '../table/query';
import { textTokens } from '../document/text-tokens';

export interface SyntaxAtom { source: BlockInPage; text: string; back: string; directions: string[] }
export function syntaxAtom(source: BlockInPage): SyntaxAtom | null {
  const text = source.block.text;
  const parsed = parseCardText(text), marks = cardMarks(text);
  const mark = marks[0];
  if (text.includes('\n') || parsed.problems.length || marks.length !== 1 || mark?.kind !== 'operator' || !['<>', '>>', '<<'].includes(mark.op)) return null;
  const right = text.slice(mark.end).trim(), tags = textTokens(right).filter(token => token.kind === 'tag');
  let back = right;
  for (const tag of [...tags].reverse()) back = back.slice(0, tag.start) + back.slice(tag.end);
  return { source, text: [text.slice(0, mark.start).trim(), ...tags.map(tag => right.slice(tag.start, tag.end))].join(' '), back: back.trim(), directions: parsed.cards.map(card => card.key) };
}

interface Step { forward: Operation; backward: Operation; cardId?: string }
const entityId = (operation: Operation) => 'type_id' in operation && operation.op === 'set_type_fields' ? operation.type_id : 'id' in operation ? operation.id : '';
const transferred = (operation: Operation): operation is Extract<Operation, { op: 'transfer_card_key' }> => operation.op === 'transfer_card_key';

/** Standard operations and key transfers share one revision-checked change, including inverse replay. */
export async function convertSyntax(notebook: NotebookClient, type: Type, atoms: readonly SyntaxAtom[], templates: readonly CardTemplateInfo[], field: FieldDefinition | { name: string }): Promise<DocumentChange> {
  if (!atoms.length) throw new Error('No simple syntax atoms to convert.');
  await notebook.flush();
  const steps: Step[] = [];
  const pages = new Set([type.page.id]);
  const insert = (parent_id: string, text: string, after: string | null = null) => {
    const id = ulid();
    steps.push({ forward: { op: 'insert', id, parent_id, after, text, heading: null }, backward: { op: 'delete', id, base_revision: 0 } });
    return id;
  };
  let fieldId: string;
  if ('id' in field) {
    if (field.kind !== 'text') throw new Error('Choose a text field for these answers.');
    fieldId = field.id;
  } else {
    const name = field.name.trim();
    if (!name) throw new Error('Name the answer field.');
    const register = await notebook.api.fields();
    if (register.fields.some(field => field.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('That field already exists. Choose it from the list.');
    pages.add(register.page_id);
    fieldId = insert(register.page_id, name);
  }
  if (!type.fields.includes(fieldId)) steps.push({ forward: { op: 'set_type_fields', type_id: type.page.id, base_revision: type.page.revision, fields: [...type.fields, fieldId] }, backward: { op: 'set_type_fields', type_id: type.page.id, base_revision: 0, fields: type.fields } });
  const pair = ['forward', 'reverse'].map(direction => {
    const front = direction === 'forward' ? '{@text}' : `{${fieldId}}`, back = direction === 'forward' ? `{${fieldId}}` : '{@text}';
    const existing = templates.find(template => template.front === front && template.back === back);
    const id = existing?.id ?? ulid();
    if (!existing) steps.push({ forward: { op: 'create_card_template', id, type_id: type.page.id, name: direction === 'forward' ? `Atom text → ${field.name}` : `${field.name} → Atom text`, front, back, hint: null, details: [], new_per_day: 20 }, backward: { op: 'delete_card_template', id, base_revision: 0 } });
    if (!existing?.applied) steps.push({ forward: { op: 'set_card_template_applied', id, base_revision: existing?.revision ?? 1, applied: true }, backward: { op: 'set_card_template_applied', id, base_revision: 0, applied: false } });
    return { direction, key: `tpl:${id}` };
  });
  for (const atom of atoms) {
    const block = atom.source.block;
    pages.add(block.page_id);
    const [tree, cards] = await Promise.all([notebook.api.subtree(block.id), notebook.api.sourceCards(block.id)]);
    if (tree.truncated || tree.rows.find(row => row.block.id === block.id)?.block.revision !== block.revision) throw new Error('An atom changed or its children could not be fully loaded. Reopen the preview.');
    const rows = tree.rows.map(row => row.block);
    const entries = rows.filter(row => row.parent_id === block.id && fieldEntryId(row.text) === fieldId);
    if (entries.some(entry => rows.some(row => row.parent_id === entry.id && row.text.trim()))) throw new Error(`“${atom.text}” already has ${field.name}. Choose an empty field.`);
    steps.push({ forward: { op: 'edit_text', id: block.id, base_revision: block.revision, text: atom.text }, backward: { op: 'edit_text', id: block.id, base_revision: 0, text: block.text } });
    const entry = entries[0]?.id ?? insert(block.id, `[[${fieldId}]]`, rows.filter(row => row.parent_id === block.id).at(-1)?.id ?? null);
    insert(entry, atom.back, rows.filter(row => row.parent_id === entry).at(-1)?.id ?? null);
    for (const { direction, key } of pair) {
      const old = cards.find(card => card.key === direction);
      if (cards.some(card => card.key === key)) throw new Error('This atom already has a retained recipe card. Choose a different recipe pair.');
      steps.push({ cardId: old?.id,
        forward: { op: 'transfer_card_key', source_id: block.id, key: direction, to_key: key, base_revision: old?.revision ?? null, held: old?.held || !atom.directions.includes(direction) },
        backward: { op: 'transfer_card_key', source_id: block.id, key, to_key: old ? direction : null, base_revision: 0, held: old?.held ?? true },
      });
    }
  }
  let applied = false, pending = Promise.resolve();
  const run = async (forward: boolean) => {
    if (applied === forward) return;
    const ordered = forward ? steps : [...steps].reverse();
    const revisions = new Map<string, number>();
    const operations = ordered.map(step => {
      const operation = forward ? step.forward : step.backward;
      if (transferred(operation)) return operation;
      const id = entityId(operation);
      if (operation.op === 'insert' || operation.op === 'create_card_template') { revisions.set(id, 1); return operation; }
      const base = operation.op === 'restore' ? operation.revision : 'base_revision' in operation ? operation.base_revision : null;
      if (base === null) return operation;
      const revision = revisions.get(id) ?? base;
      revisions.set(id, revision + 1);
      return operation.op === 'restore' ? { ...operation, revision } : { ...operation, base_revision: revision };
    });
    const receipt: Committed = await notebook.commit(operations, forward ? 'Use fields for card syntax' : 'Restore card syntax', [...pages]);
    // Capture the new counterpart's identity, but take its guard from the commit receipt, not a later read.
    const created = new Map<string, CardUnit[]>();
    if (forward) for (const atom of atoms) if (steps.some(step => !step.cardId && transferred(step.forward) && step.forward.source_id === atom.source.block.id)) created.set(atom.source.block.id, await notebook.api.sourceCards(atom.source.block.id));
    let deletion = 0;
    for (const step of ordered) {
      const sent = forward ? step.forward : step.backward, opposite = forward ? step.backward : step.forward;
      let next: Operation;
      if (transferred(sent) && transferred(opposite)) {
        if (!step.cardId && sent.to_key) step.cardId = created.get(sent.source_id)?.find(card => card.key === sent.to_key)?.id;
        const revision = receipt.cards?.find(card => card.id === step.cardId)?.revision;
        if (revision === undefined) throw new Error('The card transfer has no revision receipt.');
        next = { ...opposite, base_revision: sent.to_key === null ? null : revision };
      } else {
        const id = entityId(sent), revision = receipt.revisions.find(value => value.id === id)?.revision;
        if (revision === undefined) throw new Error('The conversion has no revision receipt.');
        if (sent.op === 'delete') next = { op: 'restore', id, revision, deletion_id: receipt.deletions[deletion++]! };
        else if (sent.op === 'insert' || sent.op === 'restore') next = { op: 'delete', id, base_revision: revision };
        else next = { ...opposite, ...('base_revision' in opposite ? { base_revision: revision } : {}) };
      }
      if (forward) step.backward = next; else step.forward = next;
    }
    applied = forward;
  };
  await run(true);
  const travel = (forward: boolean) => { const next = pending.then(() => run(forward)); pending = next.catch(() => {}); return next; };
  return { undo: () => travel(false), redo: () => travel(true) };
}
