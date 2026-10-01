import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { correctness } from './correctness';
import type { Outcome } from './correctness';
import type { OutlineRow } from '@spike/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const environment = { platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model ?? 'not available', memoryBytes: totalmem() };
const variants = ['react-codemirror', 'solid-codemirror', 'prosemirror'];
const requested = Bun.argv.slice(2);
for (const name of requested) if (!variants.includes(name)) throw new Error(`Unknown variant: ${name}`);
const executablePath = process.env.CHROME_PATH ?? join(process.env.HOME!, 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
if (!await Bun.file(executablePath).exists()) throw new Error(`Chrome for Testing is missing: ${executablePath}`);

type Quantile = number | null;
interface Timing { p50: Quantile; p95: Quantile; max: Quantile; samples: number; observed: number; belowThresholdOrUnreported: number; processingP99ObservedMs: number | null }
interface EventEntry { name: string; startTime: number; duration: number; processingStart: number; processingEnd: number }
interface KeyEntry { startTime: number; key: string; phase: string }
interface LongTask { startTime: number; duration: number }
interface Capture { events: EventEntry[]; keys: KeyEntry[]; longTasks: LongTask[]; phase: string; supported: boolean }
declare global { interface Window { __capture: Capture } }
interface Measurement {
  rows: number; dpr: number; coldLoadMs: number; warmLoadMs: { p50: number; p95: number; max: number; samples: number };
  heapAfterLoadBytes: number; typing: Timing; structural: Record<string, Timing>;
  longTasks: { load: LongTask[]; typing: LongTask[]; structural: LongTask[] };
  eventTimingSupported: boolean;
}
interface VariantResult { variant: string; correctness: Outcome[]; measurements: Measurement[]; errors: string[] }
const percentile = (values: number[], fraction: number): number => values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
function timing(capture: Capture, phase: string): Timing {
  const targetKey = phase === 'Shift+Tab' ? 'Tab' : phase === 'Alt+ArrowUp' ? 'ArrowUp' : phase;
  const keys = capture.keys.filter(entry => entry.phase === phase && (phase === 'typing' ? entry.key === 'x' || entry.key === 'y' : entry.key === targetKey));
  const samples = keys.map(key => capture.events.find(entry => entry.name === 'keydown' && Math.abs(entry.startTime - key.startTime) < 1));
  const observed = samples.filter((entry): entry is EventEntry => Boolean(entry));
  const durations = observed.map(entry => entry.duration);
  const quantile = (fraction: number): Quantile => durations.length ? percentile(durations, fraction) : null;
  return { p50: quantile(0.5), p95: quantile(0.95), max: quantile(1), samples: keys.length, observed: observed.length, belowThresholdOrUnreported: keys.length - observed.length, processingP99ObservedMs: observed.length ? percentile(observed.map(entry => entry.processingEnd - entry.processingStart), 0.99) : null };
}
async function instrumentation(page: Page) {
  await page.addInitScript(() => {
    window.__capture = { events: [], keys: [], longTasks: [], phase: 'load', supported: PerformanceObserver.supportedEntryTypes.includes('event') };
    document.addEventListener('keydown', event => {
      window.__capture.keys.push({ startTime: event.timeStamp, key: event.key, phase: window.__capture.phase });
    }, true);
    if (window.__capture.supported) new PerformanceObserver(list => {
      for (const raw of list.getEntries()) {
        const entry = raw as PerformanceEventTiming;
        window.__capture.events.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration, processingStart: entry.processingStart, processingEnd: entry.processingEnd });
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit & { durationThreshold: number });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__capture.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
}
async function load(page: Page, url: string, rows: number): Promise<number> {
  await page.goto(`${url}?rows=${rows}`);
  await page.waitForFunction(() => Boolean(window.spike && document.querySelector('[contenteditable="true"], [role="textbox"], [tabindex="0"]')));
  await page.evaluate(() => window.spike!.focus(0, 0));
  await page.waitForFunction(() => Boolean(window.spike!.selection() && document.activeElement && (document.activeElement as HTMLElement).isContentEditable));
  return await page.evaluate(() => new Promise<number>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));
}
function structuralIndex(rows: OutlineRow[], key: string): number {
  const middle = Math.floor(rows.length / 2);
  if (key === 'Enter') return middle;
  if (key === 'Shift+Tab') {
    for (let i = middle; i < rows.length; i++) if (rows[i].depth > 0) return i;
  }
  for (let i = middle; i < rows.length; i++) {
    let previous = i - 1;
    while (previous >= 0 && rows[previous].depth > rows[i].depth) previous--;
    if (previous >= 0 && rows[previous].depth === rows[i].depth) return i;
  }
  throw new Error(`No valid target for ${key}`);
}
async function measure(browser: Browser, url: string, rows: number, dpr: number, errors: string[]): Promise<Measurement> {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: dpr, colorScheme: 'dark' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await instrumentation(page);
  try {
    const coldLoadMs = await load(page, url, rows);
    await page.waitForTimeout(100);
    const coldCapture = await page.evaluate(() => window.__capture);
    const session = await context.newCDPSession(page);
    await session.send('Performance.enable');
    const metrics = await session.send('Performance.getMetrics');
    const heapAfterLoadBytes = metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')!.value;
    await session.detach();
    const warm: number[] = [];
    for (let i = 0; i < 5; i++) warm.push(await load(page, url, rows));
    await page.evaluate(() => window.spike!.focus(Math.floor(window.spike!.model().length / 2), 3));
    await page.waitForTimeout(40);
    await page.evaluate(() => {
      const selection = document.getSelection();
      const element = selection?.focusNode instanceof Element ? selection.focusNode : selection?.focusNode?.parentElement;
      element?.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(40);
    await page.evaluate(() => { window.__capture.events = []; window.__capture.keys = []; window.__capture.longTasks = []; window.__capture.phase = 'typing'; });
    const typingStart = await page.evaluate(() => performance.now());
    for (let i = 0; i < 200; i++) { await page.keyboard.press(i % 2 ? 'x' : 'y'); await page.waitForTimeout(16); }
    await page.waitForTimeout(160);
    const typingEnd = await page.evaluate(() => performance.now());
    const boundaries: Record<string, [number, number]> = {};
    for (const key of ['Enter', 'Tab', 'Shift+Tab', 'Alt+ArrowUp']) {
      boundaries[key] = [await page.evaluate(() => performance.now()), 0];
      for (let i = 0; i < 50; i++) {
        const outline = await page.evaluate(() => window.spike!.model());
        const index = structuralIndex(outline, key);
        await page.evaluate(({ index }) => { window.__capture.phase = 'setup'; window.spike!.focus(index, 3); }, { index });
        await page.waitForTimeout(20);
        await page.evaluate(() => {
          const selection = document.getSelection();
          const element = selection?.focusNode instanceof Element ? selection.focusNode : selection?.focusNode?.parentElement;
          element?.scrollIntoView({ block: 'center' });
        });
        await page.waitForTimeout(20);
        await page.evaluate(key => { window.__capture.phase = key; }, key);
        await page.keyboard.press(key);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(160);
      boundaries[key][1] = await page.evaluate(() => performance.now());
    }
    const capture = await page.evaluate(() => window.__capture);
    const structural = Object.fromEntries(Object.keys(boundaries).map(key => [key, timing(capture, key)]));
    return {
      rows, dpr, coldLoadMs,
      warmLoadMs: { p50: percentile(warm, 0.5), p95: percentile(warm, 0.95), max: Math.max(...warm), samples: warm.length },
      heapAfterLoadBytes, typing: timing(capture, 'typing'), structural,
      longTasks: {
        load: coldCapture.longTasks,
        typing: capture.longTasks.filter(task => task.startTime >= typingStart && task.startTime <= typingEnd),
        structural: capture.longTasks.filter(task => Object.values(boundaries).some(([start, end]) => task.startTime >= start && task.startTime <= end)),
      },
      eventTimingSupported: capture.supported,
    };
  } finally { await context.close(); }
}

const skipped: { variant: string; reason: string }[] = [];
const results: VariantResult[] = [];
const browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-precise-memory-info'] });
try {
  for (const variant of requested.length ? requested : variants) {
    const dist = join(root, variant, 'dist');
    if (!await Bun.file(join(dist, 'index.html')).exists()) {
      skipped.push({ variant, reason: 'Built dist/index.html is missing; variant was not measured.' });
      console.log(`Skipping ${variant}: missing build`);
      continue;
    }
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const path = resolve(dist, pathname === '/' ? 'index.html' : `.${pathname}`);
      if (!path.startsWith(`${dist}/`)) return new Response('Not found', { status: 404 });
      const file = Bun.file(path);
      if (!await file.exists()) return new Response('Not found', { status: 404 });
      return new Response(file);
    } });
    const url = `http://127.0.0.1:${server.port}/`;
    const result: VariantResult = { variant, correctness: [], measurements: [], errors: [] };
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.on('pageerror', error => result.errors.push(error.message));
    try {
      result.correctness = await correctness(page, url);
      console.log(`${variant}: correctness ${result.correctness.filter(outcome => outcome.pass).length}/${result.correctness.length}`);
      for (const rows of [2000, 10000]) for (const dpr of [1, 2]) {
        try {
          const measurement = await measure(browser, url, rows, dpr, result.errors);
          result.measurements.push(measurement);
          console.log(`${variant} ${rows} DPR ${dpr}: cold ${measurement.coldLoadMs.toFixed(1)} ms; typing p95 ${measurement.typing.p95}; structural ${Object.entries(measurement.structural).map(([key, value]) => `${key}=${value.p95}`).join(', ')}`);
        } catch (error) { result.errors.push(`${rows} rows DPR ${dpr}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      results.push(result);
    } finally { await context.close(); await server.stop(true); }
  }
} finally { await browser.close(); }

const budgets = { frameIntervalMs: { hz120: 8.33, hz60: 16.67 }, applicationWorkP99Ms: { hz120: 6, hz60: 12 }, inputToPaintP95Ms: { hz120: 16, hz60: 33 }, navigationMs: { cold: 500, warmP95: 100 } };
const limitations = [
  'Headless next-paint Event Timing is a proxy, not on-device presented-frame timing. No 60/120 Hz presentation trace was captured.',
  'Event Timing has a 16 ms minimum reporting threshold and 8 ms quantization. Percentiles summarize reported keydown entries only and are conservative truncated distributions, not fabricated 0 ms samples. Below-threshold or unreported events are counted separately; a phase with no entries has null percentiles.',
  'processingP99ObservedMs covers only reported keydown handlers, not all application/render/layout work per frame. The 6/12 ms application-work frame budgets are not certified.',
  'Each matrix cell uses one empty-cache context load and five same-context warm reloads. Usable load ends after first-row focus and two animation frames. The 200 mid-page typing keys and 50 keys per structural command are paced by 16 ms waits; focused rows are centered before sampling, and setup focus/model reads are outside event samples but can contribute long tasks.',
  'IME uses one CDP composition/commit scenario per variant, not a full OS input-method matrix. Vim, undo and cross-block selection correctness run once per variant on an 80-row corpus.',
  'One fully mounted pane was measured. Two-pane load, reference completion, service commits, search, windowing, long scrolling and soak behavior were not measured.',
];
const fmt = (value: number | string | null) => typeof value === 'number' ? value.toFixed(1) : value ?? 'not reported';
const report = ['# Editor spike comparison', '', `Measured ${new Date().toISOString()} on ${environment.cpu}, ${fmt(environment.memoryBytes / 1073741824)} GiB RAM, ${environment.platform}/${environment.arch} ${environment.osRelease}, headless Chrome ${browser.version()}.`, '', '## Measurement budgets', '', '120 Hz: 8.33 ms frames, application work p99 6 ms, input-to-paint p95 16 ms. 60 Hz: 16.67 ms frames, application work p99 12 ms, input-to-paint p95 33 ms. Cold usable load 500 ms; warm usable load p95 100 ms.', '', '## Results', '', '| Variant | Rows | DPR | Cold usable ms | Warm p95 ms | Heap MiB | Typing p50/p95/max ms | Enter p95 | Tab p95 | Shift+Tab p95 | Move p95 | Load/input long tasks |', '|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|'];
for (const result of results) for (const value of result.measurements) report.push(`| ${result.variant} | ${value.rows} | ${value.dpr} | ${fmt(value.coldLoadMs)} | ${fmt(value.warmLoadMs.p95)} | ${fmt(value.heapAfterLoadBytes / 1048576)} | ${fmt(value.typing.p50)}/${fmt(value.typing.p95)}/${fmt(value.typing.max)} | ${fmt(value.structural.Enter.p95)} | ${fmt(value.structural.Tab.p95)} | ${fmt(value.structural['Shift+Tab'].p95)} | ${fmt(value.structural['Alt+ArrowUp'].p95)} | ${value.longTasks.load.length}/${value.longTasks.typing.length + value.longTasks.structural.length} |`);
report.push('', 'Latency percentiles cover reported Event Timing entries only (at least 16 ms). Structural p50/p95/max, attempted/observed sample coverage, handler-processing p99 and every long-task duration are in results.json.', '', '## Comparison', '');
for (const result of results) {
  if (!result.measurements.length) continue;
  const typing = result.measurements.map(value => value.typing.p95).filter((value): value is number => value !== null);
  const structure = result.measurements.flatMap(value => Object.values(value.structural).map(timing => timing.p95)).filter((value): value is number => value !== null);
  report.push(`- ${result.variant}: worst-cell reported typing p95 ${fmt(typing.length ? Math.max(...typing) : null)} ms; structural p95 ${fmt(structure.length ? Math.max(...structure) : null)} ms; peak loaded heap ${fmt(Math.max(...result.measurements.map(value => value.heapAfterLoadBytes)) / 1048576)} MiB; correctness ${result.correctness.filter(outcome => outcome.pass).length}/${result.correctness.length}.`);
}
report.push('', '## Correctness', '');
for (const result of results) {
  report.push(`### ${result.variant}`, '', `${result.correctness.filter(outcome => outcome.pass).length}/${result.correctness.length} scenarios passed.`, '');
  for (const outcome of result.correctness) report.push(`- ${outcome.pass ? 'Pass' : 'Fail'}: ${outcome.scenario}. ${outcome.reason}`);
  for (const error of [...new Set(result.errors)]) report.push(`- Runtime/measurement error: ${error}`);
  report.push('');
}
for (const value of skipped) report.push(`- Skipped ${value.variant}: ${value.reason}`);
const meets = (value: Quantile, budget: number) => value !== null && value <= budget;
const candidates = results.filter(result => result.measurements.length === 4 && result.errors.length === 0 && result.correctness.every(outcome => outcome.pass) && result.measurements.every(value => value.eventTimingSupported && value.typing.samples === 200 && Object.values(value.structural).every(timing => timing.samples === 50)));
const passes60 = candidates.filter(result => result.measurements.every(value => meets(value.typing.p95, 33) && Object.values(value.structural).every(timing => meets(timing.p95, 33))));
const passes120 = passes60.filter(result => result.measurements.every(value => meets(value.typing.p95, 16) && Object.values(value.structural).every(timing => meets(timing.p95, 16))));
report.push('', '## Recommendation', '');
report.push(`Zero-wrong-outcome candidates: ${candidates.map(result => result.variant).join(', ') || 'none'}. Headless 60 Hz input-latency proxy candidates: ${passes60.map(result => result.variant).join(', ') || 'none'}. Headless 120 Hz input-latency proxy candidates: ${passes120.map(result => result.variant).join(', ') || 'none'}.`);
if (passes60.some(result => result.variant === 'react-codemirror')) report.push('Keep React with one active CodeMirror as the provisional architecture choice: it meets the measured correctness and 60 Hz input proxy criteria. Do not declare spike 2 passed until on-device frame/application-work traces meet the full frame budgets.');
else if (passes60.length) report.push(`The provisional measured alternative is ${passes60[0].variant}. React does not meet all measured proxy criteria; do not retain it as a settled spike result without correcting its recorded failures. Full on-device frame proof is still required.`);
else report.push('Do not settle the editor stack or declare spike 2 passed. No variant meets both zero wrong outcomes and the measured 60 Hz input proxy budget across all four matrix cells. Fix the recorded correctness/latency failures, then capture real presentation traces.');
for (const result of results) {
  const coldFailures = result.measurements.filter(value => value.coldLoadMs > 500).length;
  const warmFailures = result.measurements.filter(value => value.warmLoadMs.p95 > 100).length;
  report.push(`${result.variant}: cold-load budget misses ${coldFailures}/4; warm-load budget misses ${warmFailures}/4.`);
}
report.push('', '## Limits and unmeasured work', '', ...limitations.map(value => `- ${value}`), '');
const output = join(root, 'results');
await mkdir(output, { recursive: true });
await Bun.write(join(output, 'results.json'), JSON.stringify({ measuredAt: new Date().toISOString(), chrome: executablePath, browser: browser.version(), environment, budgets, limitations, skipped, results }, null, 2) + '\n');
await Bun.write(join(output, 'summary.md'), report.join('\n'));
console.log(`Wrote ${output}/results.json and summary.md`);
