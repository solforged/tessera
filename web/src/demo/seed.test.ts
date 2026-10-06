import { expect, test } from 'bun:test';
import { isValid, ulid } from 'ulid';
import { parseCardText } from '../review/card-text';
import { localToday, seedBatch } from './seed';

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
