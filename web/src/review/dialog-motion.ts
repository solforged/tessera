/**
 * Fades a modal dialog out after its component has unmounted. The dialog itself leaves the top layer with the
 * component, so a static copy of its contents fades on `document.body` instead. The copy is inert and ignores the
 * pointer, so focus restoration and input are never held back by the exit.
 * `classes` are the dialog's own classes, so the copy is styled like the dialog.
 */
export function retireDialog(root: HTMLElement, classes: string) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ghost = document.createElement('div');
  ghost.className = `${classes} dialog-exit`;
  ghost.inert = true;
  ghost.setAttribute('aria-hidden', 'true');
  for (const child of root.childNodes) ghost.append(child.cloneNode(true));
  for (const element of ghost.querySelectorAll('[id]')) element.removeAttribute('id');
  document.body.append(ghost);
  const remove = () => { window.clearTimeout(timer); ghost.remove(); };
  const animation = ghost.getAnimations().find(value => value instanceof CSSAnimation && value.animationName === 'dialog-out');
  const end = animation?.effect?.getComputedTiming().endTime;
  if (!animation || typeof end !== 'number' || !Number.isFinite(end) || end <= 0) { ghost.remove(); return; }
  // Completion is authoritative; the timer bounds a paused or stalled effect.
  const timer = window.setTimeout(remove, Math.ceil(end * 2));
  void animation.finished.then(remove, remove);
}
