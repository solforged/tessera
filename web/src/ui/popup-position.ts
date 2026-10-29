export interface PopupBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type PopupSide = 'above' | 'below';

/** A pane-local popup still respects the keyboard-resized visual viewport. */
export function popupBounds(viewport: PopupBounds, pane?: PopupBounds | null): PopupBounds {
  if (!pane) return viewport;
  const left = Math.max(viewport.left, pane.left), top = Math.max(viewport.top, pane.top);
  const right = Math.max(left, Math.min(viewport.right, pane.right)), bottom = Math.max(top, Math.min(viewport.bottom, pane.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Whether any part of an anchor still shows inside the bounds that clip it. A caret is one pixel wide, so it counts
 * while it is on screen; an anchor scrolled wholly out of its pane, or under its header, does not. */
export function anchorInBounds(rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, bounds: PopupBounds): boolean {
  return rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom;
}

/** A kept side gives way only once it has less than this much room and the other side has more. */
const KEPT_ROOM = 160;

/** Prefer below the link, then the larger side, keeping the trigger uncovered. A `prefer`red side is kept while its room
 * lasts, so a popup whose list grows or shrinks, or whose menu drills in, never jumps across its trigger. A form
 * (`mayCover`) that fits neither side but fits the window keeps its whole height and slides along the axis until it is
 * inside, covering the trigger rather than clipping its last row. Menus, listboxes, `forceBelow` lists and anything
 * hanging from a caret (a point, not a control) clip and scroll on their side instead: covering the line being typed
 * is worse than a scrolling list. */
export function anchoredPopupPosition(rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, bounds: PopupBounds, width: number, contentHeight: number, maxHeight = Infinity, prefer?: PopupSide, forceBelow = false, mayCover = true) {
  const belowTop = Math.max(bounds.top + 8, Math.min(bounds.bottom - 8, rect.bottom + 4));
  const aboveBottom = Math.max(bounds.top + 8, Math.min(bounds.bottom - 8, rect.top - 4));
  const below = Math.max(0, bounds.bottom - belowTop - 8);
  const above = Math.max(0, aboveBottom - bounds.top - 8);
  const needed = Math.min(contentHeight, maxHeight);
  // A trigger in the right half hangs its popup leftward; a caret keeps it under the text being typed whenever it fits.
  const point = rect.right - rect.left <= 2;
  const caret = point && rect.left + width <= bounds.right - 8;
  const start = !caret && rect.left > bounds.left + bounds.width / 2 ? rect.right - width : rect.left;
  const left = Math.max(bounds.left + 8, Math.min(start, bounds.right - width - 8));
  const room = (side: PopupSide) => side === 'above' ? above : below;
  const opposite = (side: PopupSide): PopupSide => side === 'above' ? 'below' : 'above';
  const kept = prefer !== undefined && !(room(prefer) < Math.min(needed, KEPT_ROOM) && room(opposite(prefer)) > room(prefer)) ? prefer : undefined;
  const side: PopupSide = forceBelow ? 'below' : kept ?? (below < needed && above > below ? 'above' : 'below');
  if (mayCover && !forceBelow && !point && Number.isFinite(maxHeight) && room(side) < needed && room(opposite(side)) < needed && needed <= bounds.height - 16) {
    const top = Math.max(bounds.top + 8, Math.min(side === 'above' ? aboveBottom - needed : belowTop, bounds.bottom - 8 - needed));
    return { left, top, height: needed, visible: true, clipped: contentHeight > needed, side };
  }
  const height = Math.min(needed, room(side));
  return { left, top: side === 'above' ? aboveBottom - height : belowTop, height, visible: true, clipped: contentHeight > height, side };
}
