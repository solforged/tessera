/**
 * Focus rings are for keyboards. A touch screen draws none at rest, even where script moves focus; pressing Tab (a
 * hardware keyboard) sets `data-keyboard` on the root so `:focus-visible` shows again, and the next press clears it.
 */
export function installInputModality(): () => void {
  const root = document.documentElement;
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Tab') root.dataset.keyboard = ''; };
  const pointerdown = () => { delete root.dataset.keyboard; };
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('pointerdown', pointerdown, true);
  return () => {
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('pointerdown', pointerdown, true);
    delete root.dataset.keyboard;
  };
}
