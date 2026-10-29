/** Task ids of the rows after `row`, then those before it nearest first, across the sections of its `[data-task-rows]` region. Rows already leaving are skipped. */
export function neighbourTaskIds(row: Element): string[] {
  const rows = [...(row.closest('[data-task-rows]') ?? row.parentElement)?.querySelectorAll<HTMLElement>('.agenda-row') ?? []], at = rows.findIndex(candidate => candidate === row);
  return [...rows.slice(at + 1), ...rows.slice(0, Math.max(at, 0)).reverse()].filter(candidate => !('leaving' in candidate.dataset)).map(candidate => candidate.dataset.taskId).filter((id): id is string => !!id);
}

/**
 * Keeps the keyboard in the list when a refetch removes `origin`: once it is gone and focus is lost, the first of `ids`
 * still listed takes focus. A row the refetch keeps but re-parents gets its own source back. Focus the user moved
 * elsewhere is left alone.
 */
export function handOffFocus(origin: Element, ids: readonly string[], owner?: HTMLElement | null): void {
  const until = performance.now() + 2500;
  const lost = () => { const active = document.activeElement; return !active || active === document.body || !active.isConnected || active === owner; };
  const target = () => {
    for (const id of ids) {
      const source = document.querySelector<HTMLElement>(`.agenda-row[data-task-id="${CSS.escape(id)}"]:not([data-leaving]) .agenda-source`);
      if (source) return source;
    }
    return null;
  };
  let settled = 0;
  const step = () => {
    const now = performance.now();
    if (!origin.isConnected) {
      if (lost()) {
        const next = target();
        // A refetch can still replace the row just focused, so focus is held for a moment after it lands.
        if (next) { next.focus({ preventScroll: true }); settled = now + 300; }
      } else if (!settled) return;
    } else if (!('leaving' in (origin as HTMLElement).dataset) && lost() && !origin.contains(document.activeElement)) {
      // The refetch kept the row but moved it, which drops focus: the row's own source takes it back.
      const own = origin.querySelector<HTMLElement>('.agenda-source');
      if (own) { own.focus({ preventScroll: true }); settled = now + 300; }
    }
    if (settled ? now < settled : now < until) requestAnimationFrame(step);
    else if (!settled && !origin.isConnected && owner?.isConnected && lost()) { if (!owner.hasAttribute('tabindex')) owner.tabIndex = -1; owner.focus({ preventScroll: true }); }
  };
  requestAnimationFrame(step);
}
