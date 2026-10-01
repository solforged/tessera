import { chromium } from 'playwright-core';
import type { CDPSession, Page } from 'playwright-core';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { correctness } from './correctness';
import type { OutlineRow } from '@spike/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'results');
const stage = Bun.argv[2];
if (stage !== 'before' && stage !== 'after' && stage !== 'report') throw new Error('Usage: bun run followup before|after|report');
const executablePath = process.env.CHROME_PATH ?? join(process.env.HOME!, 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const resultDocument = await Bun.file(join(output, 'results.json')).json();
const followUp = resultDocument.structuralFollowUp ?? { beforeMetrics: resultDocument.results.filter((result: { variant: string }) => result.variant !== 'prosemirror').map((result: { variant: string; measurements: { dpr: number }[] }) => ({ variant: result.variant, measurements: result.measurements.filter(value => value.dpr === 1) })), profiles: { before: [], after: [] }, afterMetrics: [], correctness: [], methodology: [] };

interface Frame { functionName: string; url: string; lineNumber: number; columnNumber: number }
interface Profile { nodes: { id: number; callFrame: Frame; children?: number[] }[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }
interface TraceEvent { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { data?: { message?: string }; name?: string } }
type Category = 'command/store' | 'framework/list' | 'CodeMirror/editor' | 'other JS/native' | 'idle';
interface Capture {
  phase: string;
  keys: { phase: string; key: string; time: number }[];
  events: { name: string; startTime: number; duration: number; processingStart: number; processingEnd: number }[];
}
declare global { interface Window { followUpCapture: Capture } }
const quantile = (values: number[], fraction: number) => values.length ? values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
function target(rows: OutlineRow[], key: string) {
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
async function focus(page: Page, index: number) {
  await page.evaluate(index => window.spike!.focus(index, 3), index);
  await page.evaluate(() => {
    const range = window.getSelection();
    const element = range?.focusNode instanceof Element ? range.focusNode : range?.focusNode?.parentElement;
    element?.scrollIntoView({ block: 'center' });
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function usable(page: Page, url: string, rows: number) {
  await page.goto(`${url}?rows=${rows}`);
  await page.waitForFunction(() => Boolean(window.spike && document.querySelector('[contenteditable="true"], [role="textbox"]')));
  await focus(page, Math.floor(rows / 2));
}
function unionMs(intervals: [number, number][]): number {
  const sorted = intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let start = 0;
  let end = 0;
  for (const [a, b] of sorted) {
    if (a > end) { total += end - start; start = a; end = b; }
    else end = Math.max(end, b);
  }
  return (total + end - start) / 1000;
}
async function traceData(session: CDPSession, stream: string): Promise<TraceEvent[]> {
  let content = '';
  for (;;) {
    const part = await session.send('IO.read', { handle: stream });
    content += part.base64Encoded ? Buffer.from(part.data, 'base64').toString() : part.data;
    if (part.eof) break;
  }
  await session.send('IO.close', { handle: stream });
  return JSON.parse(content).traceEvents;
}
async function attribute(profile: Profile, events: TraceEvent[], variant: string, key: string, dist: string) {
  const ranges: [number, number][] = [];
  const marks = events.filter(event => event.name === 'TimeStamp' && event.args?.data?.message?.startsWith('followup:'));
  for (let i = 0; i < 20; i++) {
    const prefix = `followup:${stage}:${variant}:${key}:${i}:`;
    const start = marks.find(event => event.args?.data?.message === `${prefix}start`);
    const end = marks.find(event => event.args?.data?.message === `${prefix}end`);
    if (!start || !end) throw new Error(`Missing trace marks for ${prefix}`);
    ranges.push([start.ts, end.ts]);
  }
  const mapCache = new Map<string, TraceMap>();
  const sources = new Map<number, { name: string; source: string; line: number }>();
  const parents = new Map<number, number>();
  const byId = new Map(profile.nodes.map(entry => [entry.id, entry]));
  for (const entry of profile.nodes) {
    for (const child of entry.children ?? []) parents.set(child, entry.id);
    let source = entry.callFrame.url;
    let name = entry.callFrame.functionName || '(anonymous)';
    let line = entry.callFrame.lineNumber + 1;
    if (/\/assets\/.*\.js$/.test(source)) {
      let map = mapCache.get(source);
      if (!map) {
        const path = join(dist, new URL(source).pathname.slice(1) + '.map');
        if (!await Bun.file(path).exists()) throw new Error(`Build ${variant} with --sourcemap before profiling.`);
        map = new TraceMap(await Bun.file(path).json() as SourceMapInput);
        mapCache.set(source, map);
      }
      if (map) {
        const original = originalPositionFor(map, { line, column: entry.callFrame.columnNumber });
        if (original.source) {
          source = original.source;
          line = original.line ?? line;
          const contentIndex = map.sources.indexOf(original.source);
          const text = map.sourcesContent?.[contentIndex]?.split('\n')[line - 1] ?? '';
          const declaration = text.match(/^\s*(?:(?:export|private|public|static|async)\s+)*(?:function\s+)?([\w$]+)\s*(?:\(|=)/);
          if (declaration && !['if', 'for', 'while', 'const', 'let', 'return'].includes(declaration[1])) name = declaration[1];
          else if (/^[\w$]{1,3}$/.test(name) && original.name) name = original.name;
        }
      }
    }
    sources.set(entry.id, { name, source, line });
  }
  const ancestry = (id: number) => {
    const chain: number[] = [];
    for (let current: number | undefined = id; current !== undefined; current = parents.get(current)) chain.push(current);
    return chain;
  };
  const classify = (id: number): Category => {
    const chain = ancestry(id).map(id => sources.get(id)!);
    if (chain[0].name === '(idle)') return 'idle';
    if (chain.some(entry => /\/src\/main\.tsx$/.test(entry.source) && entry.name === 'renderOrder')) return 'framework/list';
    for (const entry of chain) {
      if (/\/src\/(?:main\.tsx|text-editor\.ts)$/.test(entry.source) && ['focusSelection', 'focus', 'makeState', 'atEdge'].includes(entry.name)) return 'CodeMirror/editor';
      if (/codemirror|replit/.test(entry.source)) return 'CodeMirror/editor';
      if (/react-dom|react\/|solid-js/.test(entry.source)) {
        if (variant === 'solid-codemirror' && chain.some(parent => /\/src\/main\.tsx$/.test(parent.source) && ['model', 'getRow', 'ensure'].includes(parent.name))) return 'command/store';
        return 'framework/list';
      }
      if (/\/src\/(?:commands|store|outline-index)\.ts$/.test(entry.source)) return 'command/store';
      if (/\/src\/main\.tsx$/.test(entry.source) && ['model', 'apply', 'ensure', 'perform', 'undo', 'redo'].includes(entry.name)) return 'command/store';
      if (/\/src\/main\.tsx$/.test(entry.source) && ['App', 'Row', 'ReferenceText', 'renderOrder', 'Reference', 'Text'].includes(entry.name)) return 'framework/list';
    }
    return 'other JS/native';
  };
  const self = new Map<number, number>();
  let at = profile.startTime;
  const samples = (profile.samples ?? []).map((id, index) => {
    at += profile.timeDeltas?.[index] ?? 0;
    return { id, time: at };
  }).sort((a, b) => a.time - b.time);
  // V8 may deliver ticks out of timestamp order. Integrate chronological
  // observation intervals, not signed arrival deltas as CPU durations.
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const range = ranges.find(([start, end]) => sample.time >= start && sample.time < end);
    if (!range) continue;
    const end = Math.min(samples[i + 1]?.time ?? profile.endTime, range[1]);
    if (end > sample.time) self.set(sample.id, (self.get(sample.id) ?? 0) + (end - sample.time) / 1000);
  }
  const totals = new Map<number, number>();
  const categories: Record<Category, number> = { 'command/store': 0, 'framework/list': 0, 'CodeMirror/editor': 0, 'other JS/native': 0, idle: 0 };
  for (const [id, duration] of self) {
    categories[classify(id)] += duration;
    for (const ancestor of ancestry(id)) totals.set(ancestor, (totals.get(ancestor) ?? 0) + duration);
  }
  const hot = [...totals].filter(([id]) => byId.get(id)?.callFrame.url || ['(program)', '(garbage collector)'].includes(sources.get(id)!.name)).map(([id, totalMs]) => ({ ...sources.get(id)!, category: classify(id), selfMs: self.get(id) ?? 0, totalMs })).sort((a, b) => b.totalMs - a.totalMs);
  const mainThread = marks[0] ?? events.find(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain');
  const browserIntervals: Record<string, [number, number][]> = { style: [], layout: [], paint: [] };
  for (const event of events) {
    if (event.ph !== 'X' || !event.dur || mainThread && (event.pid !== mainThread.pid || event.tid !== mainThread.tid)) continue;
    const category = ['UpdateLayoutTree', 'RecalculateStyles'].includes(event.name) ? 'style' : event.name === 'Layout' ? 'layout' : ['PrePaint', 'Paint', 'Layerize', 'CompositeLayers'].includes(event.name) ? 'paint' : null;
    if (!category) continue;
    for (const [start, end] of ranges) if (event.ts < end && event.ts + event.dur > start) browserIntervals[category].push([Math.max(start, event.ts), Math.min(end, event.ts + event.dur)]);
  }
  const native = Object.fromEntries(Object.entries(browserIntervals).map(([name, values]) => [name, unionMs(values)]));
  return { variant, key, presses: 20, cpuSampledMs: categories, browserTraceMs: { ...native, union: unionMs(Object.values(browserIntervals).flat()) }, elapsedInputWindowsMs: ranges.reduce((sum, [start, end]) => sum + (end - start) / 1000, 0), hotFunctions: hot, resolvedFrames: profile.nodes.map(entry => ({ id: entry.id, ...sources.get(entry.id)!, category: classify(entry.id) })), timestampNormalization: { negativeRawDeltas: profile.timeDeltas?.filter(value => value < 0).length ?? 0, method: 'Sort observation timestamps before integrating sample intervals; raw profiles retained.' } };
}
async function profileCommand(page: Page, session: CDPSession, variant: string, url: string, key: string, dist: string) {
  await usable(page, url, 10000);
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 100 });
  const completed = new Promise<string>(resolve => session.once('Tracing.tracingComplete', value => resolve(value.stream!)));
  await session.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
  await session.send('Profiler.start');
  for (let i = 0; i < 20; i++) {
    const rows = await page.evaluate(() => window.spike!.model());
    await focus(page, target(rows, key));
    const prefix = `followup:${stage}:${variant}:${key}:${i}:`;
    await page.evaluate(label => console.timeStamp(label), `${prefix}start`);
    await page.keyboard.press(key);
    await page.evaluate(label => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { console.timeStamp(label); resolve(); }))), `${prefix}end`);
  }
  const { profile } = await session.send('Profiler.stop');
  await session.send('Tracing.end');
  const events = await traceData(session, await completed);
  const label = `${variant}-${stage}-${key === 'Enter' ? 'enter' : 'outdent'}`;
  await mkdir(join(output, 'profiles'), { recursive: true });
  await Bun.write(join(output, 'profiles', `${label}.cpuprofile`), JSON.stringify(profile));
  await Bun.write(join(output, 'profiles', `${label}.trace.json`), JSON.stringify({ traceEvents: events }));
  return { ...await attribute(profile, events, variant, key, dist), cpuProfile: `profiles/${label}.cpuprofile`, trace: `profiles/${label}.trace.json` };
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const capture: Capture = { phase: 'setup', keys: [], events: [] };
    window.followUpCapture = capture;
    document.addEventListener('keydown', event => capture.keys.push({ phase: capture.phase, key: event.key, time: event.timeStamp }), true);
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) capture.events.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration, processingStart: entry.processingStart, processingEnd: entry.processingEnd });
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit & { durationThreshold: number });
  });
}
async function measure(page: Page, url: string, rows: number) {
  await usable(page, url, rows);
  await page.evaluate(() => { window.followUpCapture.phase = 'typing'; });
  for (let i = 0; i < 200; i++) { await page.keyboard.press(i % 2 ? 'x' : 'y'); await page.waitForTimeout(16); }
  for (const key of ['Enter', 'Tab', 'Shift+Tab', 'Alt+ArrowUp']) {
    for (let i = 0; i < 50; i++) {
      const outline = await page.evaluate(() => window.spike!.model());
      await page.evaluate(() => { window.followUpCapture.phase = 'setup'; });
      await focus(page, target(outline, key));
      await page.evaluate(key => { window.followUpCapture.phase = key; }, key);
      await page.keyboard.press(key);
      await page.waitForTimeout(16);
    }
  }
  await page.waitForTimeout(160);
  const capture = await page.evaluate(() => window.followUpCapture);
  const metrics = Object.fromEntries(['typing', 'Enter', 'Tab', 'Shift+Tab', 'Alt+ArrowUp'].map(phase => {
    const targetKey = phase === 'Shift+Tab' ? 'Tab' : phase === 'Alt+ArrowUp' ? 'ArrowUp' : phase;
    const keys = capture.keys.filter(key => key.phase === phase && (phase === 'typing' ? key.key === 'x' || key.key === 'y' : key.key === targetKey));
    const events = keys.map(key => capture.events.find(event => event.name === 'keydown' && Math.abs(event.startTime - key.time) < 1)).filter((event): event is typeof capture.events[number] => Boolean(event));
    const durations = events.map(event => event.duration);
    const processing = events.map(event => event.processingEnd - event.processingStart);
    return [phase, { p50: quantile(durations, 0.5), p95: quantile(durations, 0.95), max: durations.length ? Math.max(...durations) : null, processingP99ObservedMs: quantile(processing, 0.99), samples: keys.length, observed: events.length }];
  }));
  return { rows, dpr: 1, typing: metrics.typing, structural: Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== 'typing')) };
}

