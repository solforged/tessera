import { expect, test } from 'bun:test';
import { changeHolderText, fileUnderText, usePlaceReason, usePlaceText } from './position-links';

const holder = '01M4RZJX971SKDQGB4JJJ582EN';
const subject = '01M4RZJX971SKDQGB4JJJ582EJ';

test('holder changes replace only the first link and preserve prose and other links', () => {
  const prose = `Before [[old|Old holder]] says [[question|authored subject]] matters.`;
  expect(changeHolderText(prose, holder)).toBe(`Before [[${holder}]] says [[question|authored subject]] matters.`);
  expect(changeHolderText(prose, holder, 'New alias')).toBe(`Before [[${holder}|New alias]] says [[question|authored subject]] matters.`);
  expect(changeHolderText('A claim without links.', holder)).toBe(`[[${holder}]] A claim without links.`);
});

test('filing replaces the second occurrence or inserts immediately after the holder', () => {
  expect(fileUnderText('[[person|P]] argues [[old|Q]] applies; [[evidence]] stays.', subject)).toBe(`[[person|P]] argues [[${subject}]] applies; [[evidence]] stays.`);
  const original = 'Before [[person|P]] keeps the claim.';
  const filed = fileUnderText(original, subject);
  expect(filed).toBe(`Before [[person|P]] [[${subject}]] keeps the claim.`);
  expect(usePlaceText(filed)).toBe(original);
  expect(() => fileUnderText('No holder', subject)).toThrow('Choose a holder');
});

test('Use place does not remove a subject woven into authored prose', () => {
  expect(usePlaceReason('[[person]] argues about [[subject]]')).toContain('part of the prose');
  expect(usePlaceReason('[[person]] [[subject]]-shaped claim')).toContain('part of the prose');
  expect(() => usePlaceText('[[person]] argues about [[subject]]')).toThrow('part of the prose');
  expect(usePlaceReason('[[person]]')).toContain('already uses its place');
  expect(usePlaceText('[[person]] [[subject]]')).toBe('[[person]]');
});
