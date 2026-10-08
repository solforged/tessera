import { expect, test } from 'bun:test';
import { isValid, ulid } from 'ulid';
import type { Operation, Passage } from '../api/types';
import { parseCardText } from '../review/card-text';
import { bookHighlights, localToday, locateHighlights, seedBatch } from './seed';

test('the demo date uses the visitor’s local civil day', () => {
  expect(localToday(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02');
});

test('the tour is one JSON-able batch with real references, tasks, cards and typed fields', () => {
  const fieldsPage = ulid();
  const batch = seedBatch(fieldsPage, '2026-10-06');
  expect(JSON.parse(JSON.stringify(batch))).toEqual(batch);
  const created = batch.operations.flatMap(op => op.op === 'insert' || op.op === 'create_page' || op.op === 'create_journal' ? [op.id] : []);
  expect(new Set(created).size).toBe(created.length);
  expect(created.every(isValid)).toBe(true);
  expect(batch.operations.find(op => op.op === 'create_journal')).toMatchObject({ date: '2026-10-06' });
  const tasks = batch.operations.filter(op => op.op === 'set_task');
  expect(tasks).toHaveLength(2);
  expect(tasks.every(op => op.task?.scheduled === '2026-10-06')).toBe(true);
  const blocks = batch.operations.filter(op => op.op === 'insert');
  const cardText = blocks.flatMap(op => parseCardText(op.text).cards);
  expect(cardText.map(card => card.kind)).toEqual(['forward', 'forward', 'reverse', 'cloze']);
  expect(blocks.every(op => parseCardText(op.text).problems.length === 0)).toBe(true);
  const definitions = blocks.filter(op => op.parent_id === fieldsPage);
  expect(definitions.map(op => op.text)).toEqual(['Demo effort', 'Demo started']);
  for (const definition of definitions) {
    expect(blocks.filter(op => op.text === `[[${definition.id}]]`)).toHaveLength(2);
  }
  expect(batch.operations.find(op => op.op === 'save_view')).toMatchObject({ name: 'Small experiments', query: { sort: [{ by: 'field', field: definitions[0]!.id, direction: 'asc' }] } });
});

const passage = (id: string, text: string): Passage => ({ id, ordinal: 0, kind: 'paragraph', level: null, text, locator: '', anchor: null, resource: null, marks: [], start: 0 });

test('book highlights cite UTF-16 ranges and drop quotes the extraction no longer contains', () => {
  const [first, second] = bookHighlights;
  const located = locateHighlights([passage('a', `𝕀. ${first!.quote}, and more.`), passage('b', `Then ${second!.quote}.`)]);
  expect(located.map(value => value.quote)).toEqual([first!.quote, second!.quote]);
  expect(located[0]).toMatchObject({ start: { passage_id: 'a', offset: 4 }, end: { passage_id: 'a', offset: 4 + first!.quote.length } });
  expect(located[1]).toMatchObject({ start: { passage_id: 'b', offset: 5 } });
});

test('seeded highlights follow the source page’s existing children and carry their notes and card', () => {
  const book = { id: ulid(), after: ulid(), snapshotId: ulid(), highlights: locateHighlights(bookHighlights.map((value, index) => passage(`p${index}`, value.quote))) };
  const operations = seedBatch(ulid(), '2026-10-06', book).operations;
  type Of<K extends Operation['op']> = Extract<Operation, { op: K }>;
  const inserts = operations.filter((op): op is Of<'insert'> => op.op === 'insert');
  const highlights = inserts.filter(op => op.parent_id === book.id);
  expect(highlights.map(op => op.text)).toEqual(bookHighlights.map(value => value.quote));
  expect(highlights[0]).toMatchObject({ after: book.after });
  const cites = operations.filter((op): op is Of<'cite'> => op.op === 'cite');
  expect(cites.map(op => op.id)).toEqual(highlights.map(op => op.id));
  expect(cites.every(op => op.snapshot_id === book.snapshotId && op.base_revision === 1)).toBe(true);
  const notes = inserts.filter(op => op.parent_id === highlights[0]!.id);
  expect(notes.flatMap(op => parseCardText(op.text).cards).map(card => card.kind)).toEqual(['forward']);
});
