import { isDeepStrictEqual } from 'node:util';
import type { Page } from 'playwright-core';
import { selectionText } from '@spike/shared';
import type { OutlineRow, Selection } from '@spike/shared';

export interface Outcome { scenario: string; pass: boolean; reason: string }
const equal = (actual: unknown, expected: unknown, reason: string) => {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${reason}: expected ${JSON.stringify(expected).slice(0, 500)}, got ${JSON.stringify(actual).slice(0, 500)}`);
};
const check = (condition: unknown, reason: string) => { if (!condition) throw new Error(reason); };
const model = (page: Page): Promise<OutlineRow[]> => page.evaluate(() => window.spike!.model());
const selection = (page: Page): Promise<Selection> => page.evaluate(() => window.spike!.selection()!);
const focus = async (page: Page, index: number, offset: number) => {
  await page.evaluate(({ index, offset }) => window.spike!.focus(index, offset), { index, offset });
  await page.waitForTimeout(30);
};
const press = async (page: Page, key: string) => { await page.keyboard.press(key); await page.waitForTimeout(25); };
const endOf = (rows: OutlineRow[], index: number) => {
  let end = index + 1;
  while (end < rows.length && rows[end].depth > rows[index].depth) end++;
  return end;
};
const leaf = (rows: OutlineRow[]) => rows.findIndex((row, index) => index > 0 && row.text.length > 4 && row.text.length < 30 && !row.text.includes('\n') && endOf(rows, index) === index + 1);

export async function correctness(page: Page, url: string): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const run = async (scenario: string, action: () => Promise<void>, vim = false) => {
    try {
      await page.goto(`${url}?rows=80${vim ? '&vim=1' : ''}`);
      await page.waitForFunction(() => Boolean(window.spike));
      await action();
      outcomes.push({ scenario, pass: true, reason: 'Real browser input produced the expected model, IDs and selection.' });
    } catch (error) {
      outcomes.push({ scenario, pass: false, reason: error instanceof Error ? error.message : String(error) });
    }
  };
  await run('Typing and Shift+Enter', async () => {
    const before = await model(page);
    const index = leaf(before);
    await focus(page, index, 3);
    await press(page, 'x');
    await press(page, 'Shift+Enter');
    const after = await model(page);
    equal(after, before.map((row, i) => i === index ? { ...row, text: row.text.slice(0, 3) + 'x\n' + row.text.slice(3) } : row), 'Typing/newline must alter only the focused row');
  });
  await run('Split retains left ID and children', async () => {
    const before = await model(page);
    const index = before.findIndex((row, i) => row.text.length > 4 && endOf(before, i) > i + 1);
    check(index >= 0, 'Corpus has no parent to exercise split');
    const end = endOf(before, index);
    await focus(page, index, 3);
    await press(page, 'Enter');
    const after = await model(page);
    const fresh = after[end];
    check(fresh && !before.some(row => row.id === fresh.id), 'Right side must receive a fresh ID');
    equal(after, [...before.slice(0, index), { ...before[index], text: before[index].text.slice(0, 3) }, ...before.slice(index + 1, end), { id: fresh.id, depth: before[index].depth, text: before[index].text.slice(3) }, ...before.slice(end)], 'Split must keep children on the left and create the next sibling');
    equal((await selection(page)).head, { id: fresh.id, offset: 0 }, 'Split caret');
    await press(page, 'Meta+z');
    equal(await model(page), before, 'Split undo exact IDs');
    await press(page, 'Meta+Shift+z');
    equal(await model(page), after, 'Split redo exact IDs');
  });
  await run('Merge keeps previous visible ID and join caret', async () => {
    const before = await model(page);
    const index = leaf(before);
    await focus(page, index, 0);
    await press(page, 'Backspace');
    equal(await model(page), [...before.slice(0, index - 1), { ...before[index - 1], text: before[index - 1].text + before[index].text }, ...before.slice(index + 1)], 'Merge result');
    equal((await selection(page)).head, { id: before[index - 1].id, offset: before[index - 1].text.length }, 'Merge join caret');
    await press(page, 'Meta+z');
    equal(await model(page), before, 'Merge undo restores source ID');
  });
  await run('Merge refuses a row with children', async () => {
    const before = await model(page);
    const index = before.findIndex((row, i) => i > 0 && endOf(before, i) > i + 1);
    await focus(page, index, 0);
    await press(page, 'Backspace');
    equal(await model(page), before, 'A row with children must not merge');
  });
  await run('Indent, outdent and move preserve subtree IDs', async () => {
    const before = await model(page);
    const index = before.findIndex((row, i) => i > 0 && endOf(before, i) > i + 1 && before[i - 1].depth === row.depth);
    check(index >= 0, 'Corpus lacks a sibling subtree');
    const end = endOf(before, index);
    await focus(page, index, 2);
    await press(page, 'Tab');
    const indented = before.map((row, i) => i >= index && i < end ? { ...row, depth: row.depth + 1 } : row);
    equal(await model(page), indented, 'Indent must change every descendant depth once');
    await press(page, 'Shift+Tab');
    equal(await model(page), before, 'Outdent must restore the sibling subtree');
    await press(page, 'Alt+ArrowUp');
    const moved = [...before.slice(0, index - 1), ...before.slice(index, end), before[index - 1], ...before.slice(end)];
    equal(await model(page), moved, 'Move up must reorder whole sibling subtrees');
    await press(page, 'Alt+ArrowDown');
    equal(await model(page), before, 'Move down must reverse whole-subtree move');
  });
  await run('One undo stack restores exact mixed model, IDs and caret', async () => {
    const before = await model(page);
    const index = leaf(before);
    await focus(page, index, 3);
    const initialSelection = await selection(page);
    const keys = ['x', 'Enter', 'Tab', 'Shift+Tab', 'Alt+ArrowUp'];
    let changed = 0;
    let previous = before;
    for (const key of keys) {
      await press(page, key);
      const next = await model(page);
      if (!isDeepStrictEqual(next, previous)) changed++;
      previous = next;
    }
    check(changed >= 4, 'Mixed scenario failed to exercise text and structural edits');
    const final = await model(page);
    const finalSelection = await selection(page);
    for (let i = 0; i < changed; i++) await press(page, 'Meta+z');
    equal(await model(page), before, 'Mixed undo model and IDs');
    equal(await selection(page), initialSelection, 'Mixed undo caret');
    for (let i = 0; i < changed; i++) await press(page, 'Meta+Shift+z');
    equal(await model(page), final, 'Mixed redo model and IDs');
    equal(await selection(page), finalSelection, 'Mixed redo caret');
  });
  await run('Cross-block selection copy, delete and undo', async () => {
    const before = await model(page);
    const index = before.findIndex((row, i) => i + 3 < before.length && endOf(before, i) === i + 1 && endOf(before, i + 2) > i + 3 && before[i + 2].depth !== row.depth);
    check(index >= 0, 'Corpus lacks a cross-block range ending in a differently indented parent');
    await focus(page, index, before[index].text.length);
    await press(page, 'Shift+ArrowDown');
    await press(page, 'Shift+ArrowDown');
    const range = await selection(page);
    check(range.anchor.id !== range.head.id, 'Shift+ArrowDown did not extend by rows');
    const expectedCopy = selectionText(before, range);
    equal(await page.evaluate(() => window.spike!.copyText()), expectedCopy, 'Cross-block copyText');
    await press(page, 'Meta+c');
    equal(await page.evaluate(() => navigator.clipboard.readText()), expectedCopy, 'Real copy clipboard');
    let first = before.findIndex(row => row.id === range.anchor.id);
    let last = before.findIndex(row => row.id === range.head.id);
    let start = range.anchor.offset;
    let finish = range.head.offset;
    if (first > last) { [first, last] = [last, first]; [start, finish] = [finish, start]; }
    const end = endOf(before, last);
    const expected = [...before.slice(0, first), { ...before[first], text: before[first].text.slice(0, start) + before[last].text.slice(finish) }, ...before.slice(last + 1, end).map(row => ({ ...row, depth: row.depth + before[first].depth - before[last].depth })), ...before.slice(end)];
    await press(page, 'Backspace');
    equal(await model(page), expected, 'Cross-block delete, first ID and last children');
    equal((await selection(page)).head, { id: before[first].id, offset: start }, 'Cross-block delete caret');
    await press(page, 'Meta+z');
    equal(await model(page), before, 'Cross-block undo exact IDs');
    equal(await selection(page), range, 'Cross-block undo selection');
  });
  await run('Arrow navigation and reverse cross-block selection', async () => {
    const before = await model(page);
    const index = leaf(before);
    await focus(page, index, 0);
    await press(page, 'ArrowUp');
    equal((await selection(page)).head.id, before[index - 1].id, 'ArrowUp at first visual line');
    await focus(page, index, before[index].text.length);
    await press(page, 'ArrowDown');
    equal((await selection(page)).head.id, before[index + 1].id, 'ArrowDown at last visual line');
    await focus(page, index, 0);
    await press(page, 'Shift+ArrowUp');
    const range = await selection(page);
    equal(range.anchor.id, before[index].id, 'Reverse selection anchor');
    equal(range.head.id, before[index - 1].id, 'Reverse selection head');
    equal(await page.evaluate(() => window.spike!.copyText()), selectionText(before, range), 'Reverse selection copy');
  });
  await run('IME commits once; Enter while composing never splits', async () => {
    const before = await model(page);
    const index = leaf(before);
    await focus(page, index, 3);
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.imeSetComposition', { text: 'かん', selectionStart: 2, selectionEnd: 2 });
      await press(page, 'Enter');
      await session.send('Input.insertText', { text: '漢' });
      await page.waitForTimeout(80);
      equal(await model(page), before.map((row, i) => i === index ? { ...row, text: row.text.slice(0, 3) + '漢' + row.text.slice(3) } : row), 'IME text must be inserted once without a new row');
      await press(page, 'Meta+z');
      equal(await model(page), before, 'One undo must remove the committed composition and all preedit text');
      equal(await selection(page), { anchor: { id: before[index].id, offset: 3 }, head: { id: before[index].id, offset: 3 } }, 'Composition undo restores its original caret');
      await press(page, 'Meta+Shift+z');
      equal(await model(page), before.map((row, i) => i === index ? { ...row, text: row.text.slice(0, 3) + '漢' + row.text.slice(3) } : row), 'Composition redo');
    } finally { await session.detach(); }
  });
  await run('Vim word motions and ciw/u', async () => {
    const before = await model(page);
    const index = before.findIndex(row => row.text.length < 60 && /^\w+ \w+/.test(row.text) && !row.text.includes('\n'));
    await focus(page, index, 0);
    await press(page, 'Escape');
    equal(await page.evaluate(() => window.spike!.vimMode()), 'normal', 'Vim Escape normal mode');
    await press(page, 'w');
    equal((await selection(page)).head.offset, before[index].text.indexOf(' ') + 1, 'Vim w word motion');
    await press(page, 'b');
    equal((await selection(page)).head.offset, 0, 'Vim b word motion');
    const beforeChange = await selection(page);
    await press(page, 'c'); await press(page, 'i'); await press(page, 'w');
    equal(await page.evaluate(() => window.spike!.vimMode()), 'insert', 'Vim ciw enters insert mode');
    await page.keyboard.type('Changed');
    await press(page, 'Escape');
    const firstSpace = before[index].text.indexOf(' ');
    equal((await model(page))[index], { ...before[index], text: 'Changed' + before[index].text.slice(firstSpace) }, 'Vim ciw replaces only the word');
    await press(page, 'u');
    equal(await model(page), before, 'Vim u restores full change, not just final character');
    equal(await selection(page), beforeChange, 'Vim u restores the caret before ciw, not its internal word selection');
  }, true);
  await run('Vim dd/u and j/k across rows', async () => {
    const before = await model(page);
    const index = leaf(before);
    await focus(page, index, 0);
    await press(page, 'Escape');
    await press(page, 'd'); await press(page, 'd');
    equal(await model(page), before.map((row, i) => i === index ? { ...row, text: '' } : row), 'Vim dd clears row text without deleting its ID');
    await press(page, 'u');
    equal(await model(page), before, 'Vim u restores dd');
    await focus(page, index, before[index].text.length - 1);
    await press(page, 'j');
    equal((await selection(page)).head.id, before[index + 1].id, 'Vim j across last row line');
    await focus(page, index + 1, 0);
    await press(page, 'k');
    equal((await selection(page)).head.id, before[index].id, 'Vim k across first row line');
    equal(await page.evaluate(() => window.spike!.vimMode()), 'normal', 'Vim row navigation preserves normal mode');
    await press(page, 'i');
    equal(await page.evaluate(() => window.spike!.vimMode()), 'insert', 'Vim i');
    await press(page, 'Escape');
    await press(page, 'a');
    equal(await page.evaluate(() => window.spike!.vimMode()), 'insert', 'Vim a');
  }, true);
  return outcomes;
}
