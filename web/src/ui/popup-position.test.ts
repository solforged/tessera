import { describe, expect, test } from 'bun:test';
import { anchoredPopupPosition, popupBounds } from './popup-position';

const viewport = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
const pane = { left: 209, top: 49, right: 813, bottom: 887, width: 604, height: 838 };

describe('anchored popup placement', () => {
  test('a top-of-page reference opens below its line, clear of the pane header', () => {
    const position = anchoredPopupPosition({ left: 464, right: 573, top: 115, bottom: 134 }, popupBounds(viewport, pane), 380, 253);
    expect(position.top).toBe(138);
    expect(position.height).toBe(253);
    expect(position.left).toBeGreaterThanOrEqual(pane.left + 8);
    expect(position.left + 380).toBeLessThanOrEqual(pane.right - 8);
  });

  test('a lower reference flips above without covering its line', () => {
    const position = anchoredPopupPosition({ left: 642, right: 751, top: 750, bottom: 769 }, popupBounds(viewport, pane), 380, 253);
    expect(position.top + position.height).toBe(746);
    expect(position.clipped).toBe(false);
  });

  test('a link near the split divider keeps the slip inside its own pane', () => {
    const position = anchoredPopupPosition({ left: 642, right: 751, top: 450, bottom: 469 }, popupBounds(viewport, pane), 380, 253);
    expect(position.left).toBe(371);
    expect(position.top).toBe(473);
    expect(position.left + 380).toBeLessThanOrEqual(pane.right - 8);
  });

  test('a tall preview takes the larger side and scrolls internally', () => {
    const position = anchoredPopupPosition({ left: 350, right: 460, top: 470, bottom: 489 }, popupBounds(viewport, pane), 380, 700);
    expect(position.top).toBe(pane.top + 8);
    expect(position.top + position.height).toBe(466);
    expect(position.clipped).toBe(true);
  });

  test('pane bounds intersect the keyboard-resized visual viewport', () => {
    const keyboard = { left: 0, top: 80, right: 1440, bottom: 500, width: 1440, height: 420 };
    const bounds = popupBounds(keyboard, pane);
    expect(bounds).toEqual({ left: 209, top: 80, right: 813, bottom: 500, width: 604, height: 420 });
    const position = anchoredPopupPosition({ left: 350, right: 460, top: 100, bottom: 119 }, bounds, 380, 253);
    expect(position.top).toBe(123);
    expect(position.top + position.height).toBeLessThanOrEqual(bounds.bottom - 8);
  });

  test('other popups retain viewport-only placement without pane bounds', () => {
    expect(popupBounds(viewport)).toBe(viewport);
    const position = anchoredPopupPosition({ left: 642, right: 751, top: 450, bottom: 469 }, viewport, 380, 253);
    expect(position.left).toBe(642);
    expect(position.top).toBe(473);
  });

  test('a phone page menu uses the room below instead of clipping at 560 px', () => {
    const phone = { left: 0, top: 0, right: 412, bottom: 900, width: 412, height: 900 };
    const position = anchoredPopupPosition({ left: 371, right: 403, top: 40, bottom: 72 }, phone, 298, 648);
    expect(position.top).toBe(76);
    expect(position.height).toBe(648);
    expect(position.clipped).toBe(false);
    expect(position.top + position.height).toBeLessThanOrEqual(phone.bottom - 8);
  });

  test('forms and reference slips can retain their compact height limit', () => {
    const position = anchoredPopupPosition({ left: 371, right: 403, top: 40, bottom: 72 }, viewport, 298, 648, 560);
    expect(position.height).toBe(560);
    expect(position.clipped).toBe(true);
  });
});
