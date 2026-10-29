/** Inline confirmations: Cancel, the safe default, takes focus when one opens. */
export function focusCancel(button: HTMLElement): void {
  queueMicrotask(() => button.focus({ preventScroll: true }));
}

/** Closes an inline confirmation and returns focus to the button that opened it, found by `data-confirm` in the enclosing row. */
export function cancelConfirm(from: Element, trigger: string, close: () => void): void {
  const scope = from.closest('li, .settings-row, .devices-actions');
  close();
  scope?.querySelector<HTMLElement>(`[data-confirm="${trigger}"]`)?.focus({ preventScroll: true });
}

/** Escape inside an inline confirmation cancels it, like its Cancel button. */
export function escapeConfirm(event: KeyboardEvent & { currentTarget: Element }, trigger: string, close: () => void): void {
  if (event.key !== 'Escape') return;
  event.preventDefault(); event.stopPropagation();
  cancelConfirm(event.currentTarget, trigger, close);
}
