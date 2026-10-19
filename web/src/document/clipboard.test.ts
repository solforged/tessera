import { expect, test } from 'bun:test';
import type { TaskState } from '../api/types';
import type { BlockClipboard, ClipboardBlock } from './contract';
import { clipboardPasteRows, clipboardPlainText, clipboardText, clipboardUrl, externalLink, markdownPasteRows, parseBlockClipboard } from './clipboard';
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

test('appointment clipboard preserves null status and planning without a plain-text checkbox', () => {
  const appointment: TaskState = { ...todo, status: null, scheduled: '2026-10-23', deadline: '2026-10-30' };
  const content: BlockClipboard = { version: 1, scope: 'notebook', cut: false, blocks: [block('appointment', 'Copy appointment', 0, appointment)] };
  expect(parseBlockClipboard(JSON.stringify(content))).toEqual(content);
  expect(clipboardText(content)).toBe('Copy appointment');
  expect(clipboardText({ ...content, blocks: [block('done', 'Finished', 0, { ...todo, status: 'done' })] })).toBe('[x] Finished');
  for (const status of [undefined, '', 'unknown']) {
    const invalid = { ...content, blocks: [block('appointment', 'Copy appointment', 0, { ...appointment, status } as TaskState)] };
    expect(parseBlockClipboard(JSON.stringify(invalid))).toBeNull();
  }
});

test('plain clipboard exports live tag titles while private data retains canonical authored tokens', () => {
  const ids = ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAX', '01ARZ3NDEKTSV4RRFFQ69G5FAY'];
  const titles = ['Task', 'Question', 'Project', 'Source'];
  const authored = 'Copy tags ' + ids.map((id, index) => `#[[${id}|${titles[index]!.toLowerCase()}]]`).join(' ');
  const content: BlockClipboard = { version: 1, scope: 'notebook', cut: false, blocks: [block('tags', authored)] };
  expect(clipboardText(content, id => titles[ids.indexOf(id)])).toBe('Copy tags #Task #Question #Project #Source');
  expect(parseBlockClipboard(JSON.stringify(content))?.blocks[0]?.block.text).toBe(authored);
  expect(content.blocks[0]?.block.text).toBe(authored);
});

test('plain clipboard brackets multiword titles and falls back to tag aliases then IDs', () => {
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const content: BlockClipboard = { version: 1, scope: 'notebook', cut: false, blocks: [block('tags', `Vocabulary #[[${id}|old]]`)] };
  expect(clipboardText(content, () => 'Italian word')).toBe('Vocabulary #[[Italian word]]');
  expect(clipboardText(content)).toBe('Vocabulary #old');
  content.blocks[0]!.block.text = `Vocabulary #[[${id}|]]`;
  expect(clipboardText(content)).toBe(`Vocabulary #${id}`);
  content.blocks[0]!.block.text = `#[[Italian word]] \`#[[${id}|old]]\` [[${id}|Reference]]`;
  expect(clipboardText(content)).toBe(`#[[Italian word]] \`#[[${id}|old]]\` [[${id}|Reference]]`);
});

test('view references export like page links and retain their remembered name', () => {
  const text = '[[view:01ARZ3NDEKTSV4RRFFQ69G5FAV|Open questions]]';
  const content: BlockClipboard = { version: 1, scope: 'notebook', cut: false, blocks: [block('heading', 'Questions'), block('embed', text, 1)] };
  expect(clipboardText(content)).toBe(`Questions\n  ${text}`);
  expect(parseBlockClipboard(JSON.stringify(content))).toEqual(content);
});

test('plain copy expands a frozen quote into quoted lines without absorbing its annotations', () => {
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const quoted = block('quote', `((${id}))`);
  quoted.capabilities.quote = { target_id: id, captured_at: 0, truncated: false, rows: [
    { id, depth: 0, text: 'Frozen heading', heading: 2, revision: 1 },
    { id: 'child', depth: 1, text: 'Child\nSecond line', heading: null, revision: 1 },
  ] };
  const content: BlockClipboard = { version: 1, scope: 'notebook', cut: false, blocks: [quoted, block('annotation', 'Annotation', 1)] };
  expect(clipboardText(content)).toBe('> ## Frozen heading\n>   Child\n>   Second line\n  Annotation');
  quoted.block.text = 'Ordinary text';
  expect(clipboardText(content)).toBe('Ordinary text\n  Annotation');
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

test('Markdown paste converts native headings, list indentation, task states and labeled URLs', () => {
  expect(markdownPasteRows('# Heading\n- Bullet\n  - Child\n1. Numbered\n- [ ] Todo\n[x] Finished\n[Caption](https://example.org/a_(b))')).toEqual([
    { text: 'Heading', indent: 0, heading: 1, task: null },
    { text: 'Bullet', indent: 0, heading: null, task: null },
    { text: 'Child', indent: 2, heading: null, task: null },
    { text: 'Numbered', indent: 0, heading: null, task: null },
    { text: 'Todo', indent: 0, heading: null, task: 'todo' },
    { text: 'Finished', indent: 0, heading: null, task: 'done' },
    { text: '[[https://example.org/a_(b)|Caption]]', indent: 0, heading: null, task: null },
  ]);
});

test('Markdown code fences keep heading and task markers literal', () => {
  const rows = markdownPasteRows('```\n# Literal\n- [ ] Literal\n```\n## Heading');
  expect(rows.map(row => row.text)).toEqual(['```', '# Literal', '- [ ] Literal', '```', 'Heading']);
  expect(rows.map(row => row.heading)).toEqual([null, null, null, null, 2]);
  expect(rows.every(row => row.task === null)).toBe(true);
});

test('external links accept only a single HTTP URL and escape native delimiters', () => {
  expect(clipboardUrl('https://example.org/path')).toBe('https://example.org/path');
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'https://one.test\nhttps://two.test', 'prose https://example.org', 'https://']) expect(clipboardUrl(value)).toBeNull();
  expect(externalLink('https://example.org/a|b]', 'Caption')).toBe('[[https://example.org/a%7Cb%5D|Caption]]');
});

test('external Markdown MIME works without text/plain and unsupported clipboard data stays absent', () => {
  expect(clipboardPasteRows({ types: ['text/markdown'], getData: () => '## Heading' })).toEqual([{ text: 'Heading', indent: 0, heading: 2, task: null }]);
  expect(clipboardPasteRows({ types: ['image/png'], getData: () => '' })).toBeNull();
});
