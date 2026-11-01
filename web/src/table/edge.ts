/** The columns lying past a scroller's right edge, and the height their fade covers; a grid that fits has none. */
export function columnEdge(scroll: HTMLElement, grid: HTMLTableElement): { hidden: number; height: number } {
  const view = scroll.getBoundingClientRect();
  const hidden = scroll.scrollLeft + scroll.clientWidth < grid.offsetWidth - 1
    ? [...grid.tHead?.rows[0]?.cells ?? []].filter(cell => cell.getBoundingClientRect().right > view.left + scroll.clientWidth + 1).length : 0;
  return { hidden, height: hidden ? Math.max(0, Math.min(scroll.clientHeight, grid.getBoundingClientRect().bottom - view.top)) : 0 };
}
