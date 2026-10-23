import { ulid } from 'ulid';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { Committed } from '../src/api/types';
import { api, Service, sleep } from './lib/service';
import { seed } from './lib/seed';
import { budget, converged, drained, duration, instrument, launch, open, percentile, ready, tracker, typeMarker, verify } from './lib/metrics';
import type { Outcome, Runtime, RevisionCheck, Tracker } from './lib/metrics';
import { milliseconds, report, table } from './lib/report';

interface WindowRun { context: BrowserContext; page: Page; pageId: string; blockId: string; structuralId: string; offline: boolean; index: number }
interface RuntimeResult { runtime: Runtime; status: string; commitP95: number | null; propagationP95: number | null; reconnectP95: number | null; lost: number | null; pollsWhileLive: number; propagation: number[]; reconnect: number[]; markers: string[]; tracking: Tracker; revisionCheck?: RevisionCheck }

const timing = duration(3);
const selected = process.env.BROWSER as Runtime | undefined;
if (selected && selected !== 'chromium' && selected !== 'webkit') throw new Error('BROWSER must be chromium or webkit.');
const runtimes: Runtime[] = selected ? [selected] : ['chromium', 'webkit'];
Service.preflight();
const corpus = await seed();
const outcomes: Outcome[] = [];
const results: RuntimeResult[] = [];
try {
  for (const runtime of runtimes) {
    const tracking = tracker();
    const result: RuntimeResult = { runtime, status: 'not run', commitP95: null, propagationP95: null, reconnectP95: null, lost: null, pollsWhileLive: 0, propagation: [], reconnect: [], markers: [], tracking };
    results.push(result);
    let browser: Browser | undefined;
    let service: Service | undefined;
    let stop = false;
    let pause = false;
    let active = 0;
    let probing = false;
    const tasks: Promise<void>[] = [];
    const windows: WindowRun[] = [];
    try {
      try { browser = await launch(runtime); }
      catch (error) {
        result.status = `not run: ${String(error).split('\n')[0]}`;
        outcomes.push({ scenario: `${runtime} available`, pass: false, evidence: `${result.status}${runtime === 'webkit' ? '; install with bunx playwright-core install webkit (from web/)' : '; set CHROME_PATH'}` });
        continue;
      }
      service = await Service.start(corpus.copy(runtime));
      const base = service.base;
      for (let index = 0; index < 4; index++) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await instrument(context, `window-${index}`, tracking);
        const page = await context.newPage();
        const seeded = corpus.pages[index < 2 ? 0 : index - 1]!;
        await ready(page, base);
        await open(page, seeded.id, seeded.blocks[index]!);
        windows.push({ context, page, pageId: seeded.id, blockId: seeded.blocks[index]!, structuralId: seeded.blocks[index + 5]!, offline: false, index });
      }
      for (const win of windows) await drained(win.page);
      tracking.startedAt = Date.now();
      const deadline = Date.now() + timing.milliseconds;
      let token = 0;
      const guarded = async (run: () => Promise<void>) => {
        try { await run(); }
        catch (error) { tracking.errors.push(String(error)); stop = true; }
      };
      for (const win of windows) tasks.push(guarded(async () => {
        let structural = Date.now() + 3000;
        let step = 0;
        while (!stop && Date.now() < deadline) {
          if (pause) { await sleep(25); continue; }
          active++;
          try {
            const marker = `spike_${runtime}_w${win.index}_${++token}_end`;
            await typeMarker(win.page, win.blockId, marker);
            result.markers.push(marker);
            if (Date.now() >= structural) {
              const marker = `spike_${runtime}_structure_${win.index}_${step}_end`;
              await typeMarker(win.page, win.structuralId, marker);
              result.markers.push(marker);
              const keys = ['Enter', 'Tab', 'Shift+Tab', 'Alt+ArrowUp'];
              await win.page.keyboard.press(keys[step++ % keys.length]!);
              structural = Date.now() + 3000;
            }
          } finally { active--; }
          await sleep(300);
        }
      }));
      tasks.push(guarded(async () => {
        let index = 0;
        while (!stop && Date.now() < deadline) {
          if (pause) { await sleep(25); continue; }
          active++;
          try {
            const marker = `spike_${runtime}_agent_${++index}_end`;
            const agent = await api<{ committed: Committed }>(base, '/api/agent-changes', { actor: { kind: 'agent', name: 'runtime spike' }, reason: 'Concurrent agent note', kind: 'add_note', target: { kind: 'page', title: corpus.pages[0]!.title }, blocks: [{ text: marker }] });
            tracking.receipts.push({ window: 'agent', at: Date.now(), elapsed: 0, committed: agent.committed });
            result.markers.push(marker);
            const batchMarker = `spike_${runtime}_batch_${index}_end`;
            const committed = await api<Committed>(base, '/api/batches', { actor: { kind: 'client', name: 'runtime background writer' }, operations: [{ op: 'insert', id: ulid(), parent_id: corpus.pages[1]!.id, after: null, text: batchMarker, heading: null }] });
            tracking.receipts.push({ window: 'background', at: Date.now(), elapsed: 0, committed });
            result.markers.push(batchMarker);
          } finally { active--; }
          await sleep(500);
        }
      }));
      // Keep the probe near both writers, so virtualization does not hide the receiving row.
      tasks.push(guarded(async () => {
        let revision = 1;
        let text = 'Seed 0:4 quiet notebook text';
        while (!stop && Date.now() < deadline) {
          if (pause || windows[0]!.offline || windows[1]!.offline) { await sleep(25); continue; }
          active++;
          probing = true;
          try {
            const marker = `spike_${runtime}_prop_${++token}_end`;
            text += ` ${marker}`;
            const start = performance.now();
            const committed = await windows[0]!.page.evaluate(async ({ id, revision, text }) => {
              const response = await fetch('/api/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: { kind: 'client', name: 'propagation probe' }, operations: [{ op: 'edit_text', id, base_revision: revision, text }] }) });
              if (!response.ok) throw new Error(await response.text());
              return await response.json() as Committed;
            }, { id: corpus.pages[0]!.blocks[4]!, revision, text });
            revision = committed.revisions.find(value => value.id === corpus.pages[0]!.blocks[4])!.revision;
            result.markers.push(marker);
            await windows[1]!.page.waitForFunction(marker => [...document.querySelectorAll('.pane.active .outline-body')].some(element => element.textContent?.includes(marker)), marker, { polling: 10, timeout: 15_000 });
            result.propagation.push(performance.now() - start);
            if (!committed.seq) throw new Error('Propagation write did not return a receipt.');
          } finally { active--; probing = false; }
          await sleep(1000);
        }
      }));
      tasks.push(guarded(async () => {
        let next = Date.now() + 30_000;
        let cycle = 0;
        while (!stop && Date.now() < deadline) {
          if (Date.now() < next) { await sleep(100); continue; }
          const win = windows[cycle++ % windows.length]!;
          win.offline = true;
          while (probing) await sleep(10);
          await win.page.evaluate(() => { window.__spike.recovering = true; });
          await win.context.setOffline(true);
          await sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
          pause = true;
          while (active) await sleep(10);
          const start = performance.now();
          await win.context.setOffline(false);
          // Stop all writers only during equality checks, so every server row has a stable expected value.
          for (const other of windows) await drained(other.page);
          await converged(win.page, base, win.pageId);
          result.reconnect.push(performance.now() - start);
          await win.page.evaluate(() => { window.__spike.recovering = false; });
          win.offline = false;
          pause = false;
          next = Date.now() + 30_000;
        }
      }));
      await Promise.all(tasks);
      stop = true;
      await Promise.all(windows.map(async win => {
        if (win.offline) await win.context.setOffline(false);
        try { await drained(win.page); } catch (error) { tracking.errors.push(String(error)); }
      }));
      result.revisionCheck = await verify(base, tracking.receipts, result.markers);
      result.lost = result.revisionCheck.lost;
      result.commitP95 = percentile(tracking.receipts.filter(receipt => receipt.window.startsWith('window-') && receipt.at >= tracking.startedAt!).map(receipt => receipt.elapsed), .95);
      result.propagationP95 = percentile(result.propagation, .95);
      result.reconnectP95 = percentile(result.reconnect, .95);
      result.pollsWhileLive = tracking.pollsWhileLive;
      result.status = 'ran';
      outcomes.push(
        budget(`${runtime} commit p95`, result.commitP95, 50),
        budget(`${runtime} propagation p95`, result.propagationP95, 100),
        { scenario: `${runtime} reconnect convergence`, pass: result.reconnect.length > 0, evidence: `${result.reconnect.length} complete-page equality checks and zero-command drains; p95 ${milliseconds(result.reconnectP95)}` },
        { scenario: `${runtime} lost edits`, pass: result.lost === 0, evidence: `${result.lost} missing; ${result.revisionCheck.checkedReceipts} acknowledged receipts, ${result.markers.length} markers` },
        { scenario: `${runtime} live polling`, pass: tracking.pollsWhileLive === 0, evidence: `${tracking.pollsWhileLive} live /api/changes requests; ${tracking.catchUpRequests} startup/reconnect catch-up requests` },
        { scenario: `${runtime} workload`, pass: tracking.errors.length === 0, evidence: tracking.errors.join('; ') || 'No workload or receipt-capture errors.' },
      );
    } catch (error) {
      stop = true;
      pause = false;
      result.status = `failed: ${String(error)}`;
      outcomes.push({ scenario: `${runtime} harness`, pass: false, evidence: result.status });
    } finally {
      stop = true;
      pause = false;
      for (const win of windows) if (win.offline) await win.context.setOffline(false).catch(() => undefined);
      await Promise.allSettled(tasks);
      await browser?.close();
      await service?.kill();
    }
  }
} finally { corpus.dispose(); }
const notRun = (['chromium', 'webkit'] as const).filter(runtime => !runtimes.includes(runtime));
const summary = table(['Runtime', 'Commit p95', 'Propagation p95', 'Reconnect p95', 'Lost edits', 'Polls while live', 'Status'], [
  ...results.map(result => [result.runtime, milliseconds(result.commitP95), milliseconds(result.propagationP95), milliseconds(result.reconnectP95), result.lost, result.pollsWhileLive, result.status]),
  ...notRun.map(runtime => [runtime, null, null, null, null, null, 'not run: excluded by BROWSER']),
]);
await report('concurrency', summary, { durationMs: timing.milliseconds, corpus: { pages: 60, blocksPerPage: 150 }, runtimeKind: 'Playwright over HTTP, not Tauri', notRun, results }, outcomes);
