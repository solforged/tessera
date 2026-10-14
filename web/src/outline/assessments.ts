import type { BlockState, PageDocument } from '../document/contract';

/** A question's assessments on this page, newest first. */
export function questionAssessments(doc: PageDocument, questionId: string): BlockState[] {
  doc.outline.version();
  const result = [];
  for (let index = 0; index < doc.outline.size(); index++) {
    const block = doc.block(doc.outline.idAt(index));
    if (block?.assessment?.question_id === questionId) result.push(block);
  }
  return result.sort((a, b) => b.assessment!.state.assessed_on.localeCompare(a.assessment!.state.assessed_on) || b.id.localeCompare(a.id));
}

/** Current answer, or the latest decision that ended or skipped an assessment. */
export function assessmentStatus(doc: PageDocument, questionId: string, id: string, accepted: boolean): string {
  if (accepted) return 'Current answer';
  const history = doc.block(questionId)?.question?.state.reading_history ?? [];
  let decision;
  for (let index = history.length - 1; index >= 0; index--) if (history[index]!.assessment_id === id) { decision = history[index]; break; }
  return decision?.status === 'superseded' ? `Superseded on ${decision.on}` : decision?.status === 'withdrawn' ? `Withdrawn on ${decision.on}` : 'Not accepted';
}

/** Read shows the current answer, or else the newest assessment as a draft; the rest fold under Earlier. */
export function verdictAssessments(doc: PageDocument, questionId: string): { shown: BlockState | undefined; earlier: BlockState[] } {
  const assessments = questionAssessments(doc, questionId);
  const shown = assessments.find(block => block.assessment!.accepted) ?? assessments[0];
  return { shown, earlier: assessments.filter(block => block !== shown) };
}

export const earlierKey = (questionId: string) => `${questionId}:earlier`;
