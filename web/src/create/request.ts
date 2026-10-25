import { parseCardText } from '../review/card-text';

/**
 * What the creation slip starts with. Every entry point (⌘N, ⌘E, Find, index and table buttons, the macOS menu and
 * capture panel, Android's shortcuts, share sheet, widget and tile) describes its request in this shape.
 */

/** Built-in kinds, or `type:<key>` for a note kind from the index (`type:person`, `type:concept`). */
export type CreateKind = 'note' | 'question' | 'project' | 'task' | 'card' | 'source' | `type:${string}`;

/**
 * Where a note, question, task or card goes: a section of today's journal, a new titled page, or the end of an
 * existing page. A journal destination without a section means the workshop's capture section; `notes` is the end
 * of the journal, outside every section.
 */
export type CreateInto = { kind: 'journal'; section?: string } | { kind: 'page' } | { kind: 'under'; pageId: string };

export interface CreateRequest {
  kind: CreateKind;
  /** Prefilled text, such as a shared link or the Find query. */
  text: string;
  /** Defaults to today's journal for notes, tasks and cards, and to a new page for the other kinds. */
  into?: CreateInto;
  /** Index, table and ledger buttons fix the kind; the slip hides its kind row. */
  lockKind?: boolean;
  /** Agenda presets a task's schedule without changing its journal destination; typed dates still take precedence. */
  scheduledDate?: string;
  /** Find's “as…” action starts at the kind chooser instead of the draft. */
  focus?: 'kind';
}

const builtIn: Record<string, true> = { note: true, question: true, project: true, task: true, card: true, source: true };

export function isCreateKind(value: unknown): value is CreateKind {
  return typeof value === 'string' && (Object.hasOwn(builtIn, value) || /^type:\S+$/.test(value));
}

/** ⌘E and the plain capture shortcuts: a note at the end of today's journal. */
export const blankCapture = (): CreateRequest => ({ kind: 'note', text: '', into: { kind: 'journal' } });

/**
 * Reads a request from a native bridge or event detail: `{ kind?, text?, into? }`, where `into` is `'journal'` or
 * `'page'`. Anything unreadable is null; a missing kind is a journal note.
 */
export function parseCreateRequest(raw: unknown): CreateRequest | null {
  if (typeof raw === 'string') {
    if (!raw) return null;
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as { kind?: unknown; text?: unknown; into?: unknown };
  if (value.kind !== undefined && value.kind !== null && !isCreateKind(value.kind)) return null;
  if (value.text !== undefined && typeof value.text !== 'string') return null;
  if (value.into !== undefined && value.into !== null && value.into !== 'journal' && value.into !== 'page') return null;
  const request: CreateRequest = { kind: (value.kind as CreateKind | undefined) ?? 'note', text: value.text ?? '' };
  if (value.into === 'journal' || value.into === 'page') request.into = { kind: value.into };
  return request;
}

/** Infer complete creation syntax; tags annotate the draft and never choose its kind. */
export function inferKind(text: string): CreateKind | null {
  const value = text.trim();
  if (!value) return null;
  if (value.endsWith('?')) return 'question';
  if (/^\[ ?\] /.test(text.trimStart())) return 'task';
  if (parseCardText(value).cards.length) return 'card';
  if (/^https?:\/\/\S+$/i.test(value)) {
    try { if (new URL(value).hostname) return 'source'; } catch { /* Incomplete URL. */ }
  }
  const isbn = value.replace(/^(?:urn:)?isbn:?\s*/i, '').replace(/[ -]/g, '');
  if (/^(?:\d{9}[\dX]|\d{13})$/i.test(isbn)) return 'source';
  if (/^(?:doi:)?10\.\d{4,9}\/\S+$/i.test(value)
    || /^(?:arxiv:)?(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(value)) return 'source';
  return null;
}
