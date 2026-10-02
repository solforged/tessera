import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { cpus, release } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Block, PageView } from '../src/api/types';
import { correctness, focus, load } from './correctness';
import type { Outcome } from './correctness';

interface Latency { kind: string; handler: number; frame: number | null; phase: string; start: number }
interface KeyTiming { key: string; start: number; phase: string; composing: boolean; editor: boolean; block: string | null }
interface EventTiming { name: string; key: string; start: number; duration: number; processing: number; phase: string }
interface Capture { latency: Latency[]; events: EventTiming[]; keys: KeyTiming[]; longTasks: { duration: number; phase: string }[]; phase: string; maxMounted: number }
declare global { interface Window { perfCapture: Capture } }
interface Stats { samples: number; attempted: number; handlerP99: number | null; frameP95: number | null; eventP95: number | null; eventSamples: number }
interface Measurement { rows: number; visible: number; cold: number; warmP95: number; mountedMax: number; anchorDrift: number; foldingDrift: number; typing: Stats; structural: Record<string, Stats>; longTasks: Capture['longTasks']; capture: Capture; errors: string[] }
const url = process.env.OUTLINE_URL ?? 'http://127.0.0.1:4340';
const service = process.env.TESSERA_SERVICE ?? 'http://127.0.0.1:4340';
const chrome = process.env.CHROME_PATH ?? join(process.env.HOME!, 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const percentile = (values: number[], fraction: number) => values.length ? values.slice().sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]! : null;
function stats(capture: Capture, phase: string): Stats {
  const latency = capture.latency.filter(sample => sample.phase === phase);
  const targetKey = phase === 'Shift+Tab' ? 'Tab' : phase === 'Alt+ArrowUp' ? 'ArrowUp' : phase;
  const wanted = (key: string) => phase === 'typing' ? key === 'x' || key === 'y' : key === targetKey;
  const events = capture.events.filter(sample => sample.phase === phase && sample.name === 'keydown' && wanted(sample.key));
  const attempted = capture.keys.filter(sample => sample.phase === phase && wanted(sample.key)).length;
  return { samples: latency.length, attempted, handlerP99: percentile(latency.map(sample => sample.handler), .99), frameP95: percentile(latency.flatMap(sample => sample.frame === null ? [] : [sample.frame]), .95), eventP95: percentile(events.map(sample => sample.duration), .95), eventSamples: events.length };
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    window.perfCapture = { latency: [], events: [], keys: [], longTasks: [], phase: 'load', maxMounted: 0 };
    const samples = new Map<number, Latency>();
    document.addEventListener('keydown', event => {
      const element = document.activeElement;
      window.perfCapture.keys.push({ key: event.key, start: event.timeStamp, phase: window.perfCapture.phase, composing: event.isComposing, editor: !!element?.closest('.cm-content'), block: element?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId ?? null });
    }, true);
    document.addEventListener('outline-handler', event => {
      const detail = (event as CustomEvent<{ kind: string; handler: number; start: number }>).detail;
      const sample = { ...detail, frame: null, phase: window.perfCapture.phase };
      samples.set(detail.start, sample);
      window.perfCapture.latency.push(sample);
    });
    document.addEventListener('outline-latency', event => {
      const detail = (event as CustomEvent<{ start: number; frame: number }>).detail;
      const sample = samples.get(detail.start);
      if (sample) sample.frame = detail.frame;
    });
    if (PerformanceObserver.supportedEntryTypes.includes('event')) new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const event = entry as PerformanceEventTiming;
        let key: KeyTiming | undefined;
        let nearest = 1;
        for (let index = window.perfCapture.keys.length - 1; index >= 0; index--) {
          const candidate = window.perfCapture.keys[index]!;
          const difference = Math.abs(candidate.start - event.startTime);
          if (difference < nearest) { key = candidate; nearest = difference; }
        }
        window.perfCapture.events.push({ name: event.name, key: key?.key ?? '', start: event.startTime, duration: event.duration, processing: event.processingEnd - event.processingStart, phase: key?.phase ?? window.perfCapture.phase });
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit & { durationThreshold: number });
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.perfCapture.longTasks.push({ duration: entry.duration, phase: window.perfCapture.phase }); }).observe({ type: 'longtask', buffered: true });
    const observer = new MutationObserver(() => { window.perfCapture.maxMounted = Math.max(window.perfCapture.maxMounted, document.querySelectorAll('[data-block-id]').length); });
    document.addEventListener('DOMContentLoaded', () => observer.observe(document.body, { subtree: true, childList: true }));
  });
}
async function usable(page: Page, id: string) {
  const start = performance.now();
  await load(page, url, id, true);
  await page.evaluate(() => { if (!window.outlinePerf.view().showArchived) window.outlinePerf.command('show-archived'); });
  return performance.now() - start;
}
async function anchor(page: Page) {
  return await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('[data-pane="main"]')!;
    const top = pane.getBoundingClientRect().top;
    let anchor: { id: string; offset: number } | null = null;
    for (const row of pane.querySelectorAll<HTMLElement>('[data-block-id]')) {
      const rect = row.getBoundingClientRect();
      const offset = rect.top - top;
      if (rect.bottom > top && (!anchor || offset < anchor.offset)) anchor = { id: row.dataset.blockId!, offset };
    }
    return anchor;
  });
}
async function measure(page: Page, id: string, rows: number): Promise<Measurement> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await instrument(page);
  const cold = await usable(page, id);
  const warm: number[] = [];
  for (let index = 0; index < 5; index++) {
    const start = performance.now();
    await page.evaluate(() => window.outlinePerf.restore(window.outlinePerf.view()));
    await page.waitForFunction(() => !!document.querySelector('[data-pane="main"] .cm-content'));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    warm.push(performance.now() - start);
  }
  const snapshot = await page.evaluate(() => window.outlinePerf.snapshot());
  const target = snapshot[Math.floor(snapshot.length / 2)]!;
  await focus(page, target.id, 3);
  await page.evaluate(() => { window.perfCapture.phase = 'typing'; });
  for (let index = 0; index < 100; index++) { await page.keyboard.press(index % 2 ? 'x' : 'y'); await page.waitForTimeout(20); }
  await page.waitForTimeout(80);
  const structural: Record<string, Stats> = {};
  for (const key of ['Enter', 'Tab', 'Shift+Tab', 'Alt+ArrowUp']) {
    for (let index = 0; index < 31; index++) {
      const rows = await page.evaluate(() => window.outlinePerf.snapshot());
      const start = Math.floor(rows.length / 2);
      let choice = rows[start]!;
      if (key !== 'Enter') {
        const match = rows.slice(start).find((row, offset) => {
          if (key === 'Shift+Tab') return row.depth > 0;
          let previous = start + offset - 1;
          while (previous >= 0 && rows[previous]!.depth > row.depth) previous--;
          return previous >= 0 && rows[previous]!.parent === row.parent;
        });
        if (match) choice = match;
      }
      await page.evaluate(() => { window.perfCapture.phase = 'setup'; });
      await focus(page, choice.id, 3);
      await page.evaluate(key => { window.perfCapture.phase = key; }, key);
      await page.keyboard.press(key); await page.waitForTimeout(50);
    }
    await page.waitForTimeout(80);
  }
  await page.evaluate(() => { window.perfCapture.phase = 'scroll'; });
  let anchorDrift = 0;
  for (let index = 0; index < 20; index++) {
    await page.locator('[data-pane="main"]').evaluate((element, index) => { element.scrollTop = element.scrollHeight * (index % 2 ? .8 : .2); }, index);
    await page.waitForTimeout(80);
    const before = await anchor(page);
    await page.waitForTimeout(100);
    if (before) {
      const after = await page.locator(`[data-pane="main"] [data-block-id="${before.id}"]`).evaluate(element => element.getBoundingClientRect().top - element.closest('.outline-pane')!.getBoundingClientRect().top).catch(() => null);
      if (after !== null) anchorDrift = Math.max(anchorDrift, Math.abs(after - before.offset));
    }
  }
  // Pin an active parent above a surviving anchor and fold its whole subtree.
  // Unlike a fold below the viewport, this really changes the anchor's index.
  const foldPair = await page.evaluate(() => {
    const rows = window.outlinePerf.snapshot();
    for (let index = Math.floor(rows.length / 2); index < rows.length - 1; index++) {
      if (rows[index + 1]!.depth <= rows[index]!.depth) continue;
      let end = index + 1;
      while (end < rows.length && rows[end]!.depth > rows[index]!.depth) end++;
      if (end < rows.length) return { parent: rows[index]!.id, anchor: rows[end]!.id };
    }
    throw new Error('Corpus has no parent followed by a surviving scroll anchor.');
  });
  await page.evaluate(pair => window.outlinePerf.restore({
    ...window.outlinePerf.view(), caret: { id: pair.parent, offset: 0 }, scroll: { id: pair.anchor, offset: 0 },
  }), foldPair);
  await page.waitForTimeout(200);
  const beforeFold = await page.locator(`[data-pane="main"] [data-block-id="${foldPair.anchor}"]`).evaluate(element => element.getBoundingClientRect().top - element.closest('.outline-pane')!.getBoundingClientRect().top);
  await page.locator(`[data-pane="main"] [data-block-id="${foldPair.parent}"] .row-fold`).evaluate((button: HTMLButtonElement) => button.click());
  await page.waitForTimeout(200);
  const afterFold = await page.locator(`[data-pane="main"] [data-block-id="${foldPair.anchor}"]`).evaluate(element => element.getBoundingClientRect().top - element.closest('.outline-pane')!.getBoundingClientRect().top);
  const foldingDrift = Math.abs(afterFold - beforeFold);
  const capture = await page.evaluate(() => window.perfCapture);
  for (const key of capture.keys) {
    if (['typing', 'Enter', 'Tab', 'Shift+Tab', 'Alt+ArrowUp'].includes(key.phase) && ['x', 'y', 'Enter', 'Tab', 'ArrowUp'].includes(key.key) && !key.editor) {
      errors.push(`Editor lost focus before ${key.phase} at ${key.start.toFixed(1)} ms.`);
    }
  }
  for (const key of ['Enter', 'Tab', 'Shift+Tab', 'Alt+ArrowUp']) structural[key] = stats(capture, key);
  return { rows, visible: await page.locator('[data-pane="main"] [data-block-id]').count(), cold, warmP95: percentile(warm, .95)!, mountedMax: capture.maxMounted, anchorDrift, foldingDrift, typing: stats(capture, 'typing'), structural, longTasks: capture.longTasks, capture, errors };
}

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-precise-memory-info'] });
let outcomes: Outcome[] = [];
const measurements: Measurement[] = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
try {
  outcomes = await correctness(page, url, service);
  console.log(outcomes.map(outcome => `${outcome.pass ? 'PASS' : 'FAIL'} ${outcome.scenario}: ${outcome.evidence}`).join('\n'));
  const roots = await (await fetch(`${service}/api/roots`)).json() as Block[];
  for (const size of [2000, 10000]) {
    const title = size === 2000 ? 'Page 00001' : 'Page 00002';
    const root = roots.find(root => root.text === title);
    if (!root) throw new Error(`Missing benchmark ${title}; generate seeded 50000-block corpus first.`);
    const view = await (await fetch(`${service}/api/pages/${root.id}`)).json() as PageView;
    if (view.rows.length < size) throw new Error(`${title} has ${view.rows.length} rows, not ${size}.`);
    const measureContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    try { measurements.push(await measure(await measureContext.newPage(), root.id, size)); console.log(`Measured ${size} rows`); }
    finally { await measureContext.close(); }
  }
  const output = join(import.meta.dir, 'results');
  await mkdir(output, { recursive: true });
  const environment = { cpu: cpus()[0]?.model, system: `${process.platform}/${process.arch} ${release()}`, browser: browser.version(), time: new Date().toISOString() };
  await Bun.write(join(output, 'results.json'), JSON.stringify({ environment, outcomes, measurements }, null, 2));
  const fmt = (value: number | null) => value === null ? 'unreported' : value.toFixed(2);
  const summary = [
    '# Spike 3 · windowed daily outline', '',
    `Measured ${environment.time}, ${environment.cpu}, ${environment.system}, headless Chrome ${environment.browser}. Real tessera service, seeded 50,000-block notebook, two shared-document panes.`, '',
    'Headless Event Timing and double-requestAnimationFrame are proxies, not on-device presentation traces. Event Timing reports only entries ≥16 ms and is 8 ms quantized; unreported entries are not fabricated as zero. Handler p99 covers explicit outline handlers, not total browser frame work. Cold load fetches the production fixture and real page; warm loads are five remounts of the shared cached PageDocument, as on history navigation. Both panes include archived rows. Structural setup/remount and corpus inspection are outside input samples. A retained parent above the viewport is folded while measuring a surviving later anchor.', '',
    '## Budgets', '',
    '120 Hz: input/structural p95 16 ms, application work p99 6 ms. 60 Hz: input/structural p95 33 ms, work p99 12 ms. Cold usable 500 ms, warm usable p95 100 ms. Mounted rows bounded by viewport + 8-row overscan each side + one retained active row per pane; anchor drift ≤2 px.', '',
    '| Rows | Cold usable ms | Warm p95 ms | Peak mounted, two panes | Long-scroll drift px | Fold drift px | Typing handler p99 ms | Typing frame proxy p95 ms | Typing Event Timing p95 ms |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const result of measurements) summary.push(`| ${result.rows} | ${fmt(result.cold)} | ${fmt(result.warmP95)} | ${result.mountedMax} | ${fmt(result.anchorDrift)} | ${fmt(result.foldingDrift)} | ${fmt(result.typing.handlerP99)} | ${fmt(result.typing.frameP95)} | ${fmt(result.typing.eventP95)} (${result.typing.eventSamples} reported) |`);
  summary.push('', '| Rows | Structural key | Handler p99 ms | Frame proxy p95 ms | Event Timing p95 ms | Handler samples |', '|---:|---|---:|---:|---:|---:|');
  for (const result of measurements) for (const [key, timing] of Object.entries(result.structural)) summary.push(`| ${result.rows} | ${key} | ${fmt(timing.handlerP99)} | ${fmt(timing.frameP95)} | ${fmt(timing.eventP95)} (${timing.eventSamples} reported) | ${timing.samples}/${timing.attempted} |`);
  summary.push('', '## Correctness', '', ...outcomes.map(outcome => `- ${outcome.pass ? 'PASS' : 'FAIL'} **${outcome.scenario}** — ${outcome.evidence}`), '', '## Budget assessment', '');
  for (const result of measurements) {
    const maximumFrame = Math.max(result.typing.frameP95 ?? Infinity, ...Object.values(result.structural).map(timing => timing.frameP95 ?? Infinity));
    const maximumHandler = Math.max(result.typing.handlerP99 ?? Infinity, ...Object.values(result.structural).map(timing => timing.handlerP99 ?? Infinity));
    summary.push(`- ${result.rows}: row bound ${result.mountedMax <= 102 ? 'PASS' : 'FAIL'} (≤102 across two 858px viewports); anchor ${result.anchorDrift <= 2 && result.foldingDrift <= 2 ? 'PASS' : 'FAIL'}; handler 120/60 Hz ${maximumHandler <= 6 ? 'PASS/PASS' : maximumHandler <= 12 ? 'FAIL/PASS' : 'FAIL/FAIL'}; frame proxy 120/60 Hz ${maximumFrame <= 16 ? 'PASS/PASS' : maximumFrame <= 33 ? 'FAIL/PASS' : 'FAIL/FAIL'}; cold ${result.cold <= 500 ? 'PASS' : 'FAIL'}, warm ${result.warmP95 <= 100 ? 'PASS' : 'FAIL'}. Long tasks ${result.longTasks.length}; runtime errors ${result.errors.length}.`);
  }
  summary.push('', 'No claim of 60/120 Hz presentation correctness is made without on-device presentation traces. Raw events, processing samples and all long tasks are in results.json. Run: `bun run --cwd web vite build --config perf/vite.config.ts`; `target/release/tessera serve --notebook /tmp/tessera-Outline/corpus-50000-42 --port 4340 --assets web/perf/dist`; `bun web/perf/run.ts`. The runner creates isolated proof pages and edits the benchmark pages; regenerate the disposable notebook before another complete measurement.', '');
  await Bun.write(join(output, 'summary.md'), summary.join('\n'));
  console.log(`Wrote ${output}/summary.md`);
  if (outcomes.some(outcome => !outcome.pass) || measurements.some(result => result.errors.length)) process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
