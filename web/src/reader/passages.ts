import type { Citation, Mark, Passage, PassagePoint } from '../api/types';

export interface PassageSelection {
  start: PassagePoint;
  end: PassagePoint;
  first: number;
  last: number;
  quote: string;
  locator: string;
}
export interface CitationRange { citation: Citation; start: number; end: number }
export interface TextSegment { start: number; end: number; text: string; marks: Mark[]; citations: Citation[]; flash: boolean }

/** Endpoints and string slices are UTF-16 throughout, just like the service. */
export function selectedPassages(anchor: PassagePoint, focus: PassagePoint, passages: readonly Passage[]): PassageSelection | null {
  const byId = new Map(passages.map(passage => [passage.id, passage]));
  const a = byId.get(anchor.passage_id), b = byId.get(focus.passage_id);
  if (!a || !b) return null;
  const backwards = a.ordinal > b.ordinal || a.ordinal === b.ordinal && anchor.offset > focus.offset;
  const start = backwards ? focus : anchor, end = backwards ? anchor : focus;
  const first = backwards ? b : a, last = backwards ? a : b;
  if (start.offset < 0 || start.offset > first.text.length || end.offset < 0 || end.offset > last.text.length) return null;
  const selected = passages.filter(p => p.ordinal >= first.ordinal && p.ordinal <= last.ordinal).sort((x, y) => x.ordinal - y.ordinal);
  if (selected.length !== last.ordinal - first.ordinal + 1) return null;
  const quote = selected.map(p => p.text.slice(p.id === start.passage_id ? start.offset : 0, p.id === end.passage_id ? end.offset : p.text.length)).join('\n\n');
  return quote ? { start, end, first: first.ordinal, last: last.ordinal, quote, locator: first.locator } : null;
}

export function citationRange(passage: Passage, citation: Citation, ordinals: ReadonlyMap<string, number>): CitationRange | null {
  const first = ordinals.get(citation.start.passage_id), last = ordinals.get(citation.end.passage_id);
  if (first === undefined || last === undefined || passage.ordinal < first || passage.ordinal > last) return null;
  const start = passage.ordinal === first ? citation.start.offset : 0;
  const end = passage.ordinal === last ? citation.end.offset : passage.text.length;
  return end > start ? { citation, start, end } : null;
}

/** Split at every boundary so crossing marks and citations preserve the text once. */
export function passageSegments(passage: Passage, ranges: readonly CitationRange[], flashId: string | null): TextSegment[] {
  const boundaries = new Set([0, passage.text.length]);
  for (const range of [...passage.marks, ...ranges]) {
    boundaries.add(Math.max(0, Math.min(passage.text.length, range.start)));
    boundaries.add(Math.max(0, Math.min(passage.text.length, range.end)));
  }
  const edges = [...boundaries].sort((a, b) => a - b);
  return edges.slice(0, -1).map((start, index) => {
    const end = edges[index + 1]!;
    const citations = ranges.filter(range => range.start <= start && range.end >= end).map(range => range.citation);
    return { start, end, text: passage.text.slice(start, end), marks: passage.marks.filter(mark => mark.start <= start && mark.end >= end), citations, flash: citations.some(citation => citation.id === flashId) };
  });
}

/** Count only text nodes; wrappers for marks, links and tints add no offsets. */
export function passagePoint(root: HTMLElement, node: Node, offset: number): PassagePoint | null {
  if (!root.contains(node)) return null;
  let total = 0, found = false;
  const walk = (current: Node) => {
    if (found) return;
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) total += Math.min(offset, current.textContent?.length ?? 0);
      else for (const child of Array.from(current.childNodes).slice(0, offset)) total += child.textContent?.length ?? 0;
      found = true;
    } else if (current.nodeType === Node.TEXT_NODE) total += current.textContent?.length ?? 0;
    else for (const child of current.childNodes) walk(child);
  };
  walk(root);
  return found && root.dataset.passageId ? { passage_id: root.dataset.passageId, offset: total } : null;
}

export function selectionInPassages(container: HTMLElement, selection: Selection, passages: readonly Passage[]): PassageSelection | null {
  if (selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return null;
  const element = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>('[data-passage-id]');
  const anchor = element(selection.anchorNode), focus = element(selection.focusNode);
  if (!anchor || !focus || !container.contains(anchor) || !container.contains(focus)) return null;
  const a = passagePoint(anchor, selection.anchorNode, selection.anchorOffset), b = passagePoint(focus, selection.focusNode, selection.focusOffset);
  return a && b ? selectedPassages(a, b, passages) : null;
}
