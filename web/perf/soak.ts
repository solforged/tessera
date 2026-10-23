import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { api, root, Service, sleep } from './lib/service';
import { seed } from './lib/seed';
import { drained, duration, find, heap, instrument, launch, median, open, random, ready, storage, tracker, typeMarker, verify } from './lib/metrics';
import type { HeapSample, Outcome, RevisionCheck, StorageSample } from './lib/metrics';
import { report, table } from './lib/report';

interface WindowRun { context: BrowserContext; page: Page; slot: number; generation: number; busy: boolean; recycling: boolean }
interface Sample { elapsedMs: number; walBytes: number; windows: { slot: number; generation: number; heap: HeapSample; storage: StorageSample }[] }
interface Checkpoint { elapsedMs: number; kind: string; revisions: RevisionCheck; check: { ok: boolean }; commands: number[] }
interface WorkloadAction { elapsedMs: number; slot: number; generation: number; kind: string; target?: string; key?: string; finishedMs?: number; state?: string | null; findRetry?: string; error?: string }

async function findFailure(win: WindowRun, error: unknown) {
  const directory = join(root, 'web/perf/results');
  mkdirSync(directory, { recursive: true });
  const screenshot = join(directory, `soak-find-${Date.now()}-window-${win.slot}-generation-${win.generation}.png`);
  const screenshotError = await win.page.screenshot({ path: screenshot, fullPage: true }).then(() => null, error => String(error));
  const state = await win.page.evaluate(() => ({
    activeElement: document.activeElement?.outerHTML.slice(0, 2000),
    overlays: [...document.querySelectorAll('.popup, [role="dialog"], [role="listbox"], .conflict-panel, .cm-tooltip, .save-banner')].map(element => ({ tag: element.tagName, class: element.className, role: element.getAttribute('role'), label: element.getAttribute('aria-label'), text: element.textContent?.slice(0, 2000) })),
    inputs: [...document.querySelectorAll('input')].map(element => ({ placeholder: element.placeholder, label: element.getAttribute('aria-label') })),
  })).catch(error => ({ captureError: String(error) }));
  return `${String(error)}\nFind state: ${JSON.stringify({ screenshot: screenshotError ? null : screenshot, screenshotError, ...state })}`;
}

