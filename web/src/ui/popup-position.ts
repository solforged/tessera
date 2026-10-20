export interface PopupBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** A pane-local popup still respects the keyboard-resized visual viewport. */
export function popupBounds(viewport: PopupBounds, pane?: PopupBounds | null): PopupBounds {
  if (!pane) return viewport;
  const left = Math.max(viewport.left, pane.left), top = Math.max(viewport.top, pane.top);
  const right = Math.max(left, Math.min(viewport.right, pane.right)), bottom = Math.max(top, Math.min(viewport.bottom, pane.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Prefer below the link, then the larger side, keeping the trigger uncovered. A `prefer`red side that still fits wins, so a
 * menu that drills in keeps hanging from the same edge of its trigger. */
export function anchoredPopupPosition(rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, bounds: PopupBounds, width: number, contentHeight: number, maxHeight = Infinity, prefer?: 'above' | 'below', forceBelow = false) {
  const belowTop = Math.max(bounds.top + 8, Math.min(bounds.bottom - 8, rect.bottom + 4));
  const aboveBottom = Math.max(bounds.top + 8, Math.min(bounds.bottom - 8, rect.top - 4));
  const below = Math.max(0, bounds.bottom - belowTop - 8);
  const above = Math.max(0, aboveBottom - bounds.top - 8);
  const needed = Math.min(contentHeight, maxHeight);
  // A trigger in the right half hangs its popup leftward; a caret keeps it under the text being typed whenever it fits.
  const caret = rect.right - rect.left <= 2 && rect.left + width <= bounds.right - 8;
  const start = !caret && rect.left > bounds.left + bounds.width / 2 ? rect.right - width : rect.left;
  const left = Math.max(bounds.left + 8, Math.min(start, bounds.right - width - 8));
  const flip = !forceBelow && (prefer && (prefer === 'above' ? above : below) >= needed ? prefer === 'above' : below < needed && above > below);
  const height = Math.min(needed, flip ? above : below);
  return { left, top: flip ? aboveBottom - height : belowTop, height, visible: true, clipped: contentHeight > height, side: flip ? 'above' as const : 'below' as const };
}
