/**
 * Eases `element` from `from` to the height it has now, over `--motion-ui`, so content that changed its size in one
 * step glides instead of jumping. Returns undefined when nothing moves or motion is reduced (the token is zero then).
 */
export function settleHeight(element: HTMLElement, from: number): Animation | undefined {
  const style = getComputedStyle(element);
  const time = style.getPropertyValue('--motion-ui').trim();
  const duration = parseFloat(time) * (time.endsWith('ms') ? 1 : 1000);
  const to = element.offsetHeight;
  if (!duration || !from || Math.abs(from - to) < 1) return undefined;
  return element.animate(
    [{ height: `${from}px`, overflow: 'clip' }, { height: `${to}px`, overflow: 'clip' }],
    { duration, easing: style.getPropertyValue('--motion-ease').trim() || 'ease-out' },
  );
}
