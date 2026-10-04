import { describe, expect, test } from 'bun:test';
import type { Block, CardQuery, CardRow, ReviewEvent, ReviewSession, SchedulingState } from '../api/types';
import { copyCardQuery, gradeOperation, openReviewSession, reviewedInSession, sameCardSnapshot } from './query';

const schedule: SchedulingState = { ease_factor: 2.5, interval_days: 8, repetitions: 3, lapses: 0, due_at: 100, last_reviewed_at: 50 };
const page: Block = { id: 'page', kind: 'page', parent_id: null, page_id: 'page', text: 'Vocabulary', heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0 };
const source: Block = { ...page, id: 'source', kind: 'block', parent_id: page.id, text: 'amo >> I love' };
const row: CardRow = {
  card: { id: 'card', source_block_id: source.id, key: 'forward', kind: 'forward', active: true, definition_revision: 2, front: 'amo', back: 'I love', revision: 4, schedule },
  source: { page, block: source }, last_review: null,
};
const session: ReviewSession = { id: 'session', deck_id: 'deck', started_at: 100, ended_at: null, state: 'open', revision: 1 };
const event: ReviewEvent = {
  id: 'grade', card_id: row.card.id, session_id: session.id, kind: 'grade', grade: 'good',
  shown_front: row.card.front, shown_back: row.card.back, definition_revision: row.card.definition_revision,
  scheduler_version: 1, before: schedule, after: { ...schedule, interval_days: 20 }, created_at: 110, change_seq: 8,
};

describe('review snapshots and retained session evidence', () => {
  test('a correction cannot replace revealed evidence or silently carry its revision into a grade', () => {
    const corrected = { ...row.card, front: 'amō', revision: 5, definition_revision: 3 };
    expect(sameCardSnapshot(row.card, corrected)).toBe(false);
    const operation = gradeOperation(row, session.id, 'hard', true, 'event-id', 120);
    expect(operation).toEqual({
      op: 'grade_card', id: 'card', base_revision: 4, definition_revision: 2,
      event_id: 'event-id', session_id: 'session', grade: 'hard', reset: true,
      shown_front: 'amo', shown_back: 'I love', reviewed_at: 120,
    });
    corrected.front = 'amare';
    expect(operation.op === 'grade_card' && operation.shown_front).toBe('amo');
  });

  test('another grade or reset invalidates the shown intervals even without a text change', () => {
    expect(sameCardSnapshot(row.card, { ...row.card, revision: 5, schedule: { ...schedule, interval_days: 0 } })).toBe(false);
    expect(sameCardSnapshot(row.card, { ...row.card, active: false })).toBe(false);
    expect(sameCardSnapshot(row.card, { ...row.card, back: 'changed without the expected revision' })).toBe(false);
  });

  test('resuming excludes committed session grades, but a reset alone does not advance a card', () => {
    expect(reviewedInSession({ ...row, last_review: event }, session)).toBe(true);
    const reset: ReviewEvent = { ...event, id: 'reset', kind: 'reset', grade: null, created_at: 130 };
    expect(reviewedInSession(row, session, [reset])).toBe(false);
    expect(reviewedInSession(row, session, [event, reset])).toBe(true);
  });

  test('a newer grade from another session requires history before deciding whether to repeat a card', () => {
    const elsewhere: ReviewEvent = { ...event, id: 'elsewhere', session_id: 'other-session', created_at: 150 };
    const current = { ...row, last_review: elsewhere };
    expect(reviewedInSession(current, session)).toBeNull();
    expect(reviewedInSession(current, session, [event, elsewhere])).toBe(true);
    expect(reviewedInSession(current, session, [elsewhere])).toBe(false);
    expect(reviewedInSession({ ...row, last_review: { ...elsewhere, created_at: 90 } }, session)).toBe(false);
  });

  test('recovery chooses a stable open session without reopening or mutating retained closed sessions', () => {
    const values: ReviewSession[] = [
      { ...session, id: 'older', started_at: 90 },
      { ...session, id: 'tie-a' }, { ...session, id: 'tie-z' },
      { ...session, id: 'closed', state: 'finished', ended_at: 200, started_at: 150 },
      { ...session, id: 'abandoned', state: 'abandoned', ended_at: 210, started_at: 160 },
      { ...session, id: 'different-deck', deck_id: 'other', started_at: 300 },
    ];
    expect(openReviewSession(values, 'deck')?.id).toBe('tie-z');
    expect(openReviewSession([...values].reverse(), 'deck')?.id).toBe('tie-z');
    expect(values.map(value => value.id)).toEqual(['older', 'tie-a', 'tie-z', 'closed', 'abandoned', 'different-deck']);
    expect(values.filter(value => value.state === 'open')).toHaveLength(4);
  });

  test('unsaved deck filters cannot mutate the saved query or an already captured command', () => {
    const saved: CardQuery = {
      source: { type: 'vocabulary', text: 'Latin', filters: [{ field: 'language', op: 'is', value: 'Latin' }], sort: [{ by: 'field', field: 'language', direction: 'asc' }], limit: 20 },
      selection: 'due', limit: 50,
    };
    const draft = copyCardQuery(saved);
    const captured = copyCardQuery(draft);
    draft.source!.filters[0]!.value = 'Greek';
    draft.source!.sort[0]!.direction = 'desc';
    draft.source!.text = 'Greek';
    draft.selection = 'new';
    expect(captured).toEqual(saved);
    expect(saved.source!.filters[0]!.value).toBe('Latin');
    expect(saved.source!.sort[0]!.direction).toBe('asc');
  });
});
