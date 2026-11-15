import type { Type } from '../api/types';
import type { WorkshopClient } from '../document/contract';
import { typeKeys } from './templates';

export interface TemplateOffer {
  type: Type;
  fieldId: string;
}

/** `type field` pairs already offered in this window, whatever the answer; Not now lasts until reload. */
const offered = new WeakMap<WorkshopClient, Set<string>>();
const checking = new WeakMap<WorkshopClient, Set<string>>();
const mark = (map: WeakMap<WorkshopClient, Set<string>>, workshop: WorkshopClient) => {
  let set = map.get(workshop);
  if (!set) map.set(workshop, (set = new Set()));
  return set;
};

/**
 * The first of the owner's types whose template lacks `fieldId` although another member already has a value
 * for it, so this use is at least the second. A field used once may be a one-off, so the first use offers nothing.
 */
export async function templateOffer(
  workshop: WorkshopClient,
  owner: { id: string; text: string; manual_types: readonly string[] },
  fieldId: string,
): Promise<TemplateOffer | null> {
  const done = mark(offered, workshop);
  const busy = mark(checking, workshop);
  for (const key of typeKeys(owner.text, owner.manual_types)) {
    const typeId = /^[0-9a-hjkmnp-tv-z]{26}$/i.test(key) ? key.toUpperCase() : await workshop.pageByTitle(key, false);
    if (!typeId) continue;
    const pair = `${typeId} ${fieldId}`;
    if (done.has(pair) || busy.has(pair)) continue;
    busy.add(pair);
    try {
      const type = await workshop.api.type(typeId);
      if (type.fields.includes(fieldId)) {
        done.add(pair);
        continue;
      }
      const used = await workshop.api.query({
        type: typeId,
        text: null,
        filters: [{ field: fieldId, op: 'set', value: null }],
        sort: [],
        limit: 2,
      });
      if (!used.rows.some(row => row.block.block.id !== owner.id) || done.has(pair)) continue;
      done.add(pair);
      return { type, fieldId };
    } finally {
      busy.delete(pair);
    }
  }
  return null;
}
