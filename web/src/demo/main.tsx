import '../shell/theme';
import '@fontsource-variable/ibm-plex-sans';
import '../ui/keys.css';
import '@fontsource-variable/piazzolla/standard.css';
import '@fontsource-variable/piazzolla/standard-italic.css';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';
import { setStreamFactory, setTransport } from '../api/client';
import { App } from '../shell/App';
import { Button } from '../ui/Button';
import { DemoFailure, DemoTransport } from './transport';
import '../styles.css';
import './demo.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');
const transport = new DemoTransport(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
setTransport(transport.fetch);
setStreamFactory(transport.stream);
window.addEventListener('pagehide', () => transport.dispose(), { once: true });

function State(props: { message: string; failure?: boolean }) {
  return <div class="demo-shell"><main class="demo-state" role={props.failure ? 'alert' : 'status'}>
    <h1>Tessera browser demo</h1><p>{props.message}</p>
    {props.failure && <Button class="bordered" onClick={() => window.location.reload()}>Reload</Button>}
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
async function resetDemo(): Promise<void> {
  if (!window.confirm('Reset this demo? Your changes in this browser will be removed and the tour will be restored.')) return;
  // Dispose the editor before resetting so it cannot submit old work into the new notebook.
  replace(() => <State message="Restoring the tour…" />);
  try { await transport.reset(); window.location.reload(); }
  catch (reason) { showFailure(reason); }
}
function DemoApp() {
  return <div class="demo-shell">
    <aside class="demo-notice" aria-label="Browser demo">
      <span>This is a demo. Your data lives only in this browser.</span>
      <Button class="bordered" onClick={() => { void resetDemo(); }}>Reset demo</Button>
    </aside>
    <App />
  </div>;
}
// Mount the editor once, outside a reactive condition that its resources could invalidate.
void transport.ready.then(() => replace(() => <DemoApp />)).catch(showFailure);
// The native entry's embedded-app offline cache is intentionally not registered here.
