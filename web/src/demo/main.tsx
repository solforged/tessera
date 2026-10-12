import '../shell/theme';
import '@fontsource-variable/ibm-plex-sans';
import '../ui/keys.css';
import '@fontsource-variable/piazzolla/standard.css';
import '@fontsource-variable/piazzolla/standard-italic.css';
import { render } from 'solid-js/web';
import { Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { setStreamFactory, setTransport } from '../api/client';
import { App } from '../shell/App';
import { Button } from '../ui/Button';
import { DemoFailure, DemoTransport } from './transport';
import { setBrowserNotebook } from './notebook';
import '../styles.css';
import './demo.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');
const transport = new DemoTransport(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
setTransport(transport.fetch);
setStreamFactory(transport.stream);
window.addEventListener('pagehide', () => transport.dispose(), { once: true });

function State(props: { message: string; failure?: boolean; back?: boolean }) {
  return <div class="demo-shell"><main class="demo-state" role={props.failure ? 'alert' : 'status'}>
    <h1>Tessera</h1><p>{props.message}</p>
    {props.failure && <Button class="bordered" onClick={() => window.location.reload()}>{props.back ? 'Back to the notebook' : 'Reload'}</Button>}
  </main></div>;
}
let dispose = render(() => <State message="Opening your local notebook…" />, root);
function replace(view: () => JSX.Element): void {
  dispose(); dispose = render(view, root!);
}
function showFailure(reason: unknown): void {
  const failure = reason instanceof DemoFailure ? reason : new DemoFailure('internal', reason instanceof Error ? reason.message : String(reason));
  const message = failure.code === 'locked' ? 'Tessera is open in another tab. Close it, then reload.' : failure.code === 'unsupported' ? 'This browser lacks the private file storage Tessera needs (OPFS). Try a recent version of Chrome, Edge, Firefox or Safari.' : `The notebook could not open. ${failure.message}`;
  replace(() => <State message={message} failure />);
}
const notebookKey = 'tessera.browser.notebook';
async function resetNotebook(): Promise<void> {
  // Dispose the editor before replacing its storage so it cannot submit old work.
  replace(() => <State message="Erasing…" />);
  try {
    await transport.reset();
    localStorage.removeItem(notebookKey);
    window.location.reload();
  } catch (reason) { showFailure(reason); }
}
async function restoreNotebook(file?: File): Promise<void> {
  replace(() => <State message={file ? `Restoring ${file.name}…` : 'Restoring the copy from before the upgrade…'} />);
  try {
    if (file) await transport.restore(await file.arrayBuffer());
    else await transport.restoreUpgradeCopy();
    localStorage.setItem(notebookKey, 'own');
    window.location.reload();
  } catch (reason) {
    if (reason instanceof DemoFailure && reason.code === 'invalid') replace(() => <State message={reason.message} failure back />);
    else showFailure(reason);
  }
}
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
    try {
      if (typeof kind === 'string') await transport.start(kind);
      else await transport.restore(await kind.arrayBuffer());
      localStorage.setItem(notebookKey, kind === 'tour' ? 'tour' : 'own');
      replace(() => <DemoApp />);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy('');
    }
  };
  return <Show when={busy()} fallback={<div class="demo-shell"><main class="demo-state">
    <h1>Start a notebook</h1>
    <p>This notebook lives in this browser's private storage, on this device only. Download backups from Settings › Backups.</p>
    <div class="demo-choices">
      <div><Button class="bordered" onClick={() => { void start('empty'); }}>Start empty</Button><p>A blank notebook.</p></div>
      <div><Button class="bordered" onClick={() => { void start('tour'); }}>Take the tour</Button><p>Sample pages, cards and Marcus Aurelius' Meditations to try things on.</p></div>
      <div><Button class="bordered" onClick={() => picker.click()}>Restore a backup…</Button><p>A notebook file downloaded from Tessera in a browser.</p></div>
    </div>
    <input ref={picker} type="file" hidden onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      if (file) void start(file);
    }} />
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
  </main></div>}>{message => <State message={message()} />}</Show>;
}
function DemoApp() {
  const [confirmReset, setConfirmReset] = createSignal(false);
  return <div class="demo-shell">
    <Show when={localStorage.getItem(notebookKey) !== 'own'}>
      <aside class="demo-notice" aria-label="Tour notebook">
        <span>This is the tour notebook. It lives only in this browser. <a href="https://github.com/solforged/tessera">Source</a> <a href="https://github.com/solforged/tessera/releases/latest">Download</a></span>
        <span class="settings-backup-actions"><Show when={confirmReset()} fallback={<Button class="bordered" onClick={() => setConfirmReset(true)}>Start over…</Button>}>
          <span>Erase this notebook? Download a backup first to keep it.</span>
          <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
          <Button class="bordered danger" onClick={() => { void resetNotebook(); }}>Confirm</Button>
        </Show></span>
      </aside>
    </Show>
    <App />
  </div>;
}
// Mount the editor once, outside a reactive condition that its resources could invalidate.
void transport.ready.then(({ fresh }) => replace(() => fresh ? <FirstRun /> : <DemoApp />)).catch(showFailure);
// The native entry's embedded-app offline cache is intentionally not registered here.
