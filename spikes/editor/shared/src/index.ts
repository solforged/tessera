/**
 * Shared by every editor variant and the runner: the outline every variant
 * renders, and the `window.spike` interface the runner drives.
 */

export interface OutlineRow {
  id: string;
  text: string;
  /** 0 for top-level rows. A row's depth is at most its predecessor's + 1. */
  depth: number;
}

export interface Caret {
  /** Row ID. */
  id: string;
  /** UTF-16 code units into the row's text, as in the DOM and CodeMirror. */
  offset: number;
}

export interface Selection {
  anchor: Caret;
  head: Caret;
}

export type VimMode = 'normal' | 'insert' | 'visual';

/**
 * Installed by each variant as `window.spike` once its page is usable. The
 * runner reads it; it drives input only through real browser events.
 */
export interface SpikeApi {
  /** Variant name, e.g. `react-codemirror`. */
  readonly name: string;
  /** Place the caret in a row (by preorder index) and focus its editor. */
  focus(index: number, offset: number): void;
  /** The current outline in preorder. */
  model(): OutlineRow[];
  /** The current selection, or null when nothing is focused. */
  selection(): Selection | null;
  /** Vim mode when Vim is enabled, otherwise null. */
  vimMode(): VimMode | null;
  /** Text the variant would put on the clipboard for the current selection. */
  copyText(): string;
}

declare global {
  interface Window {
    spike?: SpikeApi;
  }
}

/** Page options a variant reads from its URL: `?rows=2000&vim=1`. */
export interface SpikeOptions {
  rows: number;
  vim: boolean;
}

export function readOptions(search: string = location.search): SpikeOptions {
  const params = new URLSearchParams(search);
  const rows = Number(params.get('rows') ?? 2000);
  return {
    rows: Number.isInteger(rows) && rows > 0 ? rows : 2000,
    vim: params.get('vim') === '1',
  };
}

/** Deterministic 32-bit generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'evidence question source claim passage reading notes author definition ' +
  'compare position answer criteria review project outcome deadline study ' +
  'chapter argument example context outline block reference summary draft ' +
  'interpretation counterexample method result assumption history change'
).split(' ');

/**
 * The same outline for the same row count, in every variant. Mixed lengths
 * (one word to several sentences, some with line breaks), depths up to 6,
 * and about one row in eight holding a `[[id]]` reference to an earlier row.
 */
export function generateOutline(rows: number, seed = 20261001): OutlineRow[] {
  const next = random(seed ^ rows);
  const out: OutlineRow[] = [];
  for (let index = 0; index < rows; index++) {
    const previous = out[index - 1];
    let depth = 0;
    if (previous) {
      const roll = next();
      if (roll < 0.3 && previous.depth < 6) depth = previous.depth + 1;
      else if (roll < 0.75) depth = previous.depth;
      else depth = Math.max(0, previous.depth - 1 - Math.floor(next() * 2));
    }
    const lengthRoll = next();
    const words = lengthRoll < 0.2 ? 1 + Math.floor(next() * 3) : lengthRoll < 0.9 ? 5 + Math.floor(next() * 20) : 40 + Math.floor(next() * 60);
    const parts: string[] = [];
    for (let word = 0; word < words; word++) {
      parts.push(WORDS[Math.floor(next() * WORDS.length)]!);
      if (words > 40 && next() < 0.03) parts.push('\n');
    }
    let text = parts.join(' ').replace(/ \n /g, '\n');
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (index > 10 && next() < 0.125) {
      const target = out[Math.floor(next() * index)]!;
      text += ` [[${target.id}]]`;
    }
    out.push({ id: `r${index.toString(36).padStart(5, '0')}`, text, depth });
  }
  return out;
}

/** `[[id]]` and `[[id|alias]]` references inside a row's text. */
export const REFERENCE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Plain-text form of a cross-block selection: one line per row touched,
 * indented two spaces per depth relative to the shallowest row, with the
 * first and last rows clipped at the selection ends. Every variant's
 * `copyText()` must match this for the same selection.
 */
export function selectionText(rows: OutlineRow[], selection: Selection): string {
  const indexOf = new Map(rows.map((row, index) => [row.id, index]));
  let start = selection.anchor;
  let end = selection.head;
  const a = indexOf.get(start.id);
  const b = indexOf.get(end.id);
  if (a === undefined || b === undefined) return '';
  if (a > b || (a === b && start.offset > end.offset)) [start, end] = [end, start];
  const first = Math.min(a, b);
  const last = Math.max(a, b);
  const slice = rows.slice(first, last + 1);
  const base = Math.min(...slice.map(row => row.depth));
  return slice
    .map((row, index) => {
      let text = row.text;
      if (index === slice.length - 1) text = text.slice(0, end.offset);
      if (index === 0) text = text.slice(start.offset);
      return '  '.repeat(row.depth - base) + text;
    })
    .join('\n');
}
