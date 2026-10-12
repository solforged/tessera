interface TextPatch { from: number; to: number; insert: string[] }

/** Apply a text change to a newer version, refusing overlapping edits. */
export function rebaseText(expected: string, desired: string, current: string): string | null {
  if (expected === current) return desired;
  if (expected === desired || desired === current) return current;
  const base = Array.from(expected), next = Array.from(desired), remote = Array.from(current);
  const localPatches = patches(base, next), remotePatches = patches(base, remote);
  for (const local of localPatches) for (const other of remotePatches) {
    const localInsert = local.from === local.to, remoteInsert = other.from === other.to;
    if (localInsert && remoteInsert ? local.from === other.from
      : localInsert ? local.from > other.from && local.from < other.to
      : remoteInsert ? other.from > local.from && other.from < local.to
      : Math.max(local.from, other.from) < Math.min(local.to, other.to)) return null;
  }
  const position = (offset: number, start: boolean) => offset + remotePatches.reduce((shift, patch) =>
    patch.to < offset || patch.to === offset && (start || patch.from !== patch.to)
      ? shift + patch.insert.length - (patch.to - patch.from) : shift, 0);
  const result: string[] = [];
  let cursor = 0;
  for (const patch of localPatches) {
    const from = position(patch.from, true), to = position(patch.to, false);
    result.push(remote.slice(cursor, from).join(''), patch.insert.join(''));
    cursor = to;
  }
  result.push(remote.slice(cursor).join(''));
  return result.join('');
}

function patches(before: string[], after: string[]): TextPatch[] {
  const result: TextPatch[] = [];
  const walk = (from: number, to: number, nextFrom: number, nextTo: number) => {
    while (from < to && nextFrom < nextTo && before[from] === after[nextFrom]) { from++; nextFrom++; }
    while (from < to && nextFrom < nextTo && before[to - 1] === after[nextTo - 1]) { to--; nextTo--; }
    if (from === to && nextFrom === nextTo) return;
    const split = from < to && nextFrom < nextTo ? midpoint(before, from, to, after, nextFrom, nextTo) : null;
    if (split && (split[0] !== from || split[1] !== nextFrom) && (split[0] !== to || split[1] !== nextTo)) {
      walk(from, split[0], nextFrom, split[1]);
      walk(split[0], to, split[1], nextTo);
    } else {
      const previous = result.at(-1);
      if (previous?.to === from) { previous.to = to; previous.insert.push(...after.slice(nextFrom, nextTo)); }
      else result.push({ from, to, insert: after.slice(nextFrom, nextTo) });
    }
  };
  walk(0, before.length, 0, after.length);
  return result;
}

/** Myers' bidirectional shortest-edit search, keeping only two frontiers. */
function midpoint(a: string[], aFrom: number, aTo: number, b: string[], bFrom: number, bTo: number): [number, number] | null {
  const n = aTo - aFrom, m = bTo - bFrom, distance = Math.ceil((n + m) / 2);
  const offset = distance, length = 2 * distance + 3;
  const forward = new Int32Array(length).fill(-1), reverse = new Int32Array(length).fill(-1);
  forward[offset + 1] = reverse[offset + 1] = 0;
  const delta = n - m, odd = delta % 2 !== 0;
  let forwardStart = 0, forwardEnd = 0, reverseStart = 0, reverseEnd = 0;
  for (let d = 0; d <= distance; d++) {
    for (let k = -d + forwardStart; k <= d - forwardEnd; k += 2) {
      const at = offset + k;
      let x = k === -d || k !== d && forward[at - 1]! < forward[at + 1]! ? forward[at + 1]! : forward[at - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aFrom + x] === b[bFrom + y]) { x++; y++; }
      forward[at] = x;
      if (x > n) forwardEnd += 2;
      else if (y > m) forwardStart += 2;
      else if (odd) {
        const other = offset + delta - k;
        if (other >= 0 && other < length && reverse[other]! >= 0 && x >= n - reverse[other]!) return [aFrom + x, bFrom + y];
      }
    }
    for (let k = -d + reverseStart; k <= d - reverseEnd; k += 2) {
      const at = offset + k;
      let x = k === -d || k !== d && reverse[at - 1]! < reverse[at + 1]! ? reverse[at + 1]! : reverse[at - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aTo - x - 1] === b[bTo - y - 1]) { x++; y++; }
      reverse[at] = x;
      if (x > n) reverseEnd += 2;
      else if (y > m) reverseStart += 2;
      else if (!odd) {
        const other = offset + delta - k;
        if (other >= 0 && other < length && forward[other]! >= 0 && forward[other]! >= n - x) {
          const splitX = forward[other]!;
          return [aFrom + splitX, bFrom + splitX - (delta - k)];
        }
      }
    }
  }
  return null;
}
