import { For, Show, createResource, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { api } from '../api/client';
import type { PairingCode, PairingStatus } from '../api/types';
import { ANDROID } from '../demo/mode';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { SyncSetup } from '../sync/SyncSetup';
import { ago, plural, replica, size, sync } from '../sync/state';

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/** Settings › Devices on the Mac: tailnet sharing, pairing and the devices that copy this notebook. */
export function HubDevices(props: { heading: JSX.Element; onError(message: string): void; onCount(count: number): void }) {
  const [devices, { refetch, mutate }] = createResource(async () => {
    try { const value = await api.syncDevices(); props.onCount(value.devices.length); return value; }
    catch (reason) { props.onError(message(reason)); return undefined; }
  });
  const [busy, setBusy] = createSignal(false);
  const [pairing, setPairing] = createSignal(false);
  const share = async (on: boolean) => {
    setBusy(true);
    try { const sharing = await api.setSharing(on); mutate(value => value && { ...value, sharing }); }
    catch (reason) { props.onError(message(reason)); }
    finally { setBusy(false); void refetch(); }
  };
  const forget = async (id: string) => {
    try { await api.forgetDevice(id); }
    catch (reason) { props.onError(message(reason)); }
    void refetch();
  };
  return <>
    {props.heading}
    <Show when={devices()}>{value => <>
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-name"><label for="settings-sharing">Sharing</label><span class="settings-scope">This Mac</span></span>
          <p>{value().sharing.available ? 'Share with my tailnet' : value().sharing.error ?? 'Tailscale is not available on this Mac.'}</p>
          <Show when={value().sharing.on && value().sharing.url}>{url => <p class="settings-mono devices-url">{url()}</p>}</Show>
        </div>
        <input id="settings-sharing" class="settings-switch" type="checkbox" role="switch" checked={value().sharing.on} disabled={busy() || !value().sharing.available} onChange={event => { void share(event.currentTarget.checked); }} />
      </div>
      <div class="settings-row">
        <div class="settings-label"><span class="settings-name">Pair a phone</span><p>The phone gets a copy of this notebook. Changes go both ways.</p></div>
        <Button class="bordered" disabled={!value().sharing.on} title={value().sharing.on ? undefined : 'Turn on sharing first'} onClick={() => setPairing(true)}>Pair a phone</Button>
      </div>
      <For each={value().devices}>{device => <div class="settings-row devices-device" data-state={device.state}>
        <div class="settings-label"><span class="settings-name">{device.name}</span><p>{
          device.state === 'retired' && device.retired_at ? `Retired ${ago(device.retired_at)}`
            : device.last_seen_at ? `Last synced ${ago(device.last_seen_at)}` : 'Not synced yet'
        }</p></div>
        <span class="devices-device-end">
          <Show when={device.state === 'active'}><span class="settings-aside devices-active">Active</span></Show>
          <Button class="bordered devices-forget" onClick={() => { void forget(device.id); }}>Forget</Button>
        </span>
      </div>}</For>
      <Show when={value().retained.changes > 0}>
        <p class="settings-mono devices-retained">Keeping {plural(value().retained.changes, 'change')} for devices that have not caught up ({size(value().retained.bytes)}).</p>
      </Show>
      <Show when={pairing()}><PairDialog url={value().sharing.url} onDone={() => { setPairing(false); void refetch(); }} /></Show>
    </>}</Show>
  </>;
}

/** The QR code and short code a phone pairs with. It closes itself once the phone has paired. */
function PairDialog(props: { url: string | null; onDone(): void }) {
  const [code, setCode] = createSignal<PairingCode | null>(null);
  const [status, setStatus] = createSignal<PairingStatus['state']>('none');
  const [paired, setPaired] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const [now, setNow] = createSignal(Date.now());
  const start = async () => {
    setError(''); setPaired(null);
    try { setCode(await api.startPairing()); setStatus('waiting'); }
    catch (reason) { setError(message(reason)); }
  };
  void start();
  const timer = window.setInterval(async () => {
    setNow(Date.now());
    if (status() !== 'waiting') return;
    try {
      const value = await api.pairingStatus();
      setStatus(value.state);
      if (value.state === 'paired') setPaired(value.device?.name ?? 'The phone');
    } catch { /* The next tick asks again. */ }
  }, 1000);
  onCleanup(() => window.clearInterval(timer));
  const close = () => { if (status() === 'waiting') void api.cancelPairing().catch(() => undefined); props.onDone(); };
  const left = () => {
    const seconds = Math.max(0, Math.ceil(((code()?.expires_at ?? 0) - now()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  return <Popup anchor={document.body} placement="top" width={600} label="Pair a phone" class="pair-dialog" onDismiss={close}>
    {/* One wrapper from the start, so the popup sees the content grow once the code arrives. */}
    <div class="pair">
    <header class="pair-head">
      <div><p class="pair-register">This Mac → your phone</p><h2>Pair a phone</h2></div>
      <Button icon="close" label="Close" onClick={close} />
    </header>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={paired()} fallback={<Show when={code()}>{value => <div class="pair-body">
      <figure class="pair-code">
        {/* The hub draws the QR as SVG; it carries no script. */}
        <div class="pair-qr" innerHTML={value().qr_svg} role="img" aria-label="Pairing QR code" />
        <figcaption><span class="pair-display">{value().display}</span><span>Or type this code on the phone.</span></figcaption>
      </figure>
      <ol class="pair-steps">
        <li><span class="section-number">01</span>Open Tessera on the phone.</li>
        <li><span class="section-number">02</span><span>Choose <strong>Use my Mac's notebook</strong>.</span></li>
        <li><span class="section-number">03</span>Scan this code.</li>
      </ol>
    </div>}</Show>}>
      <p class="pair-paired" role="status">{paired()} is paired and copying the notebook.</p>
    </Show>
    <footer class="pair-foot">
      <div class="pair-wait" role="status">
        <Show when={!paired()}>
          <Show when={status() === 'expired' || (code() && left() === '0:00')} fallback={<p><span class="pair-dot" aria-hidden="true" />Waiting for the phone. The code expires in {left()}.</p>}>
            <p>The code expired.</p>
          </Show>
        </Show>
        <Show when={props.url}>{url => <p class="settings-mono">{url()}</p>}</Show>
      </div>
      <Show when={paired()} fallback={<Show when={status() === 'expired' || left() === '0:00'} fallback={<Button class="bordered" onClick={close}>Cancel</Button>}>
        <Button class="bordered" onClick={() => { void start(); }}>New code</Button>
      </Show>}>
        <Button class="bordered" onClick={props.onDone}>Done</Button>
      </Show>
    </footer>
    </div>
  </Popup>;
}

/** Settings › Devices on the phone: the Mac it copies, or the way to start copying it. */
export function PhoneDevices(props: { heading: JSX.Element; onError(message: string): void }) {
  const [setup, setSetup] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const run = async () => {
    setRunning(true);
    try { sync.set(await api.runSync()); }
    catch (reason) { props.onError(message(reason)); }
    finally { setRunning(false); }
  };
  void sync.refresh();
  return <>
    {props.heading}
    <Show when={sync.state()}>{state => <Show when={replica()} fallback={<>
      <div class="settings-row">
        <div class="settings-label"><span class="settings-name">Use my Mac's notebook</span><p>A copy of your Mac's notebook. This phone sends its changes to the Mac and gets the Mac's changes.</p></div>
        <Button class="bordered" disabled={state().role !== 'none'} onClick={() => setSetup(true)}>Set up</Button>
      </div>
      <Show when={setup()}><SyncSetup onDone={() => setSetup(false)} /></Show>
    </>}>{value => <>
      <div class="settings-row">
        <div class="settings-label"><span class="settings-name">{value().hub_name ?? 'Mac'}<span class="settings-scope">Notebook</span></span><p class="settings-mono devices-url">{value().hub_url}</p></div>
        <span class="settings-aside">{ANDROID ? 'This phone copies it' : 'This device copies it'}</span>
      </div>
      <div class="settings-row">
        <div class="settings-label"><span class="settings-name">Sync</span><p>{
          value().syncing || running() ? 'Syncing…'
            : [value().synced_at ? `Synced ${ago(value().synced_at!)}` : 'Not synced yet', value().pending ? `${plural(value().pending, 'change')} waiting` : null].filter(Boolean).join(' · ')
        }</p><Show when={value().last_error}>{failure => <p class="devices-error">{failure().message}</p>}</Show></div>
        <Button class="bordered" disabled={running() || value().syncing || value().retired} onClick={() => { void run(); }}>Sync now</Button>
      </div>
      <Show when={value().offline.books > 0}>
        <div class="settings-row">
          <div class="settings-label"><span class="settings-name">Offline books</span><p>{plural(value().offline.books, 'book')} · {size(value().offline.bytes)}</p></div>
          <span class="settings-aside">On this phone</span>
        </div>
      </Show>
    </>}</Show>}</Show>
  </>;
}
