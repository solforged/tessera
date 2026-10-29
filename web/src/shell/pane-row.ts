import type { PaneId } from './contract';

/**
 * The workspace is a row of panes. Opening beside lands right of the pane it came from, so the page you started from
 * stays put; panes the window cannot fit fold into spines at the row's ends.
 */
export const MAX_PANES = 4;
/** Narrowest pane: a readable measure plus the pane inset on both sides. */
export const MIN_PANE_WIDTH = 420;
export const SPINE_WIDTH = 32;

/** Where opening beside from `owner` lands: the pane already right of it, or a new pane at that position. */
export function besideSlot(order: readonly PaneId[], owner: PaneId): { index: number; existing: PaneId | null } {
  const index = order.indexOf(owner) + 1;
  return { index, existing: order[index] ?? null };
}

/** Inserts a pane at `index`. Past the limit, the pane farthest from the new one closes. */
export function insertPane(order: readonly PaneId[], index: number, id: PaneId): { order: PaneId[]; closed: PaneId | null } {
  const next = [...order.slice(0, index), id, ...order.slice(index)];
  if (next.length <= MAX_PANES) return { order: next, closed: null };
  const closed = index < next.length / 2 ? next[next.length - 1]! : next[0]!;
  return { order: next.filter(pane => pane !== closed), closed };
}

/** How many of `count` panes fit side by side in `width` pixels, leaving room for the others' spines. */
export function paneCapacity(width: number, count: number): number {
  if (count * MIN_PANE_WIDTH <= width) return count;
  let fit = Math.max(1, Math.floor((width - SPINE_WIDTH) / MIN_PANE_WIDTH));
  while (fit > 1 && fit * MIN_PANE_WIDTH + (count - fit) * SPINE_WIDTH > width) fit--;
  return Math.min(fit, count);
}

/** The first shown pane: kept while `focus` stays in view, otherwise the nearest window that shows `focus`. */
export function windowStart(count: number, fit: number, start: number, focus: number): number {
  let next = start;
  if (focus < next) next = focus;
  else if (focus >= next + fit) next = focus - fit + 1;
  return Math.max(0, Math.min(next, count - fit));
}

/**
 * The first shown pane after `pane` is revealed, and `keep` too where it can stay in view. Opening and switching only
 * need a row transition when this moves the window.
 */
export function revealedStart(order: readonly PaneId[], fit: number, start: number, pane: PaneId, keep?: PaneId): number {
  let next = windowStart(order.length, fit, start, order.indexOf(pane));
  if (keep) next = windowStart(order.length, fit, next, order.indexOf(keep));
  return next;
}

/** Which way the leaf turns to a journal day: earlier than the one showing turns back, as Back does, any other forward. */
export function journalTurn(showing: string | undefined, day: string): 'forward' | 'back' {
  return showing !== undefined && day < showing ? 'back' : 'forward';
}

const snaps = [[1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔']] as const;
/**
 * The left pane's share of a pair being resized, kept above both panes' minimum width and pulled to a third, a half or
 * two thirds within `tolerance` pixels.
 */
export function dividerRatio(ratio: number, pairWidth: number, tolerance = 12): { ratio: number; snap: string | null } {
  const least = Math.min(0.5, MIN_PANE_WIDTH / pairWidth);
  const clamped = Math.max(least, Math.min(1 - least, ratio));
  for (const [stop, label] of snaps) if (Math.abs(clamped - stop) * pairWidth <= tolerance && stop >= least && stop <= 1 - least) return { ratio: stop, snap: label };
  return { ratio: clamped, snap: null };
}
