import { ulid } from 'ulid';
import type { Block, FieldDefinition, NoteKind, Operation, QuestionState } from '../api/types';
import type { NotebookClient, PageDocument, RelationPickIntent } from '../document/contract';
import { resolveRelationPick } from '../fields/instances';
import { filingOperations } from '../notes/finding-aid';
import type { EntityKind } from '../outline/holders';
import { documentReady, ensureField, ensureWorkField } from '../outline/source-fields';
import { fieldEntryId } from '../table/query';
import type { CreateKind } from './request';

export interface DraftValue { text: string; relationPick?: RelationPickIntent; option?: string }
export interface DraftFieldsState {
  question: QuestionState;
  holder?: { id: string; text: string; create?: EntityKind; file?: EntityKind };
  deadline: string | null;
  values: Record<string, DraftValue>;
}
export const blankDraftFields = (): DraftFieldsState => ({ question: { unsettled: false, parked: false, accepted: null, review_on: null }, deadline: null, values: {} });

/** Filled entries, including duplicate entries, protect an existing page's authored values. */
export function draftFieldRows(blocks: readonly Block[], pageId: string, fieldId: string) {
  const entries = blocks.filter(block => block.parent_id === pageId && !block.archived && fieldEntryId(block.text) === fieldId);
  const ids = new Set(entries.map(block => block.id));
  const values = blocks.filter(block => block.parent_id && ids.has(block.parent_id) && !block.archived);
  return { entry: entries[0], values, filled: values.some(block => !!block.text.trim()) };
}

/** Append only empty fields, using the same entry/value shape and relation resolver as table edits. */
export async function draftFieldOperations(notebook: NotebookClient, pageId: string, blocks: readonly Block[], definitions: readonly FieldDefinition[], values: Readonly<Record<string, DraftValue>>, after: string | null): Promise<Operation[]> {
  const operations: Operation[] = [];
  for (const field of definitions) {
    const draft = values[field.id];
    if (!draft || !draft.text.trim() && !draft.option && !draft.relationPick) continue;
    const current = draftFieldRows(blocks, pageId, field.id);
    if (current.filled) continue;
    let text = draft.text;
    if (draft.relationPick) {
      const resolved = await resolveRelationPick(notebook, draft.relationPick);
      operations.push(...resolved.operations); text = resolved.text;
    } else if (draft.option) {
      const name = draft.option.trim();
      const option = field.options.find(option => option.text.trim().toLowerCase() === name.toLowerCase())?.id ?? ulid();
      if (!field.options.some(value => value.id === option)) operations.push({ op: 'insert', id: option, parent_id: field.id, after: field.options.at(-1)?.id ?? null, text: name, heading: null });
      text = `[[${option}]]`;
    }
    const blank = current.values[0];
    if (blank) operations.push({ op: 'edit_text', id: blank.id, base_revision: blank.revision, text });
    else {
      const entry = current.entry?.id ?? ulid();
      if (!current.entry) { operations.push({ op: 'insert', id: entry, parent_id: pageId, after, text: `[[${field.id}]]`, heading: null }); after = entry; }
      operations.push({ op: 'insert', id: ulid(), parent_id: entry, after: null, text, heading: null });
    }
  }
  return operations;
}

/** Find and the creation slip share one acknowledged creation batch and body-caret contract. */
export async function createPageDraft(notebook: NotebookClient, request: { kind: CreateKind; noteKind?: NoteKind; text: string; gist?: string; fields?: DraftFieldsState }): Promise<{ pageId: string; caretId?: string; caretOffset: number; created: boolean }> {
  const text = request.text.trim(), typed = request.kind.startsWith('type:');
  if (!text) throw new Error('A title cannot be empty.');
  if (typed && !request.noteKind) throw new Error('Choose a page kind.');
  const existingId = await notebook.pageByTitle(text, false);
  const pageId = existingId ?? ulid(), caretId = existingId ? undefined : ulid();
  const fields = request.fields ?? blankDraftFields();
  const line = request.kind === 'project' ? '' : request.gist?.trim() ?? '';
  let doc: PageDocument | undefined;
  try {
    let revision = 1, blocks: Block[] = [];
    if (existingId) {
      doc = notebook.open(existingId); await documentReady(doc); await doc.flush();
      const page = await notebook.api.page(pageId);
      revision = page.root.revision; blocks = page.rows.map(row => row.block);
    }
    const filed = existingId && (request.kind === 'note' || (await notebook.api.noteKinds(existingId)).some(kind => kind.key === (request.noteKind?.key ?? request.kind)));
    const operations: Operation[] = [
      ...existingId ? [] : [{ op: 'create_page' as const, id: pageId, title: text }],
      ...caretId ? [{ op: 'insert' as const, id: caretId, parent_id: pageId, after: null, text: line, heading: null }] : [],
    ];
    if (!filed) {
      if (typed) {
        const kindPage = await notebook.pageByTitle(request.noteKind!.name, false);
        operations.push(...filingOperations(pageId, revision, request.noteKind!.name, kindPage ? undefined : ulid()));
      } else if (request.kind === 'question') operations.push({ op: 'set_question', id: pageId, base_revision: revision, question: fields.question });
      else if (request.kind === 'project') operations.push({ op: 'set_project', id: pageId, base_revision: revision, project: { status: 'active', outcome: request.gist?.trim() ?? '', deadline: fields.deadline } });
    }
    if (typed && Object.keys(fields.values).length) {
      const [type, register] = await Promise.all([request.noteKind!.type_id ? notebook.api.type(request.noteKind!.type_id) : undefined, notebook.api.fields()]);
      const definitions = (type?.fields ?? []).slice(0, 4).flatMap(id => register.fields.find(field => field.id === id) ?? []);
      operations.push(...await draftFieldOperations(notebook, pageId, blocks, definitions, fields.values, blocks.filter(block => block.parent_id === pageId).at(-1)?.id ?? caretId ?? null));
    }
    if (!filed && request.kind === 'question' && fields.holder) {
      const holder = fields.holder;
      const holderId = holder.create ? ulid() : holder.id;
      if (holder.create) operations.push({ op: 'create_page', id: holderId, title: holder.text }, { op: 'add_type', id: holderId, base_revision: 1, title: holder.create });
      else if (holder.file) operations.push({ op: 'add_type', id: holderId, base_revision: (await notebook.api.block(holderId)).revision, title: holder.file });
      const gist = await ensureField(notebook, 'gist', 'text', 'standfirst');
      await ensureWorkField(notebook);
      const perspective = ulid(), entry = ulid();
      operations.push(
        { op: 'insert', id: perspective, parent_id: pageId, after: blocks.filter(block => block.parent_id === pageId).at(-1)?.id ?? caretId ?? null, text: `[[${holderId}]]`, heading: null },
        { op: 'set_position', id: perspective, base_revision: 1, position: true },
        { op: 'insert', id: entry, parent_id: perspective, after: null, text: `[[${gist.id}]]`, heading: null },
        { op: 'insert', id: ulid(), parent_id: entry, after: null, text: '', heading: null },
      );
    }
    if (operations.length) await notebook.commit(operations, `New ${request.noteKind?.name.toLocaleLowerCase() ?? (request.kind === 'note' ? 'page' : request.kind)}`);
    return { pageId, caretId, caretOffset: line.length, created: !existingId };
  } finally { doc?.release(); }
}
