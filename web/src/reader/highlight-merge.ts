import type { Citation, HighlightRow, PassagePoint } from '../api/types';

export interface HighlightGroup {
  rows: HighlightRow[];
  start: PassagePoint;
  end: PassagePoint;
  selected: boolean;
}

/** Connected ranges include touching endpoints, but never cross snapshot boundaries. */
export function overlappingHighlights(rows: readonly HighlightRow[], ordinals: ReadonlyMap<string, number>, selection?: Pick<Citation, 'snapshot_id' | 'start' | 'end'>): HighlightGroup[] {
  const compare = (a: PassagePoint, b: PassagePoint) => {
    const first = ordinals.get(a.passage_id), last = ordinals.get(b.passage_id);
    if (first === undefined || last === undefined) throw new Error('Passage not found.');
    return first - last || a.offset - b.offset;
  };
  const ranges: { row?: HighlightRow; snapshot: string; start: PassagePoint; end: PassagePoint }[] = rows.map(row => ({ row, snapshot: row.citation.snapshot_id, start: row.citation.start, end: row.citation.end }));
  if (selection) ranges.push({ snapshot: selection.snapshot_id, start: selection.start, end: selection.end });
  ranges.sort((a, b) => a.snapshot.localeCompare(b.snapshot) || compare(a.start, b.start));
  const groups: HighlightGroup[] = [];
  let snapshot = '';
  for (const range of ranges) {
    let group = groups.at(-1);
    if (!group || snapshot !== range.snapshot || compare(range.start, group.end) > 0) {
      group = { rows: [], start: range.start, end: range.end, selected: false };
      groups.push(group); snapshot = range.snapshot;
    }
    if (range.row) group.rows.push(range.row);
    else group.selected = true;
    if (compare(range.end, group.end) > 0) group.end = range.end;
  }
  for (const group of groups) group.rows.sort((a, b) => a.created_at - b.created_at || a.citation.id.localeCompare(b.citation.id));
  return groups.filter(group => selection ? group.selected : group.rows.length > 1);
}

/** References and citations authored on another page are never removed. */
export function mergeMembers(group: HighlightGroup, sourceId: string, referenced: ReadonlySet<string>, newColor: Citation['color'] = null) {
  const survivor = group.rows.find(row => row.block.block.page_id === sourceId);
  const rest = group.rows.filter(row => row !== survivor);
  const kept = rest.filter(row => row.block.block.page_id !== sourceId || referenced.has(row.block.block.id));
  const removed = rest.filter(row => !kept.includes(row));
  const color = survivor?.citation.color ?? newColor ?? removed.find(row => row.citation.color)?.citation.color ?? null;
  return { survivor, kept, removed, color };
}
