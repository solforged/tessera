import { describe, expect, test } from 'bun:test';
import { leafResume, paneMotionIdentity, paneTargetIdentity, planTransition } from './pane-motion';
import { typeQuery } from '../table/query';

describe('pane motion identity', () => {
  test('caret, zoom, popup requests, mode tabs and query edits do not replay navigation entry', () => {
    expect(paneTargetIdentity({ kind: 'page', pageId: 'note', blockId: 'row', caretId: 'row', caretOffset: 7 })).toBe(paneTargetIdentity({ kind: 'page', pageId: 'note' }));
    expect(paneTargetIdentity({ kind: 'library', tab: 'all', add: true })).toBe(paneTargetIdentity({ kind: 'library', tab: 'reading' }));
    expect(paneTargetIdentity({ kind: 'agenda', mode: 'week' })).toBe(paneTargetIdentity({ kind: 'agenda', mode: 'tasks' }));
    expect(paneTargetIdentity({ kind: 'table', typeId: 'type', viewId: null, query: { ...typeQuery('type'), text: 'edited' } })).toBe(paneTargetIdentity({ kind: 'table', typeId: 'type', viewId: null, query: typeQuery('type') }));
  });
  test('destinations and dates are navigations', () => {
    expect(paneTargetIdentity({ kind: 'page', pageId: 'first' })).not.toBe(paneTargetIdentity({ kind: 'page', pageId: 'second' }));
    expect(paneTargetIdentity({ kind: 'agenda', date: '2026-10-13' })).not.toBe(paneTargetIdentity({ kind: 'agenda', date: '2026-10-14' }));
    expect(paneTargetIdentity({ kind: 'fields', typeId: 'first' })).not.toBe(paneTargetIdentity({ kind: 'fields', typeId: 'second' }));
  });
});

describe('what the entry animation follows', () => {
  test('a reader learning its snapshot, or a review changing deck, is not a new arrival', () => {
    expect(paneMotionIdentity({ kind: 'reader', sourceId: 'book' })).toBe(paneMotionIdentity({ kind: 'reader', sourceId: 'book', snapshotId: 'snap' }));
    expect(paneMotionIdentity({ kind: 'review' })).toBe(paneMotionIdentity({ kind: 'review', deckId: 'deck' }));
  });
  test('another source, and every other destination, still is', () => {
    expect(paneMotionIdentity({ kind: 'reader', sourceId: 'book' })).not.toBe(paneMotionIdentity({ kind: 'reader', sourceId: 'other' }));
    expect(paneMotionIdentity({ kind: 'page', pageId: 'first' })).not.toBe(paneMotionIdentity({ kind: 'page', pageId: 'second' }));
    expect(paneMotionIdentity({ kind: 'agenda', date: '2026-10-13' })).not.toBe(paneMotionIdentity({ kind: 'agenda', date: '2026-10-14' }));
    expect(paneMotionIdentity({ kind: 'review' })).not.toBe(paneMotionIdentity({ kind: 'library' }));
  });
  test('phone history still tells readers of different snapshots and reviews of different decks apart', () => {
    expect(paneTargetIdentity({ kind: 'reader', sourceId: 'book' })).not.toBe(paneTargetIdentity({ kind: 'reader', sourceId: 'book', snapshotId: 'snap' }));
    expect(paneTargetIdentity({ kind: 'review', deckId: 'a' })).not.toBe(paneTargetIdentity({ kind: 'review', deckId: 'b' }));
  });
});

describe('a turn that replaces a leaf still settling', () => {
  test('lifts the old leaf away from the opacity it is drawn at, leaning to the side it came from', () => {
    expect(leafResume(0.25, 'forward')).toEqual({ opacity: 0.25, lean: 0.75 });
    expect(leafResume(0.25, 'back')).toEqual({ opacity: 0.25, lean: -0.75 });
    expect(leafResume(0, 'forward')).toEqual({ opacity: 0, lean: 1 });
  });
  test('starts from rest when no leaf is entering or it has arrived', () => {
    expect(leafResume(null, 'forward')).toBeNull();
    expect(leafResume(undefined, 'back')).toBeNull();
    expect(leafResume(1, 'forward')).toBeNull();
    expect(leafResume(Number.NaN, 'forward')).toBeNull();
  });
  test('never drops below nothing', () => {
    expect(leafResume(-0.1, 'forward')).toEqual({ opacity: 0, lean: 1 });
  });
});

describe('transitions that arrive while another runs', () => {
  test('start when nothing runs', () => {
    expect(planTransition(null, 'a')).toBe('start');
    expect(planTransition(null, null)).toBe('start');
  });

  test('a turn on screen is ended and replaced, whichever pane or row asks', () => {
    expect(planTransition({ pane: 'a', phase: 'play' }, 'a')).toBe('restart');
    expect(planTransition({ pane: 'a', phase: 'play' }, 'b')).toBe('restart');
    expect(planTransition({ pane: 'a', phase: 'play' }, null)).toBe('restart');
    expect(planTransition({ pane: null, phase: 'play' }, 'a')).toBe('restart');
  });

  test('the same pane folds into a turn that has not shown its new view yet, so no step of a fast sequence is drawn', () => {
    expect(planTransition({ pane: 'a', phase: 'capture' }, 'a')).toBe('fold');
    expect(planTransition({ pane: 'a', phase: 'hold' }, 'a')).toBe('fold');
  });

  test('another pane or the row applies without motion, never skipping a held turn that would show an unmounted pane', () => {
    expect(planTransition({ pane: 'a', phase: 'hold' }, 'b')).toBe('plain');
    expect(planTransition({ pane: 'a', phase: 'capture' }, null)).toBe('plain');
    expect(planTransition({ pane: null, phase: 'hold' }, 'a')).toBe('plain');
    expect(planTransition({ pane: null, phase: 'capture' }, null)).toBe('plain');
  });
});
