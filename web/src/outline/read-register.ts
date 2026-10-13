import type { PositionQuestion } from '../api/types';
import type { PageDocument } from '../document/contract';
import { fieldEntryId } from '../table/query';
import { positionFields, positionRelations, readingPassages } from './perspectives';
export interface ReadingField { name: string; entryId: string }
export interface ReadingQuestion { id: string; holders: string[] }

export interface ReadingSlip {
  id: string;
  holderId: string | null;
  gist: ReadingField[];
  work: ReadingField[];
  account: ReadingField[];
  facts: ReadingField[];
  passages: string[];
  relations: string[];
}
export interface ReadingRegister { opening: string[]; remaining: string[]; sectionId: string | null; slips: ReadingSlip[]; disagreements: { criterion: string; questions: ReadingQuestion[] }[] }

/** Project identities only; authored text and capabilities remain in the shared document. */
export function readingRegister(doc: PageDocument, fieldName: (id: string) => string | undefined, questions: readonly PositionQuestion[]): ReadingRegister {
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
    const gist = fields.find(field => field.name.trim().toLowerCase() === 'gist');
    slips.push({ id, holderId: block.position.holder_id, gist: named('gist'), work: named('work'), account: named('account'), facts: fields.filter(field => !['gist', 'work', 'account'].includes(field.name.trim().toLowerCase())).map(({ name, entryId }) => ({ name, entryId })), passages: readingPassages(doc, id, gist?.value, fieldName).map(row => row.id), relations: positionRelations(doc, id).map(row => row.id) });
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
    if (fieldName(fieldEntryId(block?.text ?? '') ?? '')) continue;
    if (block?.heading && doc.outline.children(id).length) {
      const end = doc.outline.subtreeEnd(at);
      let content = false;
      for (let child = at + 1; child < end; child++) if (!omitted.has(doc.outline.idAt(child)) && !doc.isArchived(doc.outline.idAt(child))) { content = true; break; }
      if (!content && id !== sectionId) continue;
    }
    ordinary.push(id);
  }
  const boundary = sectionId ? ordinary.indexOf(sectionId) : slips.length ? ordinary.findIndex(id => doc.outline.indexOf(id) > doc.outline.indexOf(slips[0]!.id)) : -1;
  return { opening: boundary < 0 ? ordinary : ordinary.slice(0, boundary), remaining: boundary < 0 ? [] : ordinary.slice(boundary).filter(id => id !== sectionId), sectionId, slips, disagreements: [...disagreements].map(([criterion, questions]) => ({ criterion, questions })) };
}

export function readingSlipRows(doc: PageDocument, slip: ReadingSlip, disclosures: ReadonlySet<string>): string[] {
  const values = (fields: ReadingField[]) => fields.flatMap(field => doc.outline.children(field.entryId).filter(id => !doc.isArchived(id)));
  return [slip.id, ...values(slip.gist), ...values(slip.work), ...values(slip.account), ...slip.relations, ...(disclosures.has(`${slip.id}:prose`) ? slip.passages : []), ...(disclosures.has(`${slip.id}:facts`) ? values(slip.facts) : [])];
}

export function readingCounts(slips: readonly ReadingSlip[]): string {
  const holders = new Set(slips.flatMap(slip => slip.holderId ? [slip.holderId] : [])).size;
  return `${slips.length} ${slips.length === 1 ? 'reading' : 'readings'} · ${holders} ${holders === 1 ? 'holder' : 'holders'}`;
}
