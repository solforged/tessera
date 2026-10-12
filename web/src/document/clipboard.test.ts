import { expect, test } from 'bun:test';
import type { TaskState } from '../api/types';
import type { BlockClipboard, ClipboardBlock } from './contract';
import { clipboardPlainText, clipboardText, parseBlockClipboard } from './clipboard';
import { emptyCapabilities } from './types';

const todo: TaskState = { status: 'todo', scheduled: '2026-10-12', scheduled_time: '17:30', deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: 'high', completed_on: null };
function block(id: string, text: string, depth = 0, task: TaskState | null = null): ClipboardBlock {
  return {
    block: { id, text, kind: 'block', parent_id: depth ? 'parent' : 'page', page_id: 'page', heading: null, archived: false, kept_copy: null, revision: 1, created_at: 0, updated_at: 0 },
    depth, manualTypes: [], capabilities: { ...emptyCapabilities(id), task },
  };
}

test('plain block clipboard text carries relative indentation, task markers and card syntax', () => {
  const content: BlockClipboard = { version: 1, scope: 'notebook', cut: false, blocks: [
    block('parent', 'Parent', 0, todo), block('child', 'Front >> Back', 1), block('grandchild', 'Nested', 2), block('other', 'Other child', 1), block('next', 'Next'),
  ] };
  expect(clipboardText(content)).toBe('[ ] Parent\n  Front >> Back\n    Nested\n  Other child\nNext');
});

test('structured clipboard data keeps multiline block boundaries and a single selected row', () => {
  const content: BlockClipboard = { version: 1, scope: 'notebook', cut: true, blocks: [block('parent', 'Front >>>\nAnswer one\nAnswer two', 0, todo)] };
  content.blocks[0]!.manualTypes = ['History'];
  expect(parseBlockClipboard(JSON.stringify(content))).toEqual(content);
  expect(clipboardText(content)).toBe('[ ] Front >>>\nAnswer one\nAnswer two');
});

test('malformed structured clipboard data cannot supply a destructive replacement', () => {
  const content: BlockClipboard = { version: 1, scope: 'notebook', cut: false, blocks: [block('parent', 'Parent'), block('child', 'Child', 1)] };
  expect(parseBlockClipboard('not json')).toBeNull();
  for (const changed of [
    { ...content, version: 2 },
    { ...content, blocks: [] },
    { ...content, blocks: [block('parent', 'Parent', 1)] },
    { ...content, blocks: [block('parent', 'Parent'), block('child', 'Child', 2)] },
    { ...content, blocks: [block('parent', 'Parent'), block('parent', 'Duplicate')] },
    { ...content, blocks: [{ ...block('parent', 'Parent'), capabilities: { task: {} } }] },
  ]) expect(parseBlockClipboard(JSON.stringify(changed))).toBeNull();
});

test('absent text/plain is distinct from an explicitly empty plain-text paste', () => {
  for (const types of [['text/html'], ['image/png'], []]) {
    expect(clipboardPlainText({ types, getData: () => '' })).toBeNull();
  }
  expect(clipboardPlainText({ types: ['text/plain'], getData: () => '' })).toBe('');
  expect(clipboardPlainText({ types: ['text/html', 'text/plain'], getData: type => type === 'text/plain' ? 'Plain text' : '<p>Rich text</p>' })).toBe('Plain text');
});
