import type { Occlusion, Rect } from '../api/types';

/** Keep invalid editor drafts out of the durable document outbox. The service remains authoritative. */
export function prepareOcclusionDraft(state: Occlusion): Occlusion | null {
  if (!state.masks.length) return null;
  const invalid = (reason: string): never => { throw new Error(`These masks are not valid: ${reason}.`); };
  const rectValid = (rect: Rect) => [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.w >= .005 && rect.h >= .005 && rect.x + rect.w <= 1 && rect.y + rect.h <= 1;
  if (state.groups.length > 100 || state.masks.length > 300) invalid('there are more than 100 groups or 300 masks');
  const groups = new Map<string, number>();
  const normalized = state.groups.map(group => {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(group.id) || groups.has(group.id)) invalid('group identifiers must be unique letters, numbers, underscores or dashes');
    groups.set(group.id, 0);
    const next = { ...group };
    for (const key of ['hint', 'answer'] as const) {
      const text = next[key]?.trim();
      if (text && [...text].length > 200) invalid('a hint or answer is longer than 200 characters');
      if (text) next[key] = text; else delete next[key];
    }
    if (next.area && !rectValid(next.area)) invalid('an area lies outside the image or is too small');
    return next;
  });
  const masks = new Set<string>();
  for (const mask of state.masks) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(mask.id) || masks.has(mask.id)) invalid('mask identifiers must be unique letters, numbers, underscores or dashes');
    masks.add(mask.id);
    const count = groups.get(mask.group);
    if (count === undefined) invalid('a mask has no group');
    groups.set(mask.group, count! + 1);
    if (!rectValid(mask)) invalid('a mask lies outside the image or is too small');
  }
  if ([...groups.values()].some(count => !count)) invalid('a group has no masks');
  return { ...state, groups: normalized };
}
