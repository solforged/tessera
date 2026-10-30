import { describe, expect, test } from 'bun:test';
import { ACTION_GAP, ACTION_INSET, ACTION_WIDTH, AXIS_LOCK, actionsWidth, commitAt, lockAxis, releaseSwipe, swipeOffset } from './row-swipe';
import type { SwipeLayout } from './row-swipe';

const width = 402;
const full: SwipeLayout = { width, done: true, trailing: true, tomorrow: true };
const pickOnly: SwipeLayout = { ...full, tomorrow: false };
const open = actionsWidth(full);

describe('swipe axis', () => {
  test('waits for ten pixels before choosing', () => {
    expect(lockAxis(AXIS_LOCK - 1, 0)).toBe('pending');
    expect(lockAxis(-(AXIS_LOCK - 1), AXIS_LOCK - 1)).toBe('pending');
  });

  test('takes a clearly sideways start in either direction', () => {
    expect(lockAxis(AXIS_LOCK, 2)).toBe('horizontal');
    expect(lockAxis(-24, 8)).toBe('horizontal');
  });

  test('leaves a vertical or diagonal start to the page scroll', () => {
    expect(lockAxis(2, AXIS_LOCK)).toBe('vertical');
    expect(lockAxis(12, 12)).toBe('vertical');
    expect(lockAxis(14, 10)).toBe('vertical');
    expect(lockAxis(-30, 24)).toBe('vertical');
  });
});

describe('swipe offset', () => {
  test('actions width is Pick date alone, or with Tomorrow', () => {
    expect(actionsWidth(pickOnly)).toBe(ACTION_INSET + ACTION_WIDTH);
    expect(open).toBe(ACTION_INSET + ACTION_WIDTH + ACTION_GAP + ACTION_WIDTH);
  });

  test('follows the finger where there is an action, up to the row edge', () => {
    expect(swipeOffset(60, full)).toBe(60);
    expect(swipeOffset(width + 80, full)).toBe(width);
    expect(swipeOffset(-60, full)).toBe(-60);
    expect(swipeOffset(-(open + 40), full)).toBe(-(open + 40));
    expect(swipeOffset(-(width + 80), full)).toBe(-width);
  });

  test('without Tomorrow the buttons stop short of the edge', () => {
    const stop = actionsWidth(pickOnly);
    expect(swipeOffset(-stop, pickOnly)).toBe(-stop);
    expect(swipeOffset(-(width + 80), pickOnly)).toBeGreaterThan(-(stop + 29));
    expect(swipeOffset(-(width + 80), pickOnly)).toBeLessThan(-stop);
  });

  test('resists a direction with no action', () => {
    const left: SwipeLayout = { ...full, done: false };
    expect(swipeOffset(200, left)).toBe(28);
    expect(swipeOffset(40, left)).toBe(10);
    const right: SwipeLayout = { ...full, trailing: false, tomorrow: false };
    expect(swipeOffset(-200, right)).toBe(-28);
  });

  test('a row resting open starts the next drag from its buttons', () => {
    expect(swipeOffset(-open + 30, full)).toBe(-open + 30);
    expect(swipeOffset(-open + 200, full)).toBe(22);
  });
});

describe('swipe commit', () => {
  test('a third of the row to the right commits Done', () => {
    expect(commitAt(width * 0.32 - 1, full)).toBeNull();
    expect(commitAt(width * 0.32, full)).toBe('done');
  });

  test('past half of the row to the left commits Tomorrow, not the buttons showing', () => {
    expect(commitAt(-open, full)).toBeNull();
    expect(commitAt(-width * 0.55 + 1, full)).toBeNull();
    expect(commitAt(-width * 0.55, full)).toBe('tomorrow');
  });

  test('a row with nothing to commit never commits', () => {
    expect(commitAt(width, { ...full, done: false })).toBeNull();
    expect(commitAt(-width, pickOnly)).toBeNull();
  });
});

describe('swipe release', () => {
  test('commits what the offset commits', () => {
    expect(releaseSwipe(width * 0.4, 0, full)).toEqual({ kind: 'commit', action: 'done' });
    expect(releaseSwipe(-width * 0.7, 0, full)).toEqual({ kind: 'commit', action: 'tomorrow' });
  });

  test('leaves the buttons showing past a short pull, or a flick', () => {
    expect(releaseSwipe(-80, 0, full)).toEqual({ kind: 'open' });
    expect(releaseSwipe(-open, 0, full)).toEqual({ kind: 'open' });
    expect(releaseSwipe(-20, -0.8, full)).toEqual({ kind: 'open' });
  });

  test('puts the row back on a slight pull, a slow short pull or a short pull right', () => {
    expect(releaseSwipe(-20, 0, full)).toEqual({ kind: 'close' });
    expect(releaseSwipe(-10, -0.8, full)).toEqual({ kind: 'close' });
    expect(releaseSwipe(width * 0.2, 0.9, full)).toEqual({ kind: 'close' });
    expect(releaseSwipe(0, 0, full)).toEqual({ kind: 'close' });
  });

  test('a row with no trailing buttons never rests open', () => {
    expect(releaseSwipe(-120, -1, { ...full, trailing: false, tomorrow: false })).toEqual({ kind: 'close' });
  });

  test('dragging an open row mostly closed puts it back', () => {
    expect(releaseSwipe(-open + 150, 0.4, full)).toEqual({ kind: 'close' });
  });
});
