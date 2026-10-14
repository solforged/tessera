import type { Filter, Type } from '../api/types';
import { autoPlural } from './presentation';

/** Fields the type requires; older services send none. */
export const requiredIds = (type: Type | null | undefined): ReadonlySet<string> => new Set(type?.required?.map(field => field.field_id) ?? []);

/** Why a required field stays in its type's template, such as “Books require author.” */
export function requiredReason(type: Type, name: string): string {
  const plural = type.plural?.trim() || autoPlural(type.page.text.trim());
  return `${plural.charAt(0).toLocaleUpperCase()}${plural.slice(1)} require ${name}.`;
}

/** The filter listing members without a nonblank value for a required field. */
export const missingFilter = (field: string): Filter => ({ field, op: 'empty', value: null });