const timing = duration(8 * 60);
Service.preflight();
if (process.env.BROWSER && process.env.BROWSER !== 'chromium') throw new Error('The soak uses Chromium because heap sampling requires CDP. Use BROWSER=webkit with concurrency.ts.');
const corpus = await seed();
const tracking = tracker();
const outcomes: Outcome[] = [];
const samples: Sample[] = [];
const checkpoints: Checkpoint[] = [];
const actions: WorkloadAction[] = [];
const findRetries = [0, 0];
const windows: WindowRun[] = [];
const tasks: Promise<void>[] = [];
let browser: Browser | undefined;
let service: Service | undefined;
let stop = false;
let pause = false;
let start = 0;
let forcedServiceCrashes = 0;
let forcedTabCrashes = 0;
let failure: string | null = null;
// Smoke runs compress fault and sample intervals, but use the same workload and assertions.
const serviceInterval = timing.smoke ? Math.min(600_000, timing.milliseconds / 3) : 600_000;
const tabInterval = timing.smoke ? Math.min(1_200_000, timing.milliseconds * 2 / 3) : 1_200_000;
const sampleInterval = timing.smoke ? Math.min(60_000, timing.milliseconds / 12) : 60_000;
const prngSeed = 42;
try {
  browser = await launch('chromium');
  service = await Service.start(corpus.copy('soak'));
  const base = service.base;
  async function createWindow(slot: number, generation: number): Promise<WindowRun> {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    await instrument(context, `window-${slot}-generation-${generation}`, tracking);
    const page = await context.newPage();
    await ready(page, base);
    const fixture = corpus.pages[slot]!;
    await open(page, fixture.id, fixture.blocks[slot]!);
    return { context, page, slot, generation, busy: false, recycling: false };
  }
  for (let slot = 0; slot < 2; slot++) windows.push(await createWindow(slot, 0));
  // Regression: macOS CodeMirror binds Ctrl+Shift+F to forward selection.
  // A split followed by ArrowUp leaves the caret before text, where that
  // binding used to consume Find before the shell's bubbling listener ran.
  const shortcutPage = windows[0]!.page;
  await shortcutPage.keyboard.press('Control+Shift+j');
  await shortcutPage.locator('.pane.active .journal-date').waitFor();
  const journalRow = shortcutPage.locator('.pane.active .outline-row[data-block-id]').first();
  await journalRow.waitFor();
  await typeMarker(shortcutPage, (await journalRow.getAttribute('data-block-id'))!, 'soak_find_shortcut_end');
  await shortcutPage.keyboard.press('Enter');
  await shortcutPage.keyboard.press('ArrowUp');
  const shortcutCheck: Outcome = { scenario: 'Find shortcut after a journal split', pass: false, evidence: 'Find did not complete.' };
  const shortcutAction: WorkloadAction = { elapsedMs: 0, slot: 0, generation: 0, kind: 'find-shortcut-regression', target: corpus.pages[0]!.title };
  outcomes.push(shortcutCheck);
  actions.push(shortcutAction);
  try {
    await find(shortcutPage, corpus.pages[0]!.title, async error => {
      findRetries[0]!++;
      shortcutAction.findRetry = await findFailure(windows[0]!, error);
    });
    shortcutCheck.pass = true;
    shortcutCheck.evidence = 'Ctrl+Shift+F opened Find with the journal caret before existing text, after Enter and ArrowUp.';
  } catch (error) {
    shortcutAction.error = await findFailure(windows[0]!, error);
    shortcutCheck.evidence = shortcutAction.error;
    throw error;
  }
  start = Date.now();
  tracking.startedAt = start;
  const deadline = start + timing.milliseconds;
  async function resolveConflicts(win: WindowRun) {
    const review = win.page.getByRole('button', { name: 'Review conflict', exact: true });
    while (await review.count()) {
      const action: WorkloadAction = { elapsedMs: Date.now() - start, slot: win.slot, generation: win.generation, kind: 'resolve-conflict' };
      actions.push(action);
      try {
        await review.click();
        const panel = win.page.locator('.pane.active .conflict-panel').first();
        await panel.locator('pre').nth(1).waitFor();
        const [local, remote] = await panel.locator('pre').allTextContents();
        if (local === undefined || remote === undefined) throw new Error('Conflict did not expose both text versions.');
        const row = panel.locator('xpath=ancestor::*[@data-block-id][1]');
        action.target = (await row.getAttribute('data-block-id'))!;
        // The workload appends whole markers. Preserve both append-only tails,
        // cutting the common prefix at a word boundary, never inside a marker.
        let prefix = 0;
        while (prefix < local.length && local[prefix] === remote[prefix]) prefix++;
        prefix = local.lastIndexOf(' ', prefix - 1) + 1;
        const merged = remote.includes(local) ? remote : local.includes(remote) ? local : `${remote} ${local.slice(prefix)}`;
        await panel.getByRole('button', { name: 'Edit merged text', exact: true }).click();
        const editor = row.locator('.cm-content');
        await editor.focus();
        await win.page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
        await win.page.keyboard.insertText(merged);
        await panel.getByRole('button', { name: 'Use edited text', exact: true }).click();
        await win.page.waitForFunction(id => !document.querySelector(`.pane.active [data-block-id="${id}"] .conflict-label`), action.target);
      } catch (error) { action.error = String(error); throw error; }
      finally { action.finishedMs = Date.now() - start; }
    }
  }
  async function checkpoint(kind: string) {
    // Writers are paused here. Resolve intentional overlapping edits before
    // requiring their commands to drain, just as a user must in the app.
    for (const win of windows) {
      try {
        await win.page.waitForFunction(() => window.__spike.live);
        await resolveConflicts(win);
        await drained(win.page);
      } catch (error) { tracking.errors.push(String(error)); }
    }
    const revisions = await verify(base, tracking.receipts);
    const check = await api<{ ok: boolean }>(base, '/api/check');
    const commands = await Promise.all(windows.map(async win => (await storage(win.page)).outbox.commands));
    checkpoints.push({ elapsedMs: Date.now() - start, kind, revisions, check, commands });
  }
  for (let slot = 0; slot < 2; slot++) tasks.push((async () => {
    const rng = random(prngSeed + slot);
    let marker = 0;
    while (!stop && Date.now() < deadline) {
      const win = windows[slot]!;
      if (pause || win.recycling) { await sleep(25); continue; }
      win.busy = true;
      const action: WorkloadAction = { elapsedMs: Date.now() - start, slot, generation: win.generation, kind: 'pending' };
      actions.push(action);
      try {
        if (await win.page.getByRole('button', { name: 'Review conflict', exact: true }).count()) {
          action.kind = 'review-conflicts';
          await resolveConflicts(win);
          continue;
        }
        const roll = rng();
        if (roll < .12) {
          action.kind = 'find';
          const target = corpus.pages[Math.floor(rng() * corpus.pages.length)]!;
          action.target = target.title;
          await find(win.page, target.title, async error => {
            findRetries[slot]!++;
            action.findRetry = await findFailure(win, error);
          });
        } else if (roll < .16) {
          action.kind = 'back-forward';
          await win.page.keyboard.press('Control+Shift+h');
          await win.page.keyboard.press('Control+Shift+l');
        } else if (roll < .20) {
          action.kind = 'journal';
          await win.page.keyboard.press('Control+Shift+j');
          await win.page.locator('.pane.active .journal-date').waitFor();
          await win.page.locator('.pane.active .outline-row').first().waitFor();
        } else if (roll < .25) {
          action.kind = 'fold';
          const fold = win.page.locator('.pane.active .row-fold:not(:disabled)').first();
          if (await fold.count()) {
            await fold.click();
            await sleep(250);
            await fold.click();
          }
        } else {
          const rows = await win.page.locator('.pane.active .outline-row[data-block-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-block-id')!));
          if (!rows.length) throw new Error('No editable rows in the active pane.');
          const id = rows[Math.floor(rng() * Math.min(rows.length, 8))]!;
          action.kind = 'type';
          action.target = id;
          await typeMarker(win.page, id, `soak_${slot}_${++marker}_end`);
          if (roll > .78) {
            action.key = ['Enter', 'Tab', 'Shift+Tab', 'Alt+ArrowUp'][Math.floor(rng() * 4)]!;
            await win.page.keyboard.press(action.key);
          }
        }
      } catch (error) {
        action.error = action.kind === 'find' && !win.recycling ? await findFailure(win, error) : String(error);
        // Closing a context deliberately interrupts its current input action.
        if (!win.recycling && windows[slot] === win) { tracking.errors.push(`window ${slot} generation ${win.generation}: ${action.error}`); stop = true; }
      } finally {
        action.finishedMs = Date.now() - start;
        if (!win.recycling) action.state = await win.page.locator('.pane.active .pane-save-state').getAttribute('data-state').catch(() => null);
        win.busy = false;
      }
      await sleep(300 + Math.floor(rng() * 250));
    }
  })());
  let nextService = start + serviceInterval;
  let nextTab = start + tabInterval;
  let nextSample = start;
  while (!stop && Date.now() < deadline) {
    if (Date.now() >= nextService && deadline - Date.now() > 3000) {
      // Kill on an actual submitted request, rather than hoping a sleep overlaps the debounce.
      await Promise.race(windows.map(win => win.page.waitForRequest(request => new URL(request.url()).pathname === '/api/batches' && request.method() === 'POST', { timeout: 15_000 })));
      await service.kill('SIGKILL');
      forcedServiceCrashes++;
      await sleep(1500);
      pause = true;
      await service.restart();
      while (windows.some(win => win.busy)) await sleep(10);
      await checkpoint('service restart');
      pause = false;
      nextService += serviceInterval;
    }
    if (Date.now() >= nextTab && deadline - Date.now() > 3000) {
      const slot = forcedTabCrashes % 2;
      const old = windows[slot]!;
      old.recycling = true;
      await old.context.close();
      windows[slot] = await createWindow(slot, old.generation + 1);
      forcedTabCrashes++;
      nextTab += tabInterval;
    }
    if (Date.now() >= nextSample) {
      const windowSamples = [];
      for (const win of windows) windowSamples.push({ slot: win.slot, generation: win.generation, heap: await heap(win.page), storage: await storage(win.page) });
      samples.push({ elapsedMs: Date.now() - start, walBytes: service.walBytes(), windows: windowSamples });
      nextSample += sampleInterval;
    }
    await sleep(50);
  }
  stop = true;
  await Promise.all(tasks);
  await checkpoint('final');
  const windowSamples = [];
  for (const win of windows) windowSamples.push({ slot: win.slot, generation: win.generation, heap: await heap(win.page), storage: await storage(win.page) });
  samples.push({ elapsedMs: Date.now() - start, walBytes: service.walBytes(), windows: windowSamples });
} catch (error) {
  failure = String(error);
  outcomes.push({ scenario: 'Soak workload completed', pass: false, evidence: failure });
} finally {
  stop = true;
  pause = false;
  await Promise.allSettled(tasks);
  await browser?.close();
  await service?.kill();
  corpus.dispose();
}
const warmed = timing.smoke ? [timing.milliseconds / 4, timing.milliseconds / 2] : [30 * 60_000, 60 * 60_000];
const finalFrom = timing.smoke ? timing.milliseconds * .75 : timing.milliseconds - 60 * 60_000;
const heapRows = [0, 1].map(slot => {
  const baseline = median(samples.filter(sample => sample.elapsedMs >= warmed[0]! && sample.elapsedMs <= warmed[1]!).flatMap(sample => sample.windows.filter(win => win.slot === slot).map(win => win.heap.used)));
  const final = median(samples.filter(sample => sample.elapsedMs >= finalFrom).flatMap(sample => sample.windows.filter(win => win.slot === slot).map(win => win.heap.used)));
  const growth = baseline && final ? final / baseline : null;
  outcomes.push({ scenario: `Window ${slot} heap growth`, pass: growth !== null && growth <= 1.1, evidence: baseline === null || final === null ? 'Missing warmed or final sampling interval.' : `warmed ${(baseline / 1048576).toFixed(2)} MiB, final ${(final / 1048576).toFixed(2)} MiB, ratio ${growth?.toFixed(3)} (maximum 1.100)` });
  return { slot, warmedBytes: baseline, finalBytes: final, growth };
});
const lost = checkpoints.length ? Math.max(...checkpoints.map(checkpoint => checkpoint.revisions.lost)) : null;
const maxWal = samples.length ? Math.max(...samples.map(sample => sample.walBytes)) : null;
const pagesExceeded = samples.flatMap(sample => sample.windows.filter(win => win.storage.outbox.cachedPages > win.storage.pagesOpened).map(win => `at ${(sample.elapsedMs / 60000).toFixed(2)} min window ${win.slot}: ${win.storage.outbox.cachedPages} cached pages (${win.storage.outbox.pages} snapshot/patch records) / ${win.storage.pagesOpened} pages opened`));
const maxMounted = samples.length ? Math.max(...samples.flatMap(sample => sample.windows.map(win => win.storage.mounted))) : null;
outcomes.push(
  { scenario: 'Acknowledged revisions survived', pass: lost === 0, evidence: `${lost ?? 'not measured'} missing; ${tracking.receipts.length} receipts; change event membership and current revision floors checked` },
  { scenario: 'Integrity after crashes and at end', pass: checkpoints.length > 0 && checkpoints.every(checkpoint => checkpoint.check.ok), evidence: `${checkpoints.length} /api/check responses; ${forcedServiceCrashes} service crashes; ${forcedTabCrashes} context crashes` },
  { scenario: 'Find chords retried', pass: findRetries.every(count => count === 0), evidence: findRetries.map((count, slot) => `window ${slot}: ${count}`).join('; ') },
  { scenario: 'Outboxes drained after restarts and at end', pass: checkpoints.length > 0 && checkpoints.every(checkpoint => checkpoint.commands.every(count => count === 0)), evidence: checkpoints.map(checkpoint => `${checkpoint.kind}: [${checkpoint.commands.join(', ')}]`).join('; ') || 'No checkpoint.' },
  { scenario: 'WAL bounded', pass: maxWal !== null && maxWal <= 64 * 1024 * 1024, evidence: `${maxWal === null ? 'not measured' : `${(maxWal / 1048576).toFixed(2)} MiB`} peak sampled (maximum 64 MiB)` },
  { scenario: 'Outbox page records bounded', pass: pagesExceeded.length === 0 && samples.length > 0, evidence: pagesExceeded.join('; ') || 'distinct cached pages never exceeded distinct pages opened per context; raw snapshot/patch counts retained in samples' },
  { scenario: 'Mounted cache proxy bounded', pass: maxMounted !== null && maxMounted <= 102, evidence: `${maxMounted ?? 'not measured'} mounted rows, maximum 102 (existing two-pane performance budget); SubtreeCache has no public size hook` },
  { scenario: 'Workload actions', pass: failure === null && tracking.errors.length === 0, evidence: tracking.errors.join('; ') || failure || 'Seeded editing, navigation and folding completed.' },
);
const summary = table(['Runtime', 'Duration', 'Receipts', 'Lost revisions', 'Heap growth w0 / w1', 'Peak WAL', 'Service / tab crashes', 'Checks'], [[
  'chromium', `${(timing.milliseconds / 60000).toFixed(2)} min`, tracking.receipts.length, lost,
  heapRows.map(row => row.growth === null ? 'not measured' : `${((row.growth - 1) * 100).toFixed(1)}%`).join(' / '),
  maxWal === null ? null : `${(maxWal / 1048576).toFixed(2)} MiB`, `${forcedServiceCrashes} / ${forcedTabCrashes}`, checkpoints.length,
]]);
await report('soak', summary, { durationMs: timing.milliseconds, elapsedMs: start ? Date.now() - start : 0, smoke: timing.smoke, prngSeed, intervals: { serviceInterval, tabInterval, sampleInterval }, heapRows, samples, checkpoints, tracking, actions, findRetries, forcedServiceCrashes, forcedTabCrashes, failure, subtreeCache: 'not exposed; mounted rows used as proxy' }, outcomes);
