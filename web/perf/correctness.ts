import { ulid } from 'ulid';
import type { Page } from 'playwright-core';
import type { Batch, Block, PageView } from '../src/api/types';
import type { ViewState } from '../src/shell/contract';
import type { PerfControls } from './fixture';

export interface Outcome { scenario: string; pass: boolean; evidence: string }
interface Fixture { root: string; a: string; child: string; b: string; c: string; reference: string; title: string }
interface FixtureOptions { texts?: readonly [string, string, string]; child?: boolean }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export async function submit(service: string, operations: Batch['operations']) {
  const response = await fetch(`${service}/api/batches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: { kind: 'client', name: 'spike-3' }, idempotency_key: ulid(), operations }) });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
}
async function fixture(service: string, options: FixtureOptions = {}): Promise<Fixture> {
  const root = ulid(), a = ulid(), child = ulid(), b = ulid(), c = ulid(), reference = ulid();
  const title = `Spike 3 reference ${reference}`;
  const texts = options.texts ?? ['alpha beta gamma', 'bravo second', 'charlie final'];
  await submit(service, [
    { op: 'create_page', id: root, title: `Spike 3 proof ${root}` },
    { op: 'insert', id: a, parent_id: root, after: null, text: texts[0]!, heading: null },
    ...(options.child === false ? [] : [{ op: 'insert' as const, id: child, parent_id: a, after: null, text: 'child preserved', heading: null }]),
    { op: 'insert', id: b, parent_id: root, after: a, text: texts[1]!, heading: null },
    { op: 'insert', id: c, parent_id: root, after: b, text: texts[2]!, heading: null },
    { op: 'create_page', id: reference, title },
  ]);
  return { root, a, child, b, c, reference, title };
}
export async function focus(page: Page, id: string, offset: number) {
  await page.evaluate(({ id, offset }) => window.outlinePerf.restore({ ...window.outlinePerf.view(), caret: { id, offset }, scroll: null }), { id, offset });
  await page.waitForFunction(id => document.querySelector('[data-pane="main"] .cm-editor')?.closest('[data-block-id]')?.getAttribute('data-block-id') === id, id);
  await page.locator('[data-pane="main"] .cm-content').focus();
  await page.waitForTimeout(30);
}
export async function load(page: Page, url: string, id: string, two = false) {
  await page.goto(`${url}/perf/index.html?page=${id}${two ? '&two=1&archived=1' : ''}`);
  await page.waitForFunction(() => window.outlinePerf?.ready() && !!document.querySelector('[data-pane="main"] .cm-content'));
  await page.waitForTimeout(40);
}
async function press(page: Page, key: string) { await page.keyboard.press(key); await page.waitForTimeout(50); }
async function saved(page: Page) { await page.waitForFunction(() => window.outlinePerf.document().saveState() === 'saved', null, { timeout: 10000 }); }

export async function correctness(page: Page, url: string, service: string): Promise<Outcome[]> {
  const results: Outcome[] = [];
  async function scenario(name: string, check: (f: Fixture) => Promise<string>, options: FixtureOptions = {}) {
    try { const f = await fixture(service, options); await load(page, url, f.root); results.push({ scenario: name, pass: true, evidence: await check(f) }); }
    catch (error) { results.push({ scenario: name, pass: false, evidence: error instanceof Error ? error.message : String(error) }); }
  }
  await scenario('Split / merge and undo / redo across acknowledged saves preserve IDs and children', async f => {
    await focus(page, f.a, 5); await press(page, 'Enter');
    let rows = await page.evaluate(() => window.outlinePerf.snapshot());
    const right = rows.find(row => row.text === ' beta gamma');
    assert(right && rows.find(row => row.id === f.a)?.text === 'alpha' && rows.find(row => row.id === f.child)?.parent === f.a, 'Split identity or child ownership changed.');
    await saved(page); await press(page, 'Backspace'); await saved(page);
    rows = await page.evaluate(() => window.outlinePerf.snapshot());
    assert(rows.find(row => row.id === f.a)?.text === 'alpha beta gamma' && !rows.some(row => row.id === right.id), 'Merge did not retain destination.');
    await press(page, 'Meta+z'); await saved(page);
    rows = await page.evaluate(() => window.outlinePerf.snapshot());
    assert(rows.some(row => row.id === right.id) && rows.find(row => row.id === f.child)?.parent === f.a, 'Undo merge lost source ID or descendants.');
    await press(page, 'Meta+Shift+z'); await saved(page);
    assert(!(await page.evaluate(() => window.outlinePerf.snapshot())).some(row => row.id === right.id), 'Redo merge did not reapply.');
    return `Left ${f.a}, child ${f.child}, split ${right.id}; merge, committed undo and redo checked.`;
  });
  await scenario('Indent / outdent / sibling move preserve complete subtree identities', async f => {
    await focus(page, f.b, 0); await press(page, 'Tab');
    let rows = await page.evaluate(() => window.outlinePerf.snapshot());
    assert(rows.find(row => row.id === f.b)?.parent === f.a, 'Tab did not indent under previous sibling.');
    await press(page, 'Shift+Tab');
    rows = await page.evaluate(() => window.outlinePerf.snapshot());
    assert(rows.find(row => row.id === f.b)?.parent === f.root, 'Shift+Tab did not outdent.');
    await press(page, 'Alt+ArrowUp');
    rows = await page.evaluate(() => window.outlinePerf.snapshot());
    assert(rows[0]?.id === f.b && rows.some(row => row.id === f.a) && rows.find(row => row.id === f.child)?.parent === f.a, 'Move changed identity or descendants.');
    await saved(page);
    return `All four original block IDs survive; ${f.b} moves before ${f.a}; child remains attached.`;
  });
  await scenario('CodeMirror Vim text motions/operators and structural Vim', async f => {
    await focus(page, f.a, 0); await page.evaluate(() => window.outlinePerf.vim(true)); await press(page, 'w');
    assert((await page.evaluate(() => window.outlinePerf.caret()))?.offset === 6, 'Vim w did not move to beta.');
    await page.keyboard.type('dw'); await page.waitForTimeout(60);
    assert((await page.evaluate(() => window.outlinePerf.snapshot())).find(row => row.id === f.a)?.text === 'alpha gamma', 'Vim dw did not delete a word.');
    await press(page, 'Escape');
    assert(await page.evaluate(() => window.outlinePerf.mode()) === 'outline', 'Escape from Normal did not enter Outline.');
    await press(page, 'j'); await press(page, 'j'); await page.keyboard.type('>>'); await page.waitForTimeout(50);
    assert((await page.evaluate(() => window.outlinePerf.snapshot())).find(row => row.id === f.b)?.parent === f.a, 'Structural >> failed.');
    await page.keyboard.type('<<'); await page.waitForTimeout(50);
    assert((await page.evaluate(() => window.outlinePerf.snapshot())).find(row => row.id === f.b)?.parent === f.root, 'Structural << failed.');
    await press(page, 'o');
    const created = (await page.evaluate(() => window.outlinePerf.caret()))?.id;
    assert(created && ![f.a, f.child, f.b, f.c].includes(created), 'Structural o did not insert.');
    await page.keyboard.type('inserted'); await press(page, 'Escape'); await press(page, 'Escape'); await page.keyboard.type('dd'); await page.waitForTimeout(60);
    assert(!(await page.evaluate(() => window.outlinePerf.snapshot())).some(row => row.id === created), 'Structural dd did not delete subtree.');
    await press(page, 'u');
    assert((await page.evaluate(() => window.outlinePerf.snapshot())).some(row => row.id === created), 'Structural u did not restore same ID.');
    await press(page, 'Escape'); await press(page, 'Control+r');
    assert(!(await page.evaluate(() => window.outlinePerf.snapshot())).some(row => row.id === created), 'Structural Ctrl+R did not redo.');
    return `Text w/dw, Escape mode transition, j, >>/<<, o, dd, u and Ctrl+R exercised; new ID ${created} restored exactly.`;
  });
  await scenario('IME composition Enter commits once and never splits', async f => {
    await focus(page, f.b, 3);
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.imeSetComposition', { text: 'かん', selectionStart: 2, selectionEnd: 2 });
      await press(page, 'Enter'); await session.send('Input.insertText', { text: '漢' }); await page.waitForTimeout(100);
      const rows = await page.evaluate(() => window.outlinePerf.snapshot());
      assert(rows.length === 4 && rows.find(row => row.id === f.b)?.text === 'bra漢vo second', 'Composition inserted duplicate text or split.');
      await press(page, 'Meta+z');
      assert((await page.evaluate(() => window.outlinePerf.snapshot())).find(row => row.id === f.b)?.text === 'bravo second', 'IME undo did not remove whole composition.');
      return 'CDP preedit かん, real Enter while composing, commit 漢; four IDs remain and one undo restores original text.';
    } finally { await session.detach(); }
  });
  await scenario('Cross-block partial selection copies and deletes visible text, with undo', async f => {
    await focus(page, f.child, 3);
    await press(page, 'Shift+ArrowRight'); await press(page, 'Shift+ArrowRight'); await press(page, 'Shift+ArrowRight');
    await press(page, 'Shift+ArrowDown');
    await press(page, 'Shift+ArrowRight'); await press(page, 'Shift+ArrowRight'); await press(page, 'Shift+ArrowRight');
    await press(page, 'Meta+c');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert(copied === 'ld preserved\nbra', `Cross-block copy was ${JSON.stringify(copied)}.`);
    await press(page, 'Backspace');
    const rows = await page.evaluate(() => window.outlinePerf.snapshot());
    assert(rows.find(row => row.id === f.child)?.text === 'chivo second' && !rows.some(row => row.id === f.b), 'Range delete did not retain first endpoint ID and suffix.');
    await press(page, 'Meta+z');
    assert((await page.evaluate(() => window.outlinePerf.snapshot())).some(row => row.id === f.b), 'Range undo lost endpoint ID.');
    return 'A local partial selection extends across rows without losing its original offset; copied “ld preserved\\nbra”; deletion retained first ID and last suffix; undo restored last ID.';
  });
  await scenario('Folded descendants are not silently deleted by text selection', async f => {
    await page.locator(`[data-block-id="${f.a}"] .row-fold`).click();
    await focus(page, f.a, 5); await press(page, 'Shift+ArrowDown'); await press(page, 'Backspace');
    const rows = await page.evaluate(() => window.outlinePerf.snapshot());
    assert(rows.length === 4 && rows.find(row => row.id === f.child)?.text === 'child preserved' && await page.locator('.outline-message').isVisible(), 'Hidden descendant was deleted or rejection was invisible.');
    return 'Folded child remains live; cross-range delete refused with a visible explanation.';
  });
  await scenario('[[ completion inserts a stable working reference and opens beside', async f => {
    await focus(page, f.c, 13); await page.keyboard.type(` [[${f.title}`);
    await page.locator('.reference-completion [role="option"]').first().waitFor();
    await press(page, 'Enter');
    const text = (await page.evaluate(() => window.outlinePerf.snapshot())).find(row => row.id === f.c)?.text;
    assert(text?.includes(`[[${f.reference}]]`), 'Completion did not insert stable ID.');
    await press(page, 'Escape'); await page.locator(`[data-block-id="${f.c}"] .outline-reference`).click();
    assert((await page.evaluate(() => window.outlinePerf.openTargets())).some(item => item.beside && item.target.pageId === f.reference), 'Reference did not open its target beside.');
    return `Completion inserts [[${f.reference}]]; rendered target clicked into second real page pane.`;
  });
  await scenario('Tag chip resolves its type page and opens beside', async f => {
    await focus(page, f.c, 13); await page.keyboard.type(' #proof-tag'); await saved(page); await press(page, 'Escape');
    const response = await fetch(`${service}/api/pages/by-title/proof-tag`); const target = await response.json() as Block;
    assert(response.ok, 'Tag page was not created by the service.');
    await page.locator(`[data-block-id="${f.c}"] .outline-tag`).click();
    await page.waitForFunction(id => window.outlinePerf.openTargets().some(item => item.beside && item.target.pageId === id), target.id);
    assert((await page.evaluate(() => window.outlinePerf.openTargets())).some(item => item.beside && item.target.pageId === target.id), 'Tag opened wrong type page.');
    return `#proof-tag resolves to live type page ${target.id} and opens beside.`;
  });
  await scenario('Fold, zoom breadcrumbs and exact view-state restore', async f => {
    await page.locator(`[data-block-id="${f.a}"] .row-fold`).click();
    assert(await page.locator(`[data-block-id="${f.child}"]`).count() === 0, 'Fold did not hide child.');
    await page.locator(`[data-block-id="${f.a}"] .row-bullet`).click();
    assert(await page.locator('.outline-breadcrumbs').count() === 1 && await page.evaluate(() => window.outlinePerf.view().zoom) === f.a, 'Zoom or breadcrumbs failed.');
    await page.waitForTimeout(80);
    const savedView = await page.evaluate(() => window.outlinePerf.view());
    await page.evaluate(() => window.outlinePerf.command('zoom-out')); await page.waitForTimeout(50);
    await page.evaluate(view => window.outlinePerf.restore(view), savedView); await page.waitForTimeout(100);
    const restored = await page.evaluate(() => window.outlinePerf.view());
    assert(restored.zoom === savedView.zoom && JSON.stringify(restored.folds) === JSON.stringify(savedView.folds) && restored.caret?.id === savedView.caret?.id && restored.caret?.offset === savedView.caret?.offset, 'Restore lost zoom/folds/caret.');
    assert(!savedView.scroll || restored.scroll?.id === savedView.scroll.id && Math.abs(restored.scroll.offset - savedView.scroll.offset) <= 2, 'Restore lost scroll anchor.');
    return 'Fold hides child; bullet zoom, breadcrumb path, zoom-out and remount restore zoom, folds, caret and anchor ≤2px.';
  });
  await scenario('Heading input rule is one undo step; page rename validates in place', async f => {
    await focus(page, f.c, 0); await page.keyboard.press('Meta+a'); await page.keyboard.type('# '); await page.waitForTimeout(100);
    assert(await page.evaluate(id => window.outlinePerf.document().block(id)?.heading === 1 && window.outlinePerf.document().block(id)?.text === '', f.c), 'Heading rule failed.');
    await press(page, 'Meta+z');
    assert(await page.evaluate(id => window.outlinePerf.document().block(id)?.heading === null, f.c), 'Undo did not clear heading atomically.');
    await page.locator('.outline-title').click(); await page.locator('.title-input').fill(`Renamed ${f.root}`); await page.locator('.title-input').press('Enter'); await saved(page);
    const loaded = await (await fetch(`${service}/api/pages/${f.root}`)).json() as PageView;
    assert(loaded.root.text === `Renamed ${f.root}`, 'Rename did not commit.');
    return 'Typed #␠ converts text/style atomically; one undo restores normal; Enter rename acknowledged by service.';
  });
  await scenario('Expanded Backlinks and Tagged blocks follow remote membership and show ancestor breadcrumbs', async f => {
    await page.locator('.related-section summary').nth(0).click();
    await page.locator('.related-section summary').nth(1).click();
    const parent = ulid(), source = ulid();
    await submit(service, [
      { op: 'insert', id: parent, parent_id: f.reference, after: null, text: 'source context', heading: null },
      { op: 'insert', id: source, parent_id: parent, after: null, text: `remote member [[${f.root}]] #[[Spike 3 proof ${f.root}]]`, heading: null },
    ]);
    await page.waitForFunction(() => [...document.querySelectorAll('.related-section summary span')].every(span => span.textContent === '1'));
    await page.waitForFunction(() => [...document.querySelectorAll('.related-breadcrumb')].some(span => span.textContent?.includes('source context')));
    assert(await page.locator('.related-block').count() === 2, 'Remote block did not appear in both sections.');
    const block = await (await fetch(`${service}/api/blocks/${source}`)).json() as Block;
    await submit(service, [{ op: 'edit_text', id: source, base_revision: block.revision, text: 'no relation remains' }]);
    await page.waitForFunction(() => [...document.querySelectorAll('.related-section summary span')].every(span => span.textContent === '0'));
    assert(await page.locator('.related-block').count() === 0, 'Removed remote membership remained visible.');
    return 'A remote insert adds one backlink and one tag member; breadcrumbs include its source parent; remote text removal updates both counts to zero without reloading.';
  });
  await scenario('Primary text click preserves glyph caret and Backspace never deletes a subtree', async f => {
    const point = await page.locator(`[data-block-id="${f.b}"] .static-text`).evaluate(element => {
      const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange(); range.setStart(node, 2); range.setEnd(node, 3);
      const rect = range.getBoundingClientRect(); return { x: rect.left + rect.width * .15, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(point.x, point.y); await page.waitForTimeout(60);
    const clicked = await page.evaluate(() => ({ caret: window.outlinePerf.caret(), focused: document.activeElement?.classList.contains('cm-content') }));
    await press(page, 'Backspace');
    const rows = await page.evaluate(() => window.outlinePerf.snapshot());
    assert(clicked.focused && clicked.caret?.id === f.b && clicked.caret.offset === 2 && rows.find(row => row.id === f.b)?.text === 'bavo second' && rows.length === 4,
      `Text click/focus unsafe: ${JSON.stringify(clicked)}; remaining texts ${JSON.stringify(rows.map(row => [row.id, row.text]))}.`);
    return 'Clicked before the third glyph; retained CM owns focus at offset 2 and Backspace removes only the preceding character, preserving all four IDs.';
  });
  const selectionOptions: FixtureOptions = { texts: ['abc', 'def', 'ghi'], child: false };
  async function selectThree(f: Fixture) {
    await focus(page, f.a, 1);
    await press(page, 'Shift+ArrowDown'); await press(page, 'Shift+ArrowDown');
    await press(page, 'Shift+ArrowRight'); await press(page, 'Shift+ArrowRight');
    await page.evaluate(() => navigator.clipboard.writeText('selection sentinel'));
    await press(page, 'Meta+c');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert(copied === 'bc\ndef\ngh', `Range preparation copied ${JSON.stringify(copied)}.`);
  }
  for (const mutation of ['paste', 'cut', 'type', 'Enter', 'Shift+Enter'] as const) {
    await scenario(`One atomic ${mutation} replaces a three-block range and undo restores its selection`, async f => {
      await selectThree(f);
      let cut = '';
      if (mutation === 'paste') { await page.evaluate(() => navigator.clipboard.writeText('REPLACEMENT')); await press(page, 'Meta+v'); }
      else if (mutation === 'cut') { await page.evaluate(() => navigator.clipboard.writeText('cut sentinel')); await press(page, 'Meta+x'); cut = await page.evaluate(() => navigator.clipboard.readText()); }
      else if (mutation === 'type') { await page.keyboard.type('X'); await page.waitForTimeout(60); }
      else await press(page, mutation);
      const rows = await page.evaluate(() => window.outlinePerf.snapshot());
      const expected = mutation === 'paste' ? 'aREPLACEMENTi' : mutation === 'type' ? 'aXi' : mutation === 'Shift+Enter' ? 'a\ni' : mutation === 'Enter' ? 'a' : 'ai';
      const right = mutation === 'Enter' ? rows.find(row => row.id !== f.a) : null;
      const at = await page.evaluate(() => window.outlinePerf.caret());
      const offset = mutation === 'paste' ? 12 : mutation === 'type' || mutation === 'Shift+Enter' ? 2 : mutation === 'Enter' ? 0 : 1;
      assert(rows.find(row => row.id === f.a)?.text === expected && rows.length === (right ? 2 : 1) && (!right || right.text === 'i') &&
        !rows.some(row => row.id === f.b || row.id === f.c) && at?.id === (right?.id ?? f.a) && at.offset === offset && (mutation !== 'cut' || cut === 'bc\ndef\ngh'),
        `Replacement was not atomic/correct: ${JSON.stringify({ rows, at, cut })}.`);
      await saved(page); await press(page, 'Meta+z'); await saved(page);
      const restored = await page.evaluate(() => window.outlinePerf.snapshot());
      assert(JSON.stringify(restored.map(row => [row.id, row.text])) === JSON.stringify([[f.a, 'abc'], [f.b, 'def'], [f.c, 'ghi']]),
        `One undo did not restore original IDs/text: ${JSON.stringify(restored)}.`);
      await page.evaluate(() => navigator.clipboard.writeText('undo selection sentinel'));
      await press(page, 'Meta+c');
      assert(await page.evaluate(() => navigator.clipboard.readText()) === 'bc\ndef\ngh', 'Undo did not restore the prior logical selection.');
      await press(page, 'Meta+Shift+z'); await saved(page);
      const redone = await page.evaluate(() => window.outlinePerf.snapshot());
      assert(JSON.stringify(redone.map(row => [row.id, row.text])) === JSON.stringify(rows.map(row => [row.id, row.text])), 'One redo did not restore the identical committed replacement.');
      return `${mutation} retained left ID, exact suffix/caret and clipboard payload; one acknowledged undo restored all original IDs and prior selection; one redo restored the same result IDs.`;
    }, selectionOptions);
  }
  await scenario('Multiline paste over a local selection applies once and undo restores that selection', async f => {
    await focus(page, f.a, 1); await press(page, 'Shift+ArrowRight');
    await page.evaluate(() => navigator.clipboard.writeText('x\ny')); await press(page, 'Meta+v');
    const rows = await page.evaluate(() => window.outlinePerf.snapshot());
    const right = rows.find(row => ![f.a, f.b, f.c].includes(row.id));
    const at = await page.evaluate(() => window.outlinePerf.caret());
    assert(rows.find(row => row.id === f.a)?.text === 'ax' && right?.text === 'yc' && rows.length === 4 && at?.id === right.id && at.offset === 1,
      `Local paste double-applied or misplaced the suffix/caret: ${JSON.stringify({ rows, at })}.`);
    await saved(page); await press(page, 'Meta+z'); await saved(page);
    assert(JSON.stringify((await page.evaluate(() => window.outlinePerf.snapshot())).map(row => [row.id, row.text])) === JSON.stringify([[f.a, 'abc'], [f.b, 'def'], [f.c, 'ghi']]), 'Local paste required more than one undo or lost IDs.');
    await page.evaluate(() => navigator.clipboard.writeText('local selection sentinel')); await press(page, 'Meta+c');
    assert(await page.evaluate(() => navigator.clipboard.readText()) === 'b', 'Local paste undo did not restore the selected character.');
    return 'Selected b in abc and pasted x\\ny: ax / yc with caret after y; one undo restores abc and its exact selected b.';
  }, selectionOptions);
  await scenario('Row popup newline targets the selected row rather than the retained editor', async f => {
    await focus(page, f.a, 5); await press(page, 'Escape'); await press(page, 'ArrowDown');
    await page.locator(`[data-block-id="${f.b}"] .row-menu`).click();
    await page.getByRole('menuitem', { name: /^Insert newline/ }).click();
    await page.waitForTimeout(70);
    const rows = await page.evaluate(() => window.outlinePerf.snapshot());
    const at = await page.evaluate(() => window.outlinePerf.caret());
    assert(rows.find(row => row.id === f.a)?.text === 'alpha beta gamma' && rows.find(row => row.id === f.b)?.text === 'bravo second\n' &&
      at?.id === f.b && at.offset === 13, `Popup command targeted a stale editor: ${JSON.stringify({ rows, at })}.`);
    await saved(page); await press(page, 'Meta+z'); await saved(page);
    assert((await page.evaluate(() => window.outlinePerf.snapshot())).find(row => row.id === f.b)?.text === 'bravo second', 'One undo did not restore the targeted row.');
    return 'Edit A → Escape → select B → real Block actions popup → Insert newline changes only B, focuses B at its end, and undoes once.';
  }, { child: false });
  return results;
}
