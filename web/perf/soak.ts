import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import { api, root, Service, sleep } from './lib/service';
import { seed } from './lib/seed';
import { drained, duration, find, heap, instrument, launch, median, open, random, ready, storage, tracker, typeMarker, verify } from './lib/metrics';
import type { HeapSample, Outcome, RevisionCheck, StorageSample } from './lib/metrics';
import { report, table } from './lib/report';

interface WindowRun { context: BrowserContext; page: Page; slot: number; generation: number; busy: boolean; recycling: boolean; pageErrors: { at: number; message: string }[] }
interface Sample { elapsedMs: number; walBytes: number; dbBytes: number; windows: { slot: number; generation: number; heap: HeapSample; storage: StorageSample }[] }
interface Checkpoint { elapsedMs: number; kind: string; revisions: RevisionCheck; check: { ok: boolean }; commands: number[] }
interface WorkloadAction { elapsedMs: number; slot: number; generation: number; kind: string; target?: string; key?: string; finishedMs?: number; state?: string | null; findRetry?: string; error?: string; fallback?: string }

async function findFailure(win: WindowRun, error: unknown) {
  const directory = join(root, 'web/perf/results');
  mkdirSync(directory, { recursive: true });
  const screenshot = join(directory, `soak-find-${Date.now()}-window-${win.slot}-generation-${win.generation}.png`);
  const screenshotError = await win.page.screenshot({ path: screenshot, fullPage: true }).then(() => null, error => String(error));
  const state = await win.page.evaluate(() => ({
    activeElement: document.activeElement?.outerHTML.slice(0, 2000),
    activeAncestry: (() => {
      const ancestors = [];
      for (let element = document.activeElement; element; element = element.parentElement) ancestors.push({ tag: element.tagName, id: element.id, class: element.getAttribute('class') });
      return ancestors;
    })(),
    popups: [...document.querySelectorAll('.popup')].map(element => element.outerHTML.slice(0, 300)),
    keys: window.__spike.keys,
    overlays: [...document.querySelectorAll('.popup, [role="dialog"], [role="listbox"], .conflict-panel, .cm-tooltip, .save-banner')].map(element => ({ tag: element.tagName, class: element.className, role: element.getAttribute('role'), label: element.getAttribute('aria-label'), text: element.textContent?.slice(0, 2000) })),
    inputs: [...document.querySelectorAll('input')].map(element => ({ placeholder: element.placeholder, label: element.getAttribute('aria-label') })),
  })).catch(error => ({ captureError: String(error) }));
  return `${String(error)}\nFind state: ${JSON.stringify({ screenshot: screenshotError ? null : screenshot, screenshotError, ...state, pageErrors: win.pageErrors })}`;
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
const findFailures = [0, 0];
const unreachableRows = [0, 0];
const windows: WindowRun[] = [];
const tasks: Promise<void>[] = [];
let browser: Browser | undefined;
let service: Service | undefined;
let stop = false;
let pause = false;
let start = 0;
let forcedServiceCrashes = 0;
let forcedTabCrashes = 0;
let regressionServiceCrashes = 0;
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
    const pageErrors: WindowRun['pageErrors'] = [];
    page.on('pageerror', error => {
      pageErrors.push({ at: Date.now(), message: error.stack ?? String(error) });
      if (pageErrors.length > 20) pageErrors.shift();
    });
    await ready(page, base);
    const fixture = corpus.pages[slot]!;
    await open(page, fixture.id, fixture.blocks[slot]!);
    return { context, page, slot, generation, busy: false, recycling: false, pageErrors };
  }
  async function reloadTarget(win: WindowRun, target: typeof corpus.pages[number]) {
    const opened = await win.page.evaluate(() => window.__spike.opened);
    await ready(win.page, base);
    await win.page.evaluate(opened => { window.__spike.opened = [...new Set([...opened, ...window.__spike.opened])]; }, opened);
    await open(win.page, target.id, target.blocks[0]);
  }
  async function findOrReload(win: WindowRun, target: typeof corpus.pages[number], action: WorkloadAction) {
    try {
      await find(win.page, target.title, async error => {
        findRetries[win.slot]!++;
        action.findRetry = await findFailure(win, error);
      });
      return true;
    } catch (error) {
      if (win.recycling) throw error;
      findFailures[win.slot]!++;
      action.error = await findFailure(win, error);
      // The shell has no HTTP page route: reload its base, then use its public
      // open event to restore the requested target in the same browser context.
      await reloadTarget(win, target);
      action.fallback = `Reloaded ${base} and opened ${target.id}`;
      return false;
    }
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
  shortcutCheck.pass = await findOrReload(windows[0]!, corpus.pages[0]!, shortcutAction);
  shortcutCheck.evidence = shortcutCheck.pass
    ? 'Ctrl+Shift+F opened Find with the journal caret before existing text, after Enter and ArrowUp.'
    : shortcutAction.error!;
  const fieldsCheck: Outcome = { scenario: 'Find and commands with unavailable fields', pass: false, evidence: 'Failed-field lookup regression did not complete.' };
  const fieldsAction: WorkloadAction = { elapsedMs: 0, slot: 0, generation: 0, kind: 'find-fields-regression', target: corpus.pages[0]!.title };
  outcomes.push(fieldsCheck);
  actions.push(fieldsAction);
  const failFields = (route: Route) => route.abort('failed');
  await shortcutPage.route('**/api/fields', failFields);
  try {
    const rejected = shortcutPage.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/api/fields' });
    await typeMarker(shortcutPage, corpus.pages[0]!.blocks[0]!, 'soak_fields_failure_end');
    await rejected;
    await shortcutPage.evaluate(() => {
      const settled = Promise.withResolvers<void>();
      requestAnimationFrame(() => requestAnimationFrame(() => settled.resolve()));
      return settled.promise;
    });
    await shortcutPage.keyboard.press('Control+Shift+p');
    const commandInput = shortcutPage.getByPlaceholder('Find a command');
    await commandInput.fill('>Open as table');
    await shortcutPage.getByText('Field definitions are unavailable.', { exact: true }).waitFor();
    await shortcutPage.keyboard.press('Escape');
    await commandInput.waitFor({ state: 'hidden' });
    await find(shortcutPage, corpus.pages[0]!.title, error => { throw error; });
    fieldsCheck.pass = true;
    fieldsCheck.evidence = 'A failed /api/fields read left Find usable and Open as table disabled with its unavailable reason.';
  } catch (error) {
    fieldsAction.error = await findFailure(windows[0]!, error);
    fieldsCheck.evidence = fieldsAction.error;
  } finally {
    await shortcutPage.unroute('**/api/fields', failFields);
    await reloadTarget(windows[0]!, corpus.pages[0]!);
  }
  const reconnectQuery = corpus.pages[1]!.title;
  const reconnectCheck: Outcome = { scenario: 'Find query recovered after service restart', pass: false, evidence: 'Search did not resume.' };
  const reconnectAction: WorkloadAction = { elapsedMs: 0, slot: 0, generation: 0, kind: 'find-reconnect-regression', target: reconnectQuery };
  outcomes.push(reconnectCheck);
  actions.push(reconnectAction);
  let serviceStopped = false;
  try {
    await service.kill('SIGKILL');
    serviceStopped = true;
    regressionServiceCrashes++;
    await shortcutPage.waitForFunction(() => !window.__spike.live);
    const failedSearch = shortcutPage.waitForEvent('requestfailed', { predicate: request => {
      const url = new URL(request.url());
      return url.pathname === '/api/search' && url.searchParams.get('q') === reconnectQuery;
    } });
    await shortcutPage.keyboard.press('Control+Shift+f');
    await shortcutPage.getByPlaceholder('Find or create an atom').fill(reconnectQuery);
    await failedSearch;
    await Promise.all([
      shortcutPage.waitForResponse(response => {
        const url = new URL(response.url());
        return response.ok() && url.pathname === '/api/search' && url.searchParams.get('q') === reconnectQuery;
      }),
      service.restart().then(() => { serviceStopped = false; }),
    ]);
    await shortcutPage.locator('[role="option"]').filter({ hasText: reconnectQuery }).first().waitFor();
    reconnectCheck.pass = true;
    reconnectCheck.evidence = 'The unchanged query refetched successfully after reconnect, without another chord or keystroke.';
  } catch (error) {
    reconnectAction.error = await findFailure(windows[0]!, error);
    reconnectCheck.evidence = reconnectAction.error;
  } finally {
    if (serviceStopped) await service.restart();
    await reloadTarget(windows[0]!, corpus.pages[0]!);
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
        // Resolution is a command like any other; offline it only queues, and the label stays until the ack.
        await win.page.waitForFunction(() => window.__spike.live, undefined, { timeout: 60_000 });
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
        await win.page.waitForFunction(id => !document.querySelector(`.pane.active [data-block-id="${id}"] .conflict-label`), action.target, { timeout: 30_000 });
      } catch (error) {
        const panel = await win.page.locator('.pane.active .conflict-panel').first().evaluate(element => element.outerHTML.slice(0, 1500)).catch(() => 'no conflict panel');
        const state = await win.page.locator('.pane.active .pane-save-state').evaluate(element => element.outerHTML.slice(0, 500)).catch(() => 'no save state');
        action.error = `${String(error)}\nconflict panel: ${panel}\nsave state: ${state}`;
        throw error;
      }
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
          await findOrReload(win, target, action);
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
        if (win.recycling || windows[slot] !== win) {
          // Closing a context deliberately interrupts its current input action.
        } else if (action.kind === 'type' && /detached|not attached/.test(action.error)) {
          // A row the other window moved or split can stay unreachable across the bounded click attempts.
          // That is counted, with the row's state captured, rather than ending an eight-hour run.
          unreachableRows[slot]!++;
          action.fallback = await win.page.evaluate(id => ({ present: !!document.querySelector(`.pane.active [data-block-id="${id}"]`), rows: document.querySelectorAll('.pane.active .outline-row[data-block-id]').length, state: document.querySelector('.pane.active .pane-save-state')?.getAttribute('data-state') }), action.target).then(value => JSON.stringify(value), error => String(error));
        } else { tracking.errors.push(`window ${slot} generation ${win.generation}: ${action.error}`); stop = true; }
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
      samples.push({ elapsedMs: Date.now() - start, walBytes: service.walBytes(), dbBytes: service.dbBytes(), windows: windowSamples });
      nextSample += sampleInterval;
    }
    await sleep(50);
  }
  stop = true;
  await Promise.all(tasks);
  await checkpoint('final');
  const windowSamples = [];
  for (const win of windows) windowSamples.push({ slot: win.slot, generation: win.generation, heap: await heap(win.page), storage: await storage(win.page) });
  samples.push({ elapsedMs: Date.now() - start, walBytes: service.walBytes(), dbBytes: service.dbBytes(), windows: windowSamples });
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
// Contexts are replaced every tabInterval, so growth is measured within each generation's life. A context is
// warmed once it has opened most of the pages it will ever open, since every new page adds to the client's
// caches by design; the warmed median runs from that point to 40 percent of its life, or over the second
// quarter when saturation comes later, and is compared with the median of its last 15 percent. The trend
// across generations catches growth that survives a context replacement. The workload appends text to every
// block it touches, so the workshop itself grows; the trend is allowed to follow the database, not exceed it.
const dbAt = (elapsedMs: number) => samples.reduce((best, sample) => Math.abs(sample.elapsedMs - elapsedMs) < Math.abs(best.elapsedMs - elapsedMs) ? sample : best, samples[0]!).dbBytes;
const heapRows = [0, 1].map(slot => {
  const byGeneration = new Map<number, { elapsedMs: number; used: number; pagesOpened: number }[]>();
  const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
  for (const sample of samples) for (const win of sample.windows) {
    if (win.slot !== slot) continue;
    if (!byGeneration.has(win.generation)) byGeneration.set(win.generation, []);
    byGeneration.get(win.generation)!.push({ elapsedMs: sample.elapsedMs, used: win.heap.used, pagesOpened: win.storage.pagesOpened });
  }
  const generations = [...byGeneration.entries()].sort(([a], [b]) => a - b).flatMap(([generation, rows]) => {
    if (rows.length < 8) return [];
    const born = rows[0]!.elapsedMs, died = rows[rows.length - 1]!.elapsedMs, life = died - born;
    const opened = rows[rows.length - 1]!.pagesOpened;
    const saturated = rows.find(row => row.pagesOpened >= opened * .8)?.elapsedMs ?? died;
    let warmedRows = rows.filter(row => row.elapsedMs >= saturated && row.elapsedMs - born <= life * .4);
    const basis = warmedRows.length >= 2 ? 'after opening 80 percent of its pages' : 'second quarter of its life';
    if (warmedRows.length < 2) warmedRows = rows.filter(row => row.elapsedMs - born >= life * .25 && row.elapsedMs - born <= life * .4);
    const warmed = median(warmedRows.map(row => row.used));
    const final = median(rows.filter(row => row.elapsedMs - born >= life * .85).map(row => row.used));
    return warmed && final ? [{ generation, warmed, final, growth: final / warmed, basis, pagesOpened: opened, dbBytes: dbAt(died) }] : [];
  });
  const growth = median(generations.map(row => row.growth));
  const worst = generations.length ? Math.max(...generations.map(row => row.growth)) : null;
  // The first generation includes startup allocations, so the trend starts at the second one when there are three or more.
  const base = generations.length > 2 ? generations[1]! : generations[0];
  const last = generations[generations.length - 1];
  const trend = base && last && generations.length >= 2 ? last.final / base.final : null;
  const dbTrend = base && last && generations.length >= 2 && base.dbBytes ? last.dbBytes / base.dbBytes : null;
  const lives = generations.map(row => `gen ${row.generation}: ${mib(row.warmed)} → ${mib(row.final)} (${row.growth.toFixed(3)}, warmed ${row.basis}, ${row.pagesOpened} pages opened)`).join('; ');
  outcomes.push(
    { scenario: `Window ${slot} heap growth within a context`, pass: growth !== null && growth <= 1.1, evidence: growth === null ? 'No context lived long enough for a warmed and a final interval.' : `median ratio ${growth.toFixed(3)}, worst ${worst!.toFixed(3)} across ${generations.length} generations (maximum 1.100); ${lives}` },
    { scenario: `Window ${slot} heap trend across contexts`, pass: trend === null ? timing.smoke : trend <= Math.max(1.1, dbTrend ?? 1), evidence: trend === null ? `Fewer than two measured generations${timing.smoke ? '; a smoke run does not measure the trend' : ''}.` : `end-of-life heap ratio ${trend.toFixed(3)} from the second measured generation to the last, while the workshop grew ${dbTrend?.toFixed(3) ?? 'unmeasured'} (${mib(base!.dbBytes)} → ${mib(last!.dbBytes)}); maximum is the larger of 1.100 and the workshop ratio` },
  );
  return { slot, generations, growth, worst, trend, dbTrend };
});
const lost = checkpoints.length ? Math.max(...checkpoints.map(checkpoint => checkpoint.revisions.lost)) : null;
const maxWal = samples.length ? Math.max(...samples.map(sample => sample.walBytes)) : null;
const pagesExceeded = samples.flatMap(sample => sample.windows.filter(win => win.storage.outbox.cachedPages > win.storage.pagesOpened).map(win => `at ${(sample.elapsedMs / 60000).toFixed(2)} min window ${win.slot}: ${win.storage.outbox.cachedPages} cached pages (${win.storage.outbox.pages} snapshot/patch records) / ${win.storage.pagesOpened} pages opened`));
const maxMounted = samples.length ? Math.max(...samples.flatMap(sample => sample.windows.map(win => win.storage.mounted))) : null;
outcomes.push(
  { scenario: 'Acknowledged revisions survived', pass: lost === 0, evidence: `${lost ?? 'not measured'} missing; ${tracking.receipts.length} receipts; change event membership and current revision floors checked` },
  { scenario: 'Integrity after crashes and at end', pass: checkpoints.length > 0 && checkpoints.every(checkpoint => checkpoint.check.ok), evidence: `${checkpoints.length} /api/check responses; ${forcedServiceCrashes} workload service crashes; ${regressionServiceCrashes} regression service crashes; ${forcedTabCrashes} context crashes` },
  { scenario: 'Find chords retried', pass: findRetries.every(count => count === 0), evidence: findRetries.map((count, slot) => `window ${slot}: ${count}`).join('; ') },
  { scenario: 'Find failed', pass: findFailures.every(count => count === 0), evidence: findFailures.map((count, slot) => `window ${slot}: ${count}`).join('; ') },
  { scenario: 'Rows reachable for typing', pass: unreachableRows.every(count => count === 0), evidence: unreachableRows.map((count, slot) => `window ${slot}: ${count} rows stayed detached across three click attempts`).join('; ') },
  { scenario: 'Outboxes drained after restarts and at end', pass: checkpoints.length > 0 && checkpoints.every(checkpoint => checkpoint.commands.every(count => count === 0)), evidence: checkpoints.map(checkpoint => `${checkpoint.kind}: [${checkpoint.commands.join(', ')}]`).join('; ') || 'No checkpoint.' },
  { scenario: 'WAL bounded', pass: maxWal !== null && maxWal <= 64 * 1024 * 1024, evidence: `${maxWal === null ? 'not measured' : `${(maxWal / 1048576).toFixed(2)} MiB`} peak sampled (maximum 64 MiB)` },
  { scenario: 'Outbox page records bounded', pass: pagesExceeded.length === 0 && samples.length > 0, evidence: pagesExceeded.join('; ') || 'distinct cached pages never exceeded distinct pages opened per context; raw snapshot/patch counts retained in samples' },
  { scenario: 'Mounted cache proxy bounded', pass: maxMounted !== null && maxMounted <= 102, evidence: `${maxMounted ?? 'not measured'} mounted rows, maximum 102 (existing two-pane performance budget); SubtreeCache has no public size hook` },
  { scenario: 'Workload actions', pass: failure === null && tracking.errors.length === 0, evidence: tracking.errors.join('; ') || failure || 'Seeded editing, navigation and folding completed.' },
);
const summary = table(['Runtime', 'Duration', 'Receipts', 'Lost revisions', 'Heap growth w0 / w1 (within, across)', 'Peak WAL', 'Service / tab crashes', 'Checks'], [[
  'chromium', `${(timing.milliseconds / 60000).toFixed(2)} min`, tracking.receipts.length, lost,
  heapRows.map(row => row.growth === null ? 'not measured' : `${((row.growth - 1) * 100).toFixed(1)}%, ${row.trend === null ? 'one generation' : `${((row.trend - 1) * 100).toFixed(1)}%`}`).join(' / '),
  maxWal === null ? null : `${(maxWal / 1048576).toFixed(2)} MiB`, `${forcedServiceCrashes + regressionServiceCrashes} / ${forcedTabCrashes}`, checkpoints.length,
]]);
await report('soak', summary, { durationMs: timing.milliseconds, elapsedMs: start ? Date.now() - start : 0, smoke: timing.smoke, prngSeed, intervals: { serviceInterval, tabInterval, sampleInterval }, heapRows, samples, checkpoints, tracking, actions, findRetries, findFailures, unreachableRows, forcedServiceCrashes, regressionServiceCrashes, forcedTabCrashes, failure, subtreeCache: 'not exposed; mounted rows used as proxy' }, outcomes);
