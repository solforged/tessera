import { describe, expect, test } from 'bun:test';
import { besideSlot, dividerRatio, insertPane, MIN_PANE_WIDTH, paneCapacity, SPINE_WIDTH, windowStart } from './pane-row';

describe('opening beside', () => {
  test('lands in the pane right of the origin, never the origin', () => {
    expect(besideSlot(['a', 'b', 'c'], 'b')).toEqual({ index: 2, existing: 'c' });
    expect(besideSlot(['a', 'b'], 'a')).toEqual({ index: 1, existing: 'b' });
  });

  test('from the last pane makes a new pane at the end', () => {
    expect(besideSlot(['a', 'b'], 'b')).toEqual({ index: 2, existing: null });
  });
});

describe('inserting a pane', () => {
  test('keeps the row under the limit as it is', () => {
    expect(insertPane(['a', 'b'], 1, 'n')).toEqual({ order: ['a', 'n', 'b'], closed: null });
  });

  test('at the limit closes the pane farthest from the new one', () => {
    expect(insertPane(['a', 'b', 'c', 'd'], 4, 'n')).toEqual({ order: ['b', 'c', 'd', 'n'], closed: 'a' });
    expect(insertPane(['a', 'b', 'c', 'd'], 1, 'n')).toEqual({ order: ['a', 'n', 'b', 'c'], closed: 'd' });
  });
});

describe('fitting panes to the window', () => {
  test('shows every pane when each gets its minimum width', () => {
    expect(paneCapacity(MIN_PANE_WIDTH * 3, 3)).toBe(3);
  });

  test('folds the rest into spines, keeping room for them', () => {
    expect(paneCapacity(MIN_PANE_WIDTH * 3 - 1, 3)).toBe(2);
    expect(paneCapacity(MIN_PANE_WIDTH * 3 + SPINE_WIDTH - 1, 4)).toBe(2);
    expect(paneCapacity(MIN_PANE_WIDTH * 3 + SPINE_WIDTH, 4)).toBe(3);
  });

  test('always shows one pane', () => {
    expect(paneCapacity(200, 4)).toBe(1);
  });

  test('keeps the window while the focused pane is in it', () => {
    expect(windowStart(4, 2, 1, 2)).toBe(1);
  });

  test('slides the window just far enough to show the focused pane', () => {
    expect(windowStart(4, 2, 0, 3)).toBe(2);
    expect(windowStart(4, 2, 2, 0)).toBe(0);
  });

  test('never leaves an empty slot at the end of the row', () => {
    expect(windowStart(3, 2, 2, 2)).toBe(1);
  });
});

describe('dragging a divider', () => {
  test('snaps to a third, a half or two thirds within the tolerance', () => {
    expect(dividerRatio(0.5 + 10 / 1500, 1500)).toEqual({ ratio: 0.5, snap: '½' });
    expect(dividerRatio(2 / 3 - 10 / 1500, 1500)).toEqual({ ratio: 2 / 3, snap: '⅔' });
  });

  test('moves freely outside the tolerance', () => {
    expect(dividerRatio(0.4, 1500)).toEqual({ ratio: 0.4, snap: null });
  });

  test('keeps both panes at their minimum width', () => {
    expect(dividerRatio(0.05, 1500).ratio).toBeCloseTo(MIN_PANE_WIDTH / 1500);
    expect(dividerRatio(0.98, 1500).ratio).toBeCloseTo(1 - MIN_PANE_WIDTH / 1500);
  });

  test('skips a snap that would squeeze a pane below its minimum', () => {
    expect(dividerRatio(1 / 3, 1000)).toEqual({ ratio: MIN_PANE_WIDTH / 1000, snap: null });
  });
});
