/**
 * Opening beside has one modifier everywhere: ⌘ on Apple keyboards, Ctrl elsewhere (on a Mac, Ctrl-click is the
 * context menu). Shift stays free for selecting text and ranges.
 */
const mac = /Mac|iPhone|iPad/.test(navigator.platform);

export const besideKey = mac ? '⌘' : 'Ctrl';
/** Tooltip suffix for controls that open something. */
export const besideHint = `${besideKey}-click opens beside`;

/** Whether a click or key press asks to open beside. */
export function opensBeside(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | null | undefined): boolean {
  return !!event && (mac ? event.metaKey : event.ctrlKey);
}

/**
 * A list (Library, an Index, a table or the research desk) fills the pane at its right when there is one, so it stays
 * the list. Without one, the modifier opens a pane there; a wide touch screen always does.
 */
export function listOpensBeside(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | null | undefined, neighbour: boolean): boolean {
  return neighbour || opensBeside(event) || window.matchMedia('(pointer: coarse) and (min-width: 900px)').matches;
}
