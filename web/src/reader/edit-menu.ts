import { highlightColors } from '../library/highlights';
import type { Citation } from '../api/types';

interface EditMenuBridge {
  tesseraNative?: { editMenu?: boolean };
  webkit?: { messageHandlers?: { tesseraEditMenu?: { postMessage(message: EditMenuMessage): void } } };
}
interface EditMenuAction { id: string; label: string; color?: string }
type EditMenuMessage = { mode: 'none' } | { mode: 'highlight'; actions: EditMenuAction[] };

/** What a tap in the system's text-selection menu asks for: a colour paints the selection, Annotate paints it and opens a note. */
export type EditMenuTap = { kind: 'highlight'; color: Citation['color'] } | { kind: 'annotate' };

const host = () => window as unknown as EditMenuBridge;

/** The iOS app puts Tessera's actions at the front of the system's own selection menu (`window.tesseraNative.editMenu`); elsewhere the reader draws its own panel. */
export const nativeEditMenu = () => !!host().tesseraNative?.editMenu && !!host().webkit?.messageHandlers?.tesseraEditMenu;

let posted = '';
function post(message: EditMenuMessage) {
  const text = JSON.stringify(message);
  if (text === posted) return;
  posted = text;
  host().webkit?.messageHandlers?.tesseraEditMenu?.postMessage(message);
}

/** The selection gets the five colours and Annotate; the colour dots read the theme, so a Day or Night page paints its own. */
export function showEditMenu() {
  const style = getComputedStyle(document.documentElement);
  post({ mode: 'highlight', actions: [
    ...highlightColors.map(color => ({ id: `highlight:${color}`, label: `Highlight ${color}`, color: style.getPropertyValue(`--highlight-${color}`).trim() })),
    { id: 'annotate', label: 'Annotate' },
  ] });
}

/** The selection gets the system's plain menu. */
export function hideEditMenu() { post({ mode: 'none' }); }

/** Taps in the menu; returns what undoes the listener. */
export function onEditMenu(handle: (tap: EditMenuTap) => void): () => void {
  const listener = (event: Event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id ?? '';
    if (id === 'annotate') { handle({ kind: 'annotate' }); return; }
    const color = id.startsWith('highlight:') ? id.slice('highlight:'.length) : '';
    if ((highlightColors as readonly string[]).includes(color)) handle({ kind: 'highlight', color: color as Citation['color'] });
  };
  window.addEventListener('tessera:edit-menu', listener);
  return () => window.removeEventListener('tessera:edit-menu', listener);
}
