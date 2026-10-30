import { createMemo } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { NotebookClient } from '../document/contract';

/** Legacy IANA names Intl may still report, and the names Tessera shows instead. */
export const zoneAliases: Record<string, string> = {
  'Africa/Asmera': 'Africa/Asmara', 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kiev': 'Europe/Kyiv',
  'America/Godthab': 'America/Nuuk', 'Pacific/Truk': 'Pacific/Chuuk', 'Pacific/Ponape': 'Pacific/Pohnpei', 'Pacific/Enderbury': 'Pacific/Kanton',
};

export function canonicalZone(value: string): string {
  const canonical = zoneAliases[value] ?? new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  return zoneAliases[canonical] ?? canonical;
}

export const deviceZone = () => canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone);

/** The workshop's journal zone, or this device's while it has none. */
export function workshopZone(notebook: NotebookClient): Accessor<string> {
  const device = deviceZone();
  return createMemo(() => canonicalZone(notebook.settings()?.time_zone ?? device));
}

/** `2026-10-20 06:51`: a local ISO date and 24-hour minute in `zone`. Settings and History write every time this way. */
export function isoMinute(value: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** `2026-10-20`, in `zone`. */
export function isoDate(value: number, zone: string): string {
  return isoMinute(value, zone).slice(0, 10);
}

/** `Oct 29`, or `Oct 29, 2025` in a year other than `now`'s: a date in prose, in `zone`. */
export function shortDate(value: number, zone: string, now = Date.now()): string {
  const year = (at: number) => new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric' }).format(at);
  return new Intl.DateTimeFormat('en', { timeZone: zone, month: 'short', day: 'numeric', ...(year(value) === year(now) ? {} : { year: 'numeric' }) }).format(value);
}
