import { describe, expect, test } from 'bun:test';
import { anchorInBounds, anchoredPopupPosition, popupBounds } from './popup-position';

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

  test('a below-only picker clips its list rather than flipping over the header', () => {
    const position = anchoredPopupPosition({ left: 982, right: 1342, top: 430, bottom: 458 }, viewport, 360, 700, 560, undefined, true);
    expect(position.top).toBe(462);
    expect(position.height).toBe(430);
    expect(position.side).toBe('below');
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

  test('a completion opens under its caret in the right half when it fits', () => {
    const wide = { ...pane, right: 1427, width: 1218 };
    expect(anchoredPopupPosition({ left: 850, right: 851, top: 400, bottom: 419 }, wide, 480, 253).left).toBe(850);
    expect(anchoredPopupPosition({ left: 1100, right: 1101, top: 400, bottom: 419 }, wide, 480, 253).left).toBe(1101 - 480);
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

  test('a popup keeps the side it opened on as its list shrinks', () => {
    const caret = { left: 300, right: 301, top: 760, bottom: 779 };
    const opened = anchoredPopupPosition(caret, viewport, 480, 411, 560);
    expect(opened.side).toBe('above');
    expect(opened.top).toBe(345);
    const shrunk = anchoredPopupPosition(caret, viewport, 480, 90, 560, opened.side);
    expect(shrunk.side).toBe('above');
    expect(shrunk.top + shrunk.height).toBe(756);
    // Without the kept side the short list would jump to below the caret line.
    expect(anchoredPopupPosition(caret, viewport, 480, 90, 560).side).toBe('below');
  });

  test('a popup that grows keeps its side and clips instead of flipping across the trigger', () => {
    const trigger = { left: 300, right: 400, top: 500, bottom: 520 };
    const opened = anchoredPopupPosition(trigger, viewport, 360, 300, 560);
    expect(opened.side).toBe('below');
    const grown = anchoredPopupPosition(trigger, viewport, 360, 400, 560, opened.side);
    expect(grown.side).toBe('below');
    expect(grown.top).toBe(524);
    expect(grown.height).toBe(368);
    expect(grown.clipped).toBe(true);
    expect(anchoredPopupPosition(trigger, viewport, 360, 400, 560).side).toBe('above');
  });

  test('a kept side gives way once almost no room is left on it', () => {
    const position = anchoredPopupPosition({ left: 300, right: 400, top: 780, bottom: 800 }, viewport, 360, 300, 560, 'below');
    expect(position.side).toBe('above');
    expect(position.top).toBe(476);
    expect(position.height).toBe(300);
  });

  test('a form that fits neither side keeps its whole height and covers the trigger instead of clipping', () => {
    const short = { ...viewport, bottom: 763, height: 763 };
    const below = anchoredPopupPosition({ left: 700, right: 740, top: 370, bottom: 388 }, short, 360, 402, 560);
    expect(below.side).toBe('below');
    expect(below.height).toBe(402);
    expect(below.top).toBe(353);
    expect(below.clipped).toBe(false);
    const above = anchoredPopupPosition({ left: 700, right: 740, top: 400, bottom: 418 }, short, 360, 402, 560);
    expect(above.side).toBe('above');
    expect(above.height).toBe(402);
    expect(above.top).toBe(8);
    expect(above.clipped).toBe(false);
  });

  test('a list hanging from a caret clips on its side instead of covering the line being typed', () => {
    const short = { ...viewport, bottom: 763, height: 763 };
    const caret = { left: 700, right: 701, top: 400, bottom: 418 };
    const list = anchoredPopupPosition(caret, short, 480, 560, 560);
    expect(list.side).toBe('above');
    expect(list.height).toBe(388);
    expect(list.top + list.height).toBe(396);
    expect(list.clipped).toBe(true);
  });

  test('a popup told it may not cover its trigger clips like a menu', () => {
    const short = { ...viewport, bottom: 763, height: 763 };
    const trigger = { left: 700, right: 740, top: 400, bottom: 418 };
    const listbox = anchoredPopupPosition(trigger, short, 360, 402, 560, undefined, false, false);
    expect(listbox.height).toBe(388);
    expect(listbox.top).toBe(8);
    expect(listbox.clipped).toBe(true);
  });

  test('menus and below-only lists clip and scroll rather than slide over their trigger', () => {
    const short = { ...viewport, bottom: 763, height: 763 };
    const trigger = { left: 700, right: 740, top: 400, bottom: 418 };
    const menu = anchoredPopupPosition(trigger, short, 360, 402);
    expect(menu.height).toBe(388);
    expect(menu.top + menu.height).toBe(396);
    expect(menu.clipped).toBe(true);
    const list = anchoredPopupPosition(trigger, short, 360, 402, 560, undefined, true);
    expect(list.side).toBe('below');
    expect(list.top).toBe(422);
    expect(list.height).toBe(333);
  });

  test('a popup taller than the window still clips on the larger side', () => {
    const squat = { ...viewport, bottom: 400, height: 400 };
    const position = anchoredPopupPosition({ left: 100, right: 140, top: 190, bottom: 208 }, squat, 360, 500, 560);
    expect(position.top).toBe(212);
    expect(position.height).toBe(180);
    expect(position.clipped).toBe(true);
  });
});

describe('anchor visibility', () => {
  const content = { left: 209, top: 85, right: 813, bottom: 887, width: 604, height: 802 };

  test('an anchor scrolled under its pane header or out of the pane is gone', () => {
    expect(anchorInBounds({ left: 300, right: 340, top: 40, bottom: 76 }, content)).toBe(false);
    expect(anchorInBounds({ left: 300, right: 340, top: 900, bottom: 930 }, content)).toBe(false);
    expect(anchorInBounds({ left: 900, right: 940, top: 300, bottom: 320 }, content)).toBe(false);
  });

  test('an anchor still partly showing, or a caret on screen, is in view', () => {
    expect(anchorInBounds({ left: 300, right: 340, top: 70, bottom: 100 }, content)).toBe(true);
    expect(anchorInBounds({ left: 400, right: 401, top: 300, bottom: 319 }, content)).toBe(true);
  });
});