const browser = stage === 'report' ? null : await chromium.launch({ executablePath, headless: true });
try {
  if (browser) {
    const profiles = [];
    const metrics = [];
    const outcomes = [];
    for (const variant of ['react-codemirror', 'solid-codemirror']) {
      const dist = join(root, variant, 'dist');
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const path = resolve(dist, new URL(request.url).pathname === '/' ? 'index.html' : '.' + new URL(request.url).pathname);
        if (!path.startsWith(dist + '/')) return new Response('Not found', { status: 404 });
        const file = Bun.file(path);
        return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
      } });
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      const url = `http://127.0.0.1:${server.port}/`;
      try {
        for (const key of ['Enter', 'Shift+Tab']) {
          const result = await profileCommand(page, session, variant, url, key, dist);
          profiles.push(result);
          console.log(`${stage} ${variant} ${key}: CPU ${JSON.stringify(result.cpuSampledMs)}; native ${JSON.stringify(result.browserTraceMs)}`);
        }
        if (stage === 'after') {
          outcomes.push({ variant, scenarios: await correctness(page, url) });
          await instrument(page);
          const measurements = [];
          for (const rows of [2000, 10000]) { const value = await measure(page, url, rows); measurements.push(value); console.log(`after ${variant} ${rows}: ${JSON.stringify(value)}`); }
          metrics.push({ variant, measurements });
        }
      } finally { await session.detach(); await context.close(); await server.stop(true); }
    }
    followUp.profiles[stage] = profiles;
    if (stage === 'after') { followUp.afterMetrics = metrics; followUp.correctness = outcomes; }
  }
} finally { await browser?.close(); }
followUp.methodology = [
  'Release bundles with source maps; CDP Profiler sampling interval 100 microseconds. Twenty Enter and twenty Shift+Tab presses per variant at 10,000 rows, DPR 1.',
  'Trace console timestamps bound each actual input through two animation frames. Target lookup, focus and runner model reads are excluded from sampled CPU attribution.',
  'CPU self/total times are statistical samples. Self samples produce the attribution buckets; function total includes descendants in other buckets. Renderer-owned list projections are framework/list, not command/store. CodeMirror/editor and unattributed native/JS samples are separate.',
  'Raw V8 profiles contain out-of-order observation timestamps (negative arrival deltas). Samples are sorted by reconstructed timestamp and interval-integrated inside input bounds, rather than treating signed arrival deltas as CPU durations. Raw profiles and per-profile normalization counts are retained.',
  'Browser style/layout/paint uses non-overlapping duration unions from CrRendererMain trace events inside the same input windows. CPU samples and browser trace durations are not additive because native work can appear in both.',
  'After Event Timing has no profiling active; it repeats the original 200 typing and 50 per-structural-command input counts at 2,000/10,000 rows, DPR 1. Load, heap, DPR 2 and ProseMirror were not remeasured.',
  'Reproduction: build both variants with --sourcemap, then run bun run --cwd spikes/editor/runner followup before|after. The report mode regenerates documentation from stored measurements without opening Chrome.',
];
followUp.changes = [
  'Both variants read commands from one framework-independent indexed outline, instead of materializing model() or scanning the page for row IDs and parents on every structural key.',
  'The implicit treap maintains subtree size, parent pointers and minimum depth incrementally. Rank, boundary lookup and subtree movement are expected O(log n); insert/delete/depth shifts are O(k + log n) for k affected rows. Text replacement remains keyed O(1).',
  'Split stores a text patch and one insertion, not copies of unchanged children. Merge stores the removed row and prior text. Move and depth inverses are constant-size operations; cross-block deletion retains only its deleted range.',
  'Order revisions change only when IDs are inserted, removed or reordered. Depth-only operations notify affected rows and do not invalidate the row list. Solid imports the React spike framework-independent outline-index module without importing React runtime.',
];
followUp.remaining = [
  'Rendering still projects all row IDs and reconciles a fully mounted list whenever order changes. That O(n) projection/reconciliation is deliberately retained as framework/list work, not hidden as an optimized command.',
  'CodeMirror focus/measure paths still force style and layout over the fully mounted page. Browser native work is visible in the trace and also under JS wrapper CPU frames such as focusPreventScroll; those measures overlap.',
  'Windowing must bound list projection/reconciliation, mounted DOM size and focus-induced style/layout/paint. This follow-up does not certify presented-frame budgets or declare spike 2 passed.',
];
resultDocument.structuralFollowUp = followUp;
await Bun.write(join(output, 'results.json'), JSON.stringify(resultDocument, null, 2) + '\n');
const oldSummary = (await Bun.file(join(output, 'summary.md')).text());
let summary = (await oldSummary).split('\n## Structural command follow-up')[0];
const fmt = (value: number | null) => value === null ? 'not reported' : value.toFixed(2);
summary += '\n## Structural command follow-up\n\nThe preceding table remains the **before** result. Follow-up input and profile results below do not replace its load, heap, DPR 2 or ProseMirror measurements.\n\n';
summary += '| Stage | Variant | Command, 20 presses | Command/store CPU ms | Framework/list CPU ms | CodeMirror CPU ms | Other CPU ms | Style ms | Layout ms | Paint ms |\n|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n';
for (const stage of ['before', 'after']) for (const profile of followUp.profiles[stage]) summary += `| ${stage} | ${profile.variant} | ${profile.key} | ${fmt(profile.cpuSampledMs['command/store'])} | ${fmt(profile.cpuSampledMs['framework/list'])} | ${fmt(profile.cpuSampledMs['CodeMirror/editor'])} | ${fmt(profile.cpuSampledMs['other JS/native'])} | ${fmt(profile.browserTraceMs.style)} | ${fmt(profile.browserTraceMs.layout)} | ${fmt(profile.browserTraceMs.paint)} |\n`;
summary += '\n### Hot functions\n\n';
for (const stage of ['before', 'after']) for (const profile of followUp.profiles[stage]) {
  summary += `#### ${stage}: ${profile.variant}, ${profile.key}\n\n[CPU profile](${profile.cpuProfile}) · [Browser trace](${profile.trace})\n\n| Function | Source | Category | Self ms | Total ms |\n|---|---|---|---:|---:|\n`;
  type HotFrame = { category: string; name: string; source: string; line: number; selfMs: number; totalMs: number };
  const functions: HotFrame[] = [];
  const seen = new Set<string>();
  for (const category of ['command/store', 'framework/list', 'CodeMirror/editor', 'other JS/native']) {
    const frames: HotFrame[] = profile.hotFunctions.filter((frame: HotFrame) => frame.category === category && frame.name !== '(anonymous)');
    for (const frame of [...frames.slice(0, 3), ...frames.slice().sort((a, b) => b.selfMs - a.selfMs).slice(0, 4)]) {
      const key = `${frame.source}:${frame.line}:${frame.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      functions.push(frame);
    }
  }
  for (const frame of functions) summary += `| ${frame.name} | ${frame.source}:${frame.line} | ${frame.category} | ${fmt(frame.selfMs)} | ${fmt(frame.totalMs)} |\n`;
  summary += '\n';
}
if (followUp.afterMetrics.length) {
  summary += '### Before and after input work\n\n| Variant | Rows | Input | Before handler p99 ms | After handler p99 ms | Before paint p95 ms | After paint p95 ms |\n|---|---:|---|---:|---:|---:|---:|\n';
  for (const result of followUp.afterMetrics) for (const value of result.measurements) {
    const before = followUp.beforeMetrics.find((entry: { variant: string }) => entry.variant === result.variant).measurements.find((entry: { rows: number }) => entry.rows === value.rows);
    for (const key of ['typing', 'Enter', 'Tab', 'Shift+Tab', 'Alt+ArrowUp']) {
      const a = key === 'typing' ? before.typing : before.structural[key];
      const b = key === 'typing' ? value.typing : value.structural[key];
      summary += `| ${result.variant} | ${value.rows} | ${key} | ${fmt(a.processingP99ObservedMs)} | ${fmt(b.processingP99ObservedMs)} | ${fmt(a.p95)} | ${fmt(b.p95)} |\n`;
    }
  }
  summary += '\n### Correctness after command-store cutover\n\n';
  for (const result of followUp.correctness) { summary += `- ${result.variant}: ${result.scenarios.filter((scenario: { pass: boolean }) => scenario.pass).length}/${result.scenarios.length} passed.\n`; for (const scenario of result.scenarios) if (!scenario.pass) summary += `  - Fail: ${scenario.scenario}. ${scenario.reason}\n`; }
}
summary += '\n### Changes and remaining work\n\n' + followUp.changes.map((line: string) => `- ${line}`).join('\n') + '\n\n' + followUp.remaining.map((line: string) => `- ${line}`).join('\n') + '\n';
summary += '\n### Attribution limits\n\n' + followUp.methodology.map((line: string) => `- ${line}`).join('\n') + '\n';
await Bun.write(join(output, 'summary.md'), summary);
console.log(`Saved ${stage} structural follow-up attribution and retained initial measurements.`);
