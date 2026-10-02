import { join } from 'node:path';
interface Cost { id?: number; name: string; source: string; category: string; selfMs: number; totalMs: number }
interface Cpu { nodes: { id: number; callFrame: { functionName: string }; children?: number[] }[]; samples: number[]; timeDeltas: number[] }
interface Trace { traceEvents: { name: string; ph: string; dur?: number; args?: { data?: { url?: string } } }[] }
interface Measurement { rows: number; kind: string; functions: Cost[]; trace: { name: string; totalMs: number }[] }
const directory = join(import.meta.dir, 'results');
const reports: { phase: string; measurements: (Measurement & { categories: Record<string, number>; discardedNegativeDeltas: number; requests: Record<string, number> })[] }[] = [];
function sampled(profile: Cpu, positive: boolean) {
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const result = new Map<number, { id: number; selfMs: number; totalMs: number }>();
  for (let at = 0; at < profile.samples.length; at++) {
    const sampled = profile.samples[at]!;
    const delta = profile.timeDeltas[at]!;
    const time = (positive ? Math.max(0, delta) : delta) / 1000;
    let id: number | undefined = sampled;
    while (id !== undefined) {
      let cost = result.get(id);
      if (!cost) { cost = { id, selfMs: 0, totalMs: 0 }; result.set(id, cost); }
      if (id === sampled) cost.selfMs += time;
      cost.totalMs += time;
      id = parents.get(id);
    }
  }
  return [...result.values()].sort((a, b) => b.selfMs - a.selfMs);
}
for (const phase of ['before', 'after']) {
  const input = await Bun.file(join(directory, `profile-${phase}.json`)).json() as { measurements: Measurement[] };
  const measurements = [];
  for (const measurement of input.measurements) {
    const cpu = await Bun.file(join(directory, `${phase}-${measurement.rows}-${measurement.kind}.cpuprofile`)).json() as Cpu;
    const labels = new Map<number, Cost>();
    if (measurement.functions.every(cost => cost.id !== undefined)) for (const cost of measurement.functions) labels.set(cost.id!, cost);
    else {
      const signed = sampled(cpu, false);
      for (let at = 0; at < signed.length; at++) {
        const original = measurement.functions[at]!;
        const cost = signed[at]!;
        if (Math.abs(original.selfMs - cost.selfMs) > 1e-8 || Math.abs(original.totalMs - cost.totalMs) > 1e-8) throw new Error('Baseline CPU label order differs from its raw samples.');
        labels.set(cost.id, original);
      }
    }
    const functions = sampled(cpu, true).map(cost => {
      const label = labels.get(cost.id)!;
      return { ...label, ...cost, category: label.source.includes('/idb/') ? 'Outbox / IndexedDB' : label.category };
    });
    const categories = new Map<string, number>();
    for (const cost of functions) categories.set(cost.category, (categories.get(cost.category) ?? 0) + cost.selfMs);
    const trace = await Bun.file(join(directory, `${phase}-${measurement.rows}-${measurement.kind}.trace.json`)).json() as Trace;
    const requests = new Map<string, number>();
    for (const event of trace.traceEvents) if (event.name === 'ResourceSendRequest') {
      const url = event.args?.data?.url;
      if (!url) continue;
      const kind = /\/api\/([^/?]+)/.exec(url)?.[1];
      if (kind) requests.set(kind, (requests.get(kind) ?? 0) + 1);
    }
    measurements.push({ ...measurement, functions, categories: Object.fromEntries(categories), discardedNegativeDeltas: cpu.timeDeltas.filter(delta => delta < 0).length, requests: Object.fromEntries(requests) });
  }
  reports.push({ phase, measurements });
}
const fmt = (value: number | undefined) => value === undefined ? 'not sampled' : value.toFixed(2);
const get = (phase: string, rows: number, kind: string) => reports.find(report => report.phase === phase)!.measurements.find(measurement => measurement.rows === rows && measurement.kind === kind)!;
const lines = ['# Spike 3 · typing-path attribution and cutover', '', 'CDP Profiler (100 µs sampling) + devtools.timeline Tracing, minified production Solid fixture with source maps, real release service, two panes. Each typing profile contains 50 alternating x/y key presses mid-page and waits through the coalesced save; structural profiles contain 12 Enter splits plus their acknowledgements. Page sizes are nominal corpus sizes; the initial profiles followed the earlier structural proof and retained its added rows. Final latency cells use a regenerated pristine corpus.', '', 'CPU self time is sampled exclusive JavaScript time; total is inclusive at the largest sampled callsite and overlaps other totals. No samples is not a fabricated zero. V8 occasionally returned negative timestamp deltas at this sampling interval: those raw samples remain in .cpuprofile but are excluded from nonnegative attribution below. Browser style/layout/paint are timeline span totals, not CPU self measurements or presentation certification.', '', '## Typing attribution · self ms over 50 keys and save', '', '| Category | Before 2k | Before 10k | After 2k | After 10k |', '|---|---:|---:|---:|---:|'];
for (const category of ['Solid reactivity', 'Document / queue / lookup', 'Outbox / IndexedDB', 'Outline effects / rendering', 'Visibility / virtualizer', 'CodeMirror']) lines.push(`| ${category} | ${['before','after'].flatMap(phase => [2000,10000].map(rows => fmt(get(phase,rows,'typing').categories[category]))).join(' | ')} |`);
lines.push('', '## Named hot functions · self / inclusive total ms', '', '| Function | Before 2k | Before 10k | After 2k | After 10k |', '|---|---:|---:|---:|---:|');
const wanted: [string, string, string][] = [['Document.merge','page-document','merge'],['Document.refreshPending','page-document','refreshPending'],['Document.snapshot','page-document','snapshot'],['Document.put','page-document','put'],['Document.edit','page-document','edit'],['Notebook.enqueue','document/index','enqueue'],['Notebook.compile','document/index','compile'],['Notebook.publish','document/index','publish'],['Outbox.put','document/outbox','put'],['IDB request wrapper','/idb/','wrap'],['Solid.updatePath','solid-js/store','updatePath'],['CodeMirror.measure','codemirror/view','measure']];
for (const [title, source, name] of wanted) {
  const cells = ['before','after'].flatMap(phase => [2000,10000].map(rows => {
    const cost = get(phase,rows,'typing').functions.filter(cost => cost.source.includes(source) && (cost.name === name || name === 'wrap' && cost.name.includes(name))).sort((a,b) => b.totalMs-a.totalMs)[0];
    return cost ? `${fmt(cost.selfMs)} / ${fmt(cost.totalMs)}` : 'not sampled';
  }));
  lines.push(`| ${title} | ${cells.join(' | ')} |`);
}
lines.push('', '## Browser rendering · trace span ms', '', '| Span | Before 2k | Before 10k | After 2k | After 10k |', '|---|---:|---:|---:|---:|');
for (const name of ['UpdateLayoutTree','Layout','PrePaint','Paint']) lines.push(`| ${name} | ${['before','after'].flatMap(phase => [2000,10000].map(rows => fmt(get(phase,rows,'typing').trace.find(cost => cost.name===name)?.totalMs))).join(' | ')} |`);
lines.push('', '## Structural attribution · self / inclusive total ms over 12 Enter keys', '', '| Function | Before 2k | Before 10k | After 2k | After 10k |', '|---|---:|---:|---:|---:|');
for (const [title, source, name] of [['Document.merge','page-document','merge'],['Document.view','page-document','view'],['OutlineIndex.at','outline-index','at'],['OutlineIndex.slice','outline-index','slice'],['visibleIds','outline/visibility','visibleIds'],['TanStack.getMeasurements','virtual-core','getMeasurements'],['Outbox.acknowledge','document/outbox','acknowledge'],['IDB request wrapper','/idb/','wrap']] as const) {
  const cells = ['before','after'].flatMap(phase => [2000,10000].map(rows => {
    const cost = get(phase,rows,'structural').functions.filter(cost => cost.source.includes(source) && (cost.name === name || (name === 'getMeasurements' || name === 'wrap') && cost.name.includes(name))).sort((a,b) => b.totalMs-a.totalMs)[0];
    return cost ? `${fmt(cost.selfMs)} / ${fmt(cost.totalMs)}` : 'not sampled';
  }));
  lines.push(`| ${title} | ${cells.join(' | ')} |`);
}
lines.push('', '## Synchronization / save evidence', '');
for (const report of reports) for (const measurement of report.measurements) lines.push(`- ${report.phase} ${measurement.rows} ${measurement.kind}: observed API sends ${JSON.stringify(measurement.requests)}; excluded negative timestamp deltas ${measurement.discardedNegativeDeltas}.`);
lines.push('', 'Retained-library qualification: application typing does not rebuild page visibility or serialize/scan the page on save. At 10k, an occasional wrapped-row height update still sampled 0.53 ms of TanStack work over all 50 keys (0.26 ms in its measurement getter). TanStack was intentionally retained unchanged; this is not a claim of zero internal height-cache work. Related sections were collapsed and produced no related HTTP sends during these input windows.');
lines.push('', '## Changes', '', '- Coalesce each HTTP catch-up batch to final touched-block state; reconcile a structured page only when incoming revisions/removals are ahead of its current snapshot. This removes repeated historical whole-page reload/merge/IndexedDB churn after the editor becomes usable.', '- Key block-presence tracking by ID; track conflicts independently. Remote text and conflict changes no longer invalidate every block reader or archive-visibility dependency.', '- Cache full snapshots only on page load/create/whole-page restore. Acknowledgements atomically persist touched blocks and compact structural actions/revisions, removing the queued command in the same transaction. Offline load replays deltas with the existing treap. Fresh network snapshots prune only deltas known committed before the GET began, preserving in-flight edits.', '- Structure/fold/archive/zoom visibility rebuild is one linear treap slice instead of one logarithmic idAt per row. TanStack remains unchanged as directed. Structural projection may be O(n) within the measured frame budget; typing does not rebuild it.', '- Added consumer regression: acknowledged insert/split/move/delete/undo structure survives offline cold reload; a fresh snapshot after a remote deletion cannot resurrect an earlier local restore.', '', '## Latency before / after', '', '| Rows | Cell | Handler p99 before / after ms | Frame p95 before / after ms | Event p95 before / after ms |', '|---:|---|---:|---:|---:|');
const before = await Bun.file(join(directory,'before-results.json')).json();
const after = await Bun.file(join(directory,'results.json')).json();
for (const rows of [2000,10000]) {
  const old = before.measurements.find((m: {rows:number})=>m.rows===rows);
  const current = after.measurements.find((m: {rows:number})=>m.rows===rows);
  for (const cell of ['typing','Enter','Tab','Shift+Tab','Alt+ArrowUp']) {
    const a = cell==='typing'?old.typing:old.structural[cell];
    const b = cell==='typing'?current.typing:current.structural[cell];
    lines.push(`| ${rows} | ${cell} | ${fmt(a.handlerP99)} / ${fmt(b.handlerP99)} | ${fmt(a.frameP95)} / ${fmt(b.frameP95)} | ${fmt(a.eventP95)} / ${fmt(b.eventP95)} |`);
  }
}
lines.push('', 'Final correctness and row/anchor/error evidence: [summary.md](summary.md). Raw before/after profiles and traces are adjacent; normalized attribution is [attribution.json](attribution.json). `bun test src/document`: 21 pass (all 20 existing tests plus the cache regression). Typecheck passed. Headless frame/Event Timing remain proxies; no 60/120 Hz presentation certification is implied.', '');
await Bun.write(join(directory,'attribution.json'),JSON.stringify(reports,null,2));
await Bun.write(join(directory,'attribution.md'),lines.join('\n'));
console.log(join(directory,'attribution.md'));
