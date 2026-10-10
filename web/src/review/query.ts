import type { CardQuery, CardRow, CardUnit, Grade, Operation, ReviewEvent, ReviewSession } from '../api/types';
import { copyQuery } from '../table/query';

export const selectionLabels = { due: 'Due', new: 'New', all: 'All' } as const;
export const gradeLabels: Record<Grade, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

/** History and summaries: days under two months, then months and years. */
export function formatInterval(days: number): string {
  const [value, unit] = days < 60 ? [days, 'day'] : days < 365 ? [Number((days / 30.44).toFixed(1)), 'month'] : [Number((days / 365.25).toFixed(1)), 'year'];
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/** Keep compact units unless rounding would hide distinct adjacent intervals. */
export function gradeIntervals(previews: readonly { grade: Grade; interval_days: number }[]): Partial<Record<Grade, string>> {
  const ordered = (['again', 'hard', 'good', 'easy'] as const).flatMap(grade => previews.find(value => value.grade === grade) ?? []);
  const labels = ordered.map(value => formatInterval(value.interval_days));
  const tied = new Set<number>();
  for (let index = 1; index < ordered.length; index++) {
    if (labels[index] === labels[index - 1] && ordered[index]!.interval_days !== ordered[index - 1]!.interval_days) {
      tied.add(index - 1); tied.add(index);
    }
  }
  for (const index of tied) {
    const days = ordered[index]!.interval_days;
    labels[index] = days < 60 ? formatInterval(days) : days < 365 ? `${(days / 30.44).toFixed(1)} mo` : `${(days / 365.25).toFixed(1)} yr`;
  }
  const daysOnly = new Set<number>();
  for (let index = 1; index < ordered.length; index++) {
    if (labels[index] === labels[index - 1] && ordered[index]!.interval_days !== ordered[index - 1]!.interval_days) {
      daysOnly.add(index - 1); daysOnly.add(index);
    }
  }
  for (const index of daysOnly) {
    const days = ordered[index]!.interval_days;
    labels[index] = `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  return Object.fromEntries(ordered.map((value, index) => [value.grade, labels[index]!]));
}

export function copyCardQuery(query: CardQuery): CardQuery {
  return { ...query, source: query.source ? copyQuery(query.source) : null };
}

/** Revision equality covers the schedule; definition and text are checked explicitly as evidence. */
export function sameCardSnapshot(shown: CardUnit, current: CardUnit): boolean {
  return shown.id === current.id && shown.revision === current.revision
    && shown.definition_revision === current.definition_revision && shown.active === current.active
    && shown.front === current.front && shown.back === current.back;
}

/** A recovered start receipt may predate the shell's saved session ID. Other sessions stay discoverable. */
export function openReviewSession(sessions: readonly ReviewSession[], deckId: string | null): ReviewSession | undefined {
  return sessions.filter(session => session.state === 'open' && session.deck_id === deckId)
    .sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id))[0];
}

/** null means another session's newer grade requires the retained history, not a guess. */
export function reviewedInSession(row: CardRow, session: ReviewSession, history?: readonly ReviewEvent[]): boolean | null {
  if (history) return history.some(event => event.kind === 'grade' && event.session_id === session.id);
  if (row.last_review?.session_id === session.id) return true;
  if (!row.last_review || row.last_review.created_at < session.started_at) return false;
  return null;
}

/** Only the immutable displayed row is allowed here, never the latest query result. */
export function gradeOperation(shown: CardRow, sessionId: string, grade: Grade, reset: boolean, eventId: string, reviewedAt: number): Operation {
  return {
    op: 'grade_card', id: shown.card.id, base_revision: shown.card.revision,
    definition_revision: shown.card.definition_revision, event_id: eventId,
    session_id: sessionId, grade, reset, shown_front: shown.card.front,
    shown_back: shown.card.back, reviewed_at: reviewedAt,
  };
}
