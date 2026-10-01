import { expect, test } from 'bun:test';
import { generateOutline } from '@spike/shared';
import { OutlineIndex } from '../../react-codemirror/src/outline-index';

test('range edits preserve IDs, ranks and descendant boundaries', () => {
  let rows = generateOutline(128);
  const outline = new OutlineIndex(rows);
  let seed = 20261001;
  let fresh = 0;
  const random = (limit: number) => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % limit;
  };
  for (let step = 0; step < 400; step++) {
    const at = random(rows.length);
    const count = Math.min(1 + random(5), rows.length - at);
    switch (step % 4) {
      case 0: {
        const text = rows[at].text + ` ${step}`;
        outline.setText(rows[at].id, text);
        rows[at] = { ...rows[at], text };
        break;
      }
      case 1: {
        const removed = rows.slice(at, at + count);
        const inserted = [{ id: `fresh-${fresh++}`, text: `Inserted ${step}`, depth: rows[at].depth }];
        outline.splice(at, count, inserted);
        rows.splice(at, count, ...inserted);
        for (const row of removed) expect(outline.get(row.id)).toBeUndefined();
        break;
      }
      case 2: {
        const to = random(rows.length - count + 1);
        outline.move(at, count, to);
        const moved = rows.splice(at, count);
        rows.splice(to, 0, ...moved);
        break;
      }
      case 3: {
        outline.shiftDepth(at, count, 1);
        for (let i = at; i < at + count; i++) rows[i] = { ...rows[i], depth: rows[i].depth + 1 };
        break;
      }
    }
    expect(outline.toArray()).toEqual(rows);
    for (let i = 0; i < rows.length; i++) {
      expect(outline.at(i)).toEqual(rows[i]);
      expect(outline.indexOf(rows[i].id)).toBe(i);
      let end = i + 1;
      while (end < rows.length && rows[end].depth > rows[i].depth) end++;
      expect(outline.subtreeEnd(i)).toBe(end);
      let previous = i - 1;
      while (previous >= 0 && rows[previous].depth > rows[i].depth) previous--;
      expect(outline.previousBoundary(i, rows[i].depth)).toBe(previous);
    }
    expect(outline.slice(at, Math.min(at + 4, rows.length))).toEqual(rows.slice(at, at + 4));
  }
});
