import type { FieldDefinition, PositionQuestion } from '../api/types';
import type { PageDocument } from '../document/contract';
import type { OutlineIndex } from '../document/outline-index';
import { fieldEntryId, matchFieldEntry } from '../table/query';
import { positionFields, positionRelations, readingPassages } from './perspectives';
import { isCatalogueField } from '../library/details';
import { fieldBedRows, fieldRole } from '../fields/roles';
export interface ReadingField { name: string; entryId: string }
export interface ReadingQuestion { id: string; holders: string[] }

export interface ReadingSlip {
  id: string;
  holderId: string | null;
  gist: ReadingField[];
  work: ReadingField[];
  account: ReadingField[];
  facts: ReadingField[];
  prose: ReadingField[];
  passages: string[];
  relations: string[];
}
export interface ReadingRegister { opening: string[]; remaining: string[]; sectionId: string | null; slips: ReadingSlip[]; disagreements: { criterion: string; questions: ReadingQuestion[] }[] }

/** Project identities only; authored text and capabilities remain in the shared document. */
export function readingRegister(doc: PageDocument, definition: (id: string) => FieldDefinition | undefined, questions: readonly PositionQuestion[]): ReadingRegister {
  const fieldName = (id: string) => definition(id)?.name;
  doc.outline.version(); doc.archivedVersion();
  const slips: ReadingSlip[] = [];
  const omitted = new Set<string>();
  const disagreements = new Map<string, ReadingQuestion[]>();
  const omitSubtree = (id: string) => {
    const start = doc.outline.indexOf(id);
    if (start < 0) return;
    for (let at = start, end = doc.outline.subtreeEnd(start); at < end; at++) omitted.add(doc.outline.idAt(at));
  };
  for (const question of questions) if (question.criterion && question.block.page.id === doc.pageId) {
    const group = disagreements.get(question.criterion) ?? [];
    group.push({ id: question.block.block.id, holders: question.holders }); disagreements.set(question.criterion, group);
    omitSubtree(question.block.block.id);
  }
  for (let at = 0; at < doc.outline.size(); at++) {
    const id = doc.outline.idAt(at), block = doc.block(id);
    if (!block?.position || doc.isArchived(id)) continue;
    const fields = positionFields(doc, id, fieldName);
    const named = (name: string) => fields.filter(field => field.name.trim().toLowerCase() === name).map(({ name, entryId }) => ({ name, entryId }));
    const gist = fields.filter(field => fieldRole(definition(field.fieldId)) === 'standfirst');
    const prose = fields.filter(field => fieldRole(definition(field.fieldId)) === 'prose');
    const facts = fields.filter(field => !['standfirst', 'prose'].includes(fieldRole(definition(field.fieldId))) && !['work', 'account'].includes(field.name.trim().toLowerCase()));
    slips.push({
      id, holderId: block.position.holder_id,
      gist: gist.map(({ name, entryId }) => ({ name, entryId })),
      work: named('work').filter(field => !gist.some(gist => gist.entryId === field.entryId) && !prose.some(prose => prose.entryId === field.entryId)),
      account: named('account').filter(field => !gist.some(gist => gist.entryId === field.entryId) && !prose.some(prose => prose.entryId === field.entryId)),
      prose: prose.map(({ name, entryId }) => ({ name, entryId })),
      facts: facts.map(({ name, entryId }) => ({ name, entryId })),
      passages: readingPassages(doc, id, gist[0]?.value, fieldName).map(row => row.id),
      relations: positionRelations(doc, id).map(row => row.id),
    });
    omitSubtree(id);
  }
  let sectionId: string | null = null;
  if (slips.length) {
    let parent = doc.outline.parentOf(slips[0]!.id);
    while (parent !== doc.pageId) {
      if (doc.block(parent)?.heading) sectionId = parent;
      parent = doc.outline.parentOf(parent);
    }
  }
  const ordinary: string[] = [];
  for (let at = 0; at < doc.outline.size(); at++) {
    const id = doc.outline.idAt(at), block = doc.block(id);
    if (omitted.has(id) || doc.isArchived(id)) continue;
    const name = fieldName(fieldEntryId(block?.text ?? '') ?? '');
    if (doc.root()?.source && doc.outline.parentOf(id) === doc.pageId && isCatalogueField(name ?? matchFieldEntry(block?.text ?? '')?.name ?? '')) {
      omitSubtree(id);
      continue;
    }
    if (fieldRole(definition(fieldEntryId(block?.text ?? '') ?? '')) === 'standfirst') continue;
    if (block?.heading && doc.outline.children(id).length) {
      const end = doc.outline.subtreeEnd(at);
      let content = false;
      for (let child = at + 1; child < end; child++) if (!omitted.has(doc.outline.idAt(child)) && !doc.isArchived(doc.outline.idAt(child))) { content = true; break; }
      if (!content && id !== sectionId) continue;
    }
    ordinary.push(id);
  }
  const ordered = fieldBedRows(doc, ordinary, { get: definition }, doc.pageId);
  const boundary = sectionId ? ordered.indexOf(sectionId) : slips.length ? ordered.findIndex(id => doc.outline.indexOf(id) > doc.outline.indexOf(slips[0]!.id)) : -1;
  return { opening: boundary < 0 ? ordered : ordered.slice(0, boundary), remaining: boundary < 0 ? [] : ordered.slice(boundary).filter(id => id !== sectionId), sectionId, slips, disagreements: [...disagreements].map(([criterion, questions]) => ({ criterion, questions })) };
}

export function readingSlipRows(doc: PageDocument, slip: ReadingSlip, disclosures: ReadonlySet<string>): string[] {
  const values = (fields: ReadingField[]) => fields.flatMap(field => doc.outline.children(field.entryId).filter(id => !doc.isArchived(id)));
  return [slip.id, ...values(slip.gist), ...values(slip.work), ...values(slip.account), ...values(slip.prose), ...slip.relations, ...(disclosures.has(`${slip.id}:prose`) ? slip.passages : []), ...(disclosures.has(`${slip.id}:facts`) ? values(slip.facts) : [])];
}

export function readingCounts(slips: readonly ReadingSlip[]): string {
  const holders = new Set(slips.flatMap(slip => slip.holderId ? [slip.holderId] : [])).size;
  return `${slips.length} ${slips.length === 1 ? 'perspective' : 'perspectives'} · ${holders} ${holders === 1 ? 'holder' : 'holders'}`;
}

/** Perspectives on this page filed under it, as opposed to under a question or another subject. */
export function localPositionCount(doc: PageDocument): number {
  doc.archivedVersion();
  let count = 0;
  (doc.outline as OutlineIndex).each(0, doc.outline.size(), row => { if (!doc.isArchived(row.id) && doc.block(row.id)?.position?.subject_id === doc.pageId) count++; });
  return count;
}

/** The same authored subjects decide the default projection and whether its reading controls apply. */
export function isReadingSubject(doc: PageDocument): boolean {
  if (doc.root()?.kind !== 'page') return false;
  doc.outline.version(); doc.archivedVersion();
  if (doc.root()?.question) return true;
  for (let at = 0; at < doc.outline.size(); at++) {
    const id = doc.outline.idAt(at), position = doc.block(id)?.position;
    if (position && !doc.isArchived(id) && (position.subject_id === doc.pageId || doc.block(position.subject_id)?.question)) return true;
  }
  return false;
}
