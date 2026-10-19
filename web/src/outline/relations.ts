import type { RelationKind } from '../api/types';
import type { BlockState } from '../document/contract';

export const relationKinds: readonly RelationKind[] = ['supports', 'disputes', 'qualifies', 'answers'];
export const relationLabels: Record<RelationKind, string> = { supports: 'Supports', disputes: 'Disputes', qualifies: 'Qualifies', answers: 'Answers' };
export const incomingRelationLabels: Record<RelationKind, string> = { supports: 'Supported by', disputes: 'Disputed by', qualifies: 'Qualified by', answers: 'Answered by' };

export function relationReason(block: BlockState | undefined): string | undefined {
  if (block?.kind !== 'block') return 'Select an ordinary atom.';
  if (block.position || block.question || block.assessment) return 'An argument cannot also be a perspective, question or answer.';
  return undefined;
}

export function addRelationReason(block: BlockState | undefined): string | undefined {
  return block?.position || block?.question || block?.assessment ? undefined : 'Select a perspective, question or answer.';
}
