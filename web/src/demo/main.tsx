import '../shell/theme';
import '@fontsource-variable/ibm-plex-sans';
import '../ui/keys.css';
import '@fontsource-variable/piazzolla/standard.css';
import '@fontsource-variable/piazzolla/standard-italic.css';
import { render } from 'solid-js/web';
import { Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { bindNotebook, setStreamFactory, setTransport } from '../api/client';
import { App } from '../shell/App';
import { Button } from '../ui/Button';
import { DemoFailure, DemoTransport } from './transport';
import { setBrowserNotebook } from './notebook';
import { installInstalledWindow } from './installed';
import { persistOwnNotebook } from './offline';
import type { Notebook } from '../document';
import { NotebookHandoff } from './takeover';
import { installIosViewport } from '../ui/ios-viewport';
import '../styles.css';
import './demo.css';

installIosViewport();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');
let transport: DemoTransport;
let notebook: Notebook | undefined;
let ownsNotebook = false;
let operation = Promise.resolve();
function exclusive(work: () => Promise<void>): Promise<void> {
  const next = operation.then(work);
  operation = next.catch(() => {});
  return next;
}
installInstalledWindow();
window.addEventListener('pagehide', () => { handoff.dispose(); transport?.dispose(); }, { once: true });

function State(props: { message: string; failure?: boolean; back?: boolean; action?: string; onAction?(): void }) {
  return <div class="demo-shell"><main class="demo-state" role={props.failure ? 'alert' : 'status'}>
    <h1>Tessera</h1><p>{props.message}</p>
    {props.action && <Button class="bordered" onClick={props.onAction}>{props.action}</Button>}
    {props.failure && <Button class="bordered" onClick={() => window.location.reload()}>{props.back ? 'Back to the workshop' : 'Reload'}</Button>}
  </main></div>;
}
let dispose = render(() => <State message="Opening your local workshop…" />, root);
function replace(view: () => JSX.Element): void {
  notebook = undefined;
  dispose(); dispose = render(view, root!);
}
const handoff = new NotebookHandoff(new BroadcastChannel('tessera.browser.handoff'), {
  release: async () => {
    if (!ownsNotebook) return false;
    let released = false;
    await exclusive(async () => {
      if (!ownsNotebook) return;
      // Keep the editor mounted while blur submits field text and flush drains its outbox.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      document.body.inert = true;
      try {
        const blurred = Promise.withResolvers<void>();
        setTimeout(blurred.resolve, 0);
        await blurred.promise;
        if (notebook) {
          await notebook.flush();
          // Failed/conflicting edits stay with their owner, never in a terminated worker.
          if (notebook.saveState() !== 'saved') return;
        }
        await transport.close();
        ownsNotebook = false;
        replace(() => <State message="Tessera moved to another window." action="Use it here" onAction={useHere} />);
        released = true;
      } finally { document.body.inert = false; }
    });
    return released;
  },
  waiting: () => replace(() => <State message="Waiting for the other window to save…" />),
  released: () => { void exclusive(async () => { await openNotebook(1500); }); },
  // A closed owner never answers; its storage may already be free.
  timeout: () => { void exclusive(async () => { if (!await openNotebook(0, false)) showTimeout(); }); },
});
function showTimeout(): void {
  replace(() => <State message="The other window did not answer. Close it, then try again." action="Try again" onAction={() => { void exclusive(async () => { await openNotebook(); }); }} />);
}
/** Open the notebook if no window holds it, otherwise ask the window that does. */
function useHere(): void {
  void exclusive(async () => { if (!await openNotebook(300, false)) handoff.request(); });
}
/** False when another window still holds the notebook and `showLocked` is off. */
async function openNotebook(retryLockedMs = 0, showLocked = true): Promise<boolean> {
  handoff.cancel();
  replace(() => <State message="Opening your local workshop…" />);
  const deadline = Date.now() + retryLockedMs;
  for (;;) {
    transport = new DemoTransport(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
    setTransport(transport.fetch);
    setStreamFactory(transport.stream);
    try {
      const { info, fresh } = await transport.ready;
      bindNotebook('', info.id);
      ownsNotebook = true;
      replace(() => fresh ? <FirstRun /> : <DemoApp />);
      return true;
    } catch (reason) {
      transport.dispose();
      const locked = reason instanceof DemoFailure && reason.code === 'locked';
      if (locked && Date.now() < deadline) {
        const retry = Promise.withResolvers<void>();
        setTimeout(retry.resolve, 100);
        await retry.promise;
      } else if (locked && !showLocked) return false;
      else { showFailure(reason); return false; }
    }
  }
}
function showFailure(reason: unknown): void {
  const failure = reason instanceof DemoFailure ? reason : new DemoFailure('internal', reason instanceof Error ? reason.message : String(reason));
  if (failure.code === 'locked') {
    replace(() => <State message="Tessera is open in another window." action="Use it here" onAction={useHere} />);
    return;
  }
  const message = failure.code === 'unsupported' ? 'This browser lacks the private file storage Tessera needs (OPFS). Try a recent version of Chrome, Edge, Firefox or Safari.' : `The workshop could not open. ${failure.message}`;
  replace(() => <State message={message} failure />);
}
const notebookKey = 'tessera.browser.notebook';
function resetNotebook(): Promise<void> { return exclusive(async () => {
  // Dispose the editor before replacing its storage so it cannot submit old work.
  replace(() => <State message="Erasing…" />);
  try {
    await transport.reset();
    localStorage.removeItem(notebookKey);
    if (!handoff.requested) window.location.reload();
  } catch (reason) { showFailure(reason); }
}); }
function restoreNotebook(file?: File): Promise<void> { return exclusive(async () => {
  replace(() => <State message={file ? `Restoring ${file.name}…` : 'Restoring the copy from before the upgrade…'} />);
  try {
    if (file) await transport.restore(await file.arrayBuffer());
    else await transport.restoreUpgradeCopy();
    localStorage.setItem(notebookKey, 'own');
    if (!handoff.requested) window.location.reload();
  } catch (reason) {
    if (reason instanceof DemoFailure && reason.code === 'invalid') replace(() => <State message={reason.message} failure back />);
    else showFailure(reason);
  }
}); }
setBrowserNotebook({
  exportNotebook: () => transport.exportNotebook(),
  upgradeCopy: () => transport.upgradeCopy(),
  exportUpgradeCopy: () => transport.exportUpgradeCopy(),
  restore: restoreNotebook,
  restoreUpgradeCopy: () => restoreNotebook(),
  reset: resetNotebook,
});

function FirstRun() {
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  let picker!: HTMLInputElement;
  const start = async (kind: 'empty' | 'tour' | File) => {
    if (busy()) return;
    setError('');
    setBusy(typeof kind === 'string' ? kind === 'tour' ? 'Preparing the tour…' : 'Starting…' : `Restoring ${kind.name}…`);
    await exclusive(async () => { try {
      if (typeof kind === 'string') await transport.start(kind);
      else await transport.restore(await kind.arrayBuffer());
      localStorage.setItem(notebookKey, kind === 'tour' ? 'tour' : 'own');
      replace(() => <DemoApp />);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy('');
    } });
  };
  return <Show when={busy()} fallback={<div class="demo-shell"><main class="demo-state">
    <h1>Start a workshop</h1>
    <p>This workshop lives in this browser's private storage, on this device only. Download backups from Settings › Backups.</p>
    <div class="demo-choices">
      <div><Button class="bordered" onClick={() => { void start('empty'); }}>Start empty</Button><p>A blank workshop.</p></div>
      <div><Button class="bordered" onClick={() => { void start('tour'); }}>Take the tour</Button><p>Sample atoms, cards and Marcus Aurelius' Meditations to try things on.</p></div>
      <div><Button class="bordered" onClick={() => picker.click()}>Restore a backup…</Button><p>A workshop file downloaded from Tessera in a browser.</p></div>
    </div>
    <input ref={picker} type="file" hidden onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      if (file) void start(file);
    }} />
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
  </main></div>}>{message => <State message={message()} />}</Show>;
}
function DemoApp() {
  persistOwnNotebook();
  const [confirmReset, setConfirmReset] = createSignal(false);
  return <div class="demo-shell">
    <Show when={localStorage.getItem(notebookKey) !== 'own'}>
      <aside class="demo-notice" aria-label="Tour workshop">
        <span>This is the tour workshop. It lives only in this browser. <a href="https://github.com/solforged/tessera">Source</a> <a href="https://github.com/solforged/tessera/releases/latest">Download</a></span>
        <span class="settings-backup-actions"><Show when={confirmReset()} fallback={<Button class="bordered" onClick={() => setConfirmReset(true)}>Start over…</Button>}>
          <span>Erase this workshop? Download a backup first to keep it.</span>
          <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
          <Button class="bordered danger" onClick={() => { void resetNotebook(); }}>Confirm</Button>
        </Show></span>
      </aside>
    </Show>
    <App onNotebook={value => { notebook = value; }} />
  </div>;
}
// Mount the editor once, outside a reactive condition that its resources could invalidate.
void exclusive(async () => { await openNotebook(); });
// The native entry's embedded-app offline cache is intentionally not registered here.
