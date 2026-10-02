import { chromium } from 'playwright-core';
import { SourceMap } from 'node:module';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Block } from '../src/api/types';
import { focus, load } from './correctness';

interface Frame { functionName: string; url: string; lineNumber: number; columnNumber: number }
interface Node { id: number; callFrame: Frame; children?: number[] }
interface Profile { nodes: Node[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }
interface TraceEvent { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { name?: string } }
interface Cost { id: number; name: string; source: string; category: string; selfMs: number; totalMs: number }
const root = import.meta.dir;
const phase = process.env.PROFILE_PHASE ?? 'before';
const url = process.env.OUTLINE_URL ?? 'http://127.0.0.1:4340';
const service = process.env.TESSERA_SERVICE ?? 'http://127.0.0.1:4340';
const chrome = process.env.CHROME_PATH ?? join(process.env.HOME!, 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const output = join(root, 'results');
await mkdir(output, { recursive: true });
if (phase === 'before') for (const file of ['results.json', 'summary.md']) {
  const existing = Bun.file(join(output, file));
  if (await existing.exists()) await Bun.write(join(output, `before-${file}`), existing);
}
const maps = new Map<string, SourceMap>();
const payloads = new Map<string, { sources: string[]; sourcesContent: string[] }>();
for await (const file of new Bun.Glob('assets/*.js.map').scan(join(root, 'dist'))) {
  const payload = await Bun.file(join(root, 'dist', file)).json();
  const name = file.slice(0, -4).split('/').at(-1)!;
  maps.set(name, new SourceMap(payload)); payloads.set(name, payload);
  await Bun.write(join(output, `${phase}-${name}.map`), JSON.stringify(payload));
}
function label(frame: Frame): Omit<Cost, 'id' | 'selfMs' | 'totalMs'> {
  const bundle = frame.url.split('/').at(-1)!;
  const mapped = maps.get(bundle)?.findEntry(frame.lineNumber, frame.columnNumber);
  const entry = mapped && 'originalSource' in mapped ? mapped : undefined;
  const source = entry?.originalSource ?? frame.url;
  const line = entry?.originalLine ?? frame.lineNumber;
  const payload = payloads.get(bundle);
  const text = payload?.sourcesContent[payload.sources.indexOf(source)];
  let name = frame.functionName;
  if (text && /^[A-Za-z_$][\w$]?$/.test(name)) {
    const lines = text.split('\n');
    for (let at = line; at >= Math.max(0, line - 45); at--) {
      const declaration = /^\s*(?:export\s+)?(?:private\s+|async\s+|static\s+)*(?:function\s+([\w$]+)|([\w$]+)\([^)]*\)\s*(?::[^=]+)?\s*\{)/.exec(lines[at] ?? '');
      if (declaration) { name = declaration[1] ?? declaration[2]!; break; }
    }
  }
  const category = source.includes('solid-js') ? 'Solid reactivity' : source.includes('document/outbox') || source.includes('/idb/') ? 'Outbox / IndexedDB' : source.includes('document/') ? 'Document / queue / lookup' : source.includes('virtual') ? 'Visibility / virtualizer' : source.includes('outline/visibility') ? 'Visibility / virtualizer' : source.includes('codemirror') ? 'CodeMirror' : source.includes('outline/') ? 'Outline effects / rendering' : source.includes('perf/') ? 'Harness' : frame.url ? 'Other JavaScript' : 'Browser / idle / GC';
  return { name: name || '(anonymous)', source: `${source}:${line + 1}`, category };
}
function costs(profile: Profile) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const result = new Map<number, Cost>();
  for (let at = 0; at < profile.samples.length; at++) {
    const sampled = profile.samples[at]!;
    const time = Math.max(0, profile.timeDeltas[at]!) / 1000;
    let id: number | undefined = sampled;
    while (id !== undefined) {
      let cost = result.get(id);
      if (!cost) { cost = { id, ...label(byId.get(id)!.callFrame), selfMs: 0, totalMs: 0 }; result.set(id, cost); }
      if (id === sampled) cost.selfMs += time;
      cost.totalMs += time;
      id = parents.get(id);
    }
  }
  return [...result.values()].sort((a, b) => b.selfMs - a.selfMs);
}
function traceCosts(events: TraceEvent[]) {
  const threads = new Set(events.filter(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain').map(event => `${event.pid}:${event.tid}`));
  const totals = new Map<string, { count: number; totalMs: number }>();
  for (const event of events) if (event.ph === 'X' && event.dur && threads.has(`${event.pid}:${event.tid}`)) {
    const value = totals.get(event.name) ?? { count: 0, totalMs: 0 };
    value.count++; value.totalMs += event.dur / 1000; totals.set(event.name, value);
  }
  return [...totals].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.totalMs - a.totalMs);
}
const roots = await (await fetch(`${service}/api/roots`)).json() as Block[];
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const measurements = [];
try {
  for (const rows of [2000, 10000]) {
    const pageId = roots.find(root => root.text === (rows === 2000 ? 'Page 00001' : 'Page 00002'))!.id;
    for (const kind of ['typing', 'structural']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
      try {
        const page = await context.newPage();
        await load(page, url, pageId, true);
        const snapshot = await page.evaluate(() => window.outlinePerf.snapshot());
        await focus(page, snapshot[Math.floor(snapshot.length / 2)]!.id, 3);
        await page.waitForTimeout(300);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
        await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
        await cdp.send('Profiler.start');
        const started = performance.now();
        for (let key = 0; key < (kind === 'typing' ? 50 : 12); key++) {
          await page.keyboard.press(kind === 'typing' ? key % 2 ? 'x' : 'y' : 'Enter');
          await page.waitForTimeout(20);
        }
        await page.waitForFunction(() => window.outlinePerf.document().saveState() === 'saved');
        await page.waitForTimeout(200);
        const elapsed = performance.now() - started;
        const { profile } = await cdp.send('Profiler.stop') as { profile: Profile };
        const complete = new Promise<{ stream?: string }>(resolve => cdp.once('Tracing.tracingComplete', resolve));
        await cdp.send('Tracing.end');
        const { stream } = await complete;
        if (!stream) throw new Error('Chrome did not return the requested trace stream.');
        let trace = '';
        while (true) { const chunk = await cdp.send('IO.read', { handle: stream }); trace += chunk.data; if (chunk.eof) break; }
        await cdp.send('IO.close', { handle: stream });
        const parsed = JSON.parse(trace) as { traceEvents: TraceEvent[] };
        const functions = costs(profile);
        const categories = new Map<string, number>();
        for (const cost of functions) categories.set(cost.category, (categories.get(cost.category) ?? 0) + cost.selfMs);
        const result = { rows, actualRows: snapshot.length, kind, elapsed, discardedNegativeDeltas: profile.timeDeltas.filter(delta => delta < 0).length, functions, categories: Object.fromEntries(categories), trace: traceCosts(parsed.traceEvents) };
        measurements.push(result);
        await Bun.write(join(output, `${phase}-${rows}-${kind}.cpuprofile`), JSON.stringify(profile));
        await Bun.write(join(output, `${phase}-${rows}-${kind}.trace.json`), trace);
        console.log(JSON.stringify({ rows, kind, elapsed, categories: result.categories, hot: functions.filter(cost => cost.category !== 'Browser / idle / GC').slice(0, 16), trace: result.trace.slice(0, 15) }, null, 2));
      } finally { await context.close(); }
    }
  }
  await Bun.write(join(output, `profile-${phase}.json`), JSON.stringify({ phase, browser: browser.version(), time: new Date().toISOString(), measurements }, null, 2));
} finally { await browser.close(); }
