import { describe, expect, test } from 'bun:test';
import { inferKind } from './request';

import type { NoteKind } from '../api/types';
describe('creation kind inference', () => {
  test('questions take precedence over other syntax', () => {
    expect(inferKind('  Is X?  ')).toBe('question');
    expect(inferKind('[] Is X?')).toBe('question');
    expect(inferKind('Is X? Not sure')).toBeNull();
  });
  test('only a task prefix makes a task; planning alone leaves an appointment', () => {
    for (const text of ['[] buy tiles', '[ ] buy tiles']) expect(inferKind(text)).toBe('task');
    for (const text of ['buy tiles @fri', 'buy tiles @2026-10-20', 'buy tiles friday', 'buy tiles @nonsense', '`@fri`', '[[buy @fri]]', 'mail a@b.com', '[ ]']) expect(inferKind(text)).toBeNull();
  });
  test('complete card syntax uses the shared parser', () => {
    for (const text of ['Front >> Back', 'Front <> Back', '{{c1::answer}}']) expect(inferKind(text)).toBe('card');
    for (const text of ['Front >>', '`Front >> Back`', '[[Front >> Back]]', 'Front \\>> Back']) expect(inferKind(text)).toBeNull();
  });
  test('tag inference follows identity rather than a stale alias', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const kinds: NoteKind[] = [{ key: `type:${id}`, name: 'Arabe', plural: 'Arabe', icon: null, type_id: id }];
    expect(inferKind(`read #[[${id}|Arabic]]`, kinds)).toBe(`type:type:${id}`);
    expect(inferKind('#Arabe', kinds)).toBe(`type:type:${id}`);
    expect(inferKind('#Arabic', kinds)).toBeNull();
    expect(inferKind(`\`#[[${id}|Arabic]]\``, kinds)).toBeNull();
  });
  test('a source identifier must occupy the whole draft', () => {
    for (const text of ['https://example.org/article', '9780393339758', '0-393-33975-0', 'ISBN: 978-0-393-33975-8', '10.1000/example', 'doi:10.1000/example', 'arxiv:2401.12345v2', 'hep-th/9901001']) expect(inferKind(text)).toBe('source');
    for (const text of ['', 'https://', 'Read https://example.org', 'ISBN 123', '978039333975', 'See 10.1000/example', '2401.12', 'buy 9780393339758']) expect(inferKind(text)).toBeNull();
  });
});
