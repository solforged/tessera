import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { createNotebookClient } from '../src/document';
import type { PageDocument } from '../src/document/contract';
import type { Command, CommandRegistry, OpenTarget, ViewState } from '../src/shell/contract';
import { OutlinePane } from '../src/outline/OutlinePane';
import '../src/styles.css';
import '@fontsource-variable/ibm-plex-sans';

interface RowSnapshot { id: string; text: string; parent: string; depth: number }
export interface PerfControls {
  ready(): boolean;
  snapshot(): RowSnapshot[];
  caret(): ViewState['caret'];
  view(): ViewState;
  restore(view: ViewState): void;
  command(id: string): void;
  vim(enabled: boolean): void;
  mode(): string | null;
  openTargets(): { target: OpenTarget; beside: boolean }[];
  document(): PageDocument;
}
declare global { interface Window { outlinePerf: PerfControls } }

const query = new URLSearchParams(location.search);
const initialId = query.get('page');
if (!initialId) throw new Error('The performance fixture requires ?page=LIVE_PAGE_ID from a real tessera service.');
const client = createNotebookClient();
const doc = client.open(initialId);
const registrations = new Map<string, Command>();
const registry: CommandRegistry = {
  register(commands) { for (const command of commands) registrations.set(command.id, command); return () => { for (const command of commands) registrations.delete(command.id); }; },
  list: () => [...registrations.values()],
};
const fresh: ViewState = { zoom: null, caret: null, scroll: null, folds: null, showArchived: query.get('archived') === '1' };
const [page, setPage] = createSignal(initialId);
const [side, setSide] = createSignal<string | null>(query.get('two') ? initialId : null);
const [vim, setVim] = createSignal(query.get('vim') === '1');
const [mode, setMode] = createSignal<string | null>(null);
const [view, setView] = createSignal(fresh);
const [initialView, setInitialView] = createSignal(fresh);
const [epoch, setEpoch] = createSignal(0);
const [active, setActive] = createSignal<'main' | 'side'>('main');
const [targets, setTargets] = createSignal<{ target: OpenTarget; beside: boolean }[]>([]);
const [sideView, setSideView] = createSignal(fresh);
function open(target: OpenTarget, beside: boolean) {
  setTargets(previous => [...previous, { target, beside }]);
  if (target.kind !== 'page') return;
  const next = { ...fresh, zoom: target.blockId ?? null, caret: target.blockId ? { id: target.blockId, offset: 0 } : null };
  if (beside) { setSideView(next); setSide(target.pageId); setActive('side'); }
  else { setInitialView(next); setView(next); setPage(target.pageId); setEpoch(value => value + 1); }
}
window.outlinePerf = {
  ready: () => doc.status() === 'ready',
  snapshot: () => Array.from({ length: doc.outline.size() }, (_, index) => { const id = doc.outline.idAt(index); return { id, text: doc.block(id)?.text ?? '', parent: doc.outline.parentOf(id), depth: doc.outline.depth(id) }; }),
  caret: () => view().caret,
  view,
  restore(saved) { setInitialView(saved); setView(saved); setEpoch(value => value + 1); },
  command(id) { const command = registrations.get(`outline.main.${id}`); if (!command) throw new Error(`Missing command: ${id}`); command.run(); },
  vim: setVim,
  mode,
  openTargets: targets,
  document: () => doc,
};
// Keep the fixture and its real shared document alive until the browser closes.
window.addEventListener('beforeunload', () => doc.release());
render(() => <div class="perf-root">
  <header><strong>Spike 3 · real notebook</strong><span data-vim-mode>{mode() ? `Vim: ${mode()}` : 'Vim off'}</span><button type="button" onClick={() => setVim(value => !value)}>Toggle Vim</button><button type="button" onClick={() => window.outlinePerf.command('show-archived')}>Show archived</button></header>
  <div class="perf-panes">
    <Show keyed when={epoch() + 1}>{generation => <OutlinePane pane="main" pageId={page()} view={initialView()} onViewChange={setView} onOpen={open} active={active() === 'main'} onActivate={() => setActive('main')} vim={vim()} onVimMode={setMode} commands={registry} notebook={client} />}</Show>
    <Show when={side()}>{id => <OutlinePane pane="side" pageId={id()} view={sideView()} onViewChange={setSideView} onOpen={open} active={active() === 'side'} onActivate={() => setActive('side')} vim={vim()} onVimMode={() => {}} commands={registry} notebook={client} />}</Show>
  </div>
</div>, document.getElementById('root')!);
const style = document.createElement('style');
style.textContent = 'html,body,#root,.perf-root{height:100%;margin:0}.perf-root{display:flex;flex-direction:column}.perf-root>header{display:flex;gap:16px;padding:8px 24px;height:42px;box-sizing:border-box}.perf-panes{display:flex;flex:1;min-height:0}.perf-panes>.outline-pane{width:50%;box-sizing:border-box}';
document.head.append(style);
