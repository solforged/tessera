import { describe, expect, test } from 'bun:test';
import { axisSlop, commitDistance, lockAxis, swipeGrade } from './swipe';

describe('swipe grading', () => {
  test('a drag stays undecided inside the slop, then locks to the axis it leads on', () => {
    expect(lockAxis(axisSlop - 1, 0)).toBeNull();
    expect(lockAxis(24, 6)).toBe('x');
    expect(lockAxis(-30, 4)).toBe('x');
    expect(lockAxis(6, 24)).toBe('y');
  });

  test('a diagonal drag belongs to the scroller, so scrolling a tall card never grades it', () => {
    expect(lockAxis(20, 16)).toBe('y');
    expect(lockAxis(12, 12)).toBe('y');
  });

  test('the commit distance is a third of the card, never less than 80 px', () => {
    expect(commitDistance(378)).toBe(126);
    expect(commitDistance(180)).toBe(80);
  });

  test('right grades Good and left grades Again, only past the commit distance', () => {
    expect(swipeGrade(125, 378)).toBeNull();
    expect(swipeGrade(126, 378)).toBe('good');
    expect(swipeGrade(-126, 378)).toBe('again');
    expect(swipeGrade(-40, 378)).toBeNull();
  });
});
