/**
 * Where a row dragged by its handle lands: the number of the other rows whose centre lies above its own centre.
 * `centers` are every row's centre when the drag began, `from` the dragged row's index.
 */
export function dropIndex(centers: readonly number[], from: number, centre: number): number {
  let index = 0;
  centers.forEach((value, row) => { if (row !== from && value < centre) index++; });
  return index;
}

/**
 * How far row `index` slides, in px, to make room while row `from` is held over `to`: up by the held row's height for a
 * row it has passed going down, down by it for a row passed going up, and not at all for any other row or the held one.
 */
export function makeRoom(index: number, from: number, to: number, height: number): number {
  if (index === from) return 0;
  if (to > from && index > from && index <= to) return -height;
  if (to < from && index >= to && index < from) return height;
  return 0;
}

/** Where the held row rests once dropped on `to`: the combined height of the rows it passed, down (+) or up (-). */
export function settleOffset(heights: readonly number[], from: number, to: number): number {
  if (to > from) return heights.slice(from + 1, to + 1).reduce((sum, height) => sum + height, 0);
  if (to < from) return -heights.slice(to, from).reduce((sum, height) => sum + height, 0);
  return 0;
}
