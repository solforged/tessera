import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { api } from '../api/client';
import type { PairingCode, PairingStatus, RejectedChange, SyncAttempt } from '../api/types';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { SyncSetup } from '../sync/SyncSetup';
import type { NotebookClient } from '../document/contract';
import { SyncExplanation, SyncFix, currentHealth } from '../sync/SyncStatus';
import { syncHealth, versionLine } from '../sync/health';
import { settleRejection } from '../sync/rejections';
import { ago, hubDevices, plural, replica, size, sync, syncConflicts } from '../sync/state';

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

interface DeviceProps { heading: JSX.Element; notebook: NotebookClient; deviceId?: string | null; when(value: number): string; onOpenPage(pageId: string): void; onError(message: string): void }

/** The Mac's device rows contain the fix and evidence for each relationship. */
export function HubDevices(props: DeviceProps & { onCount(count: number): void }) {
  const [busy, setBusy] = createSignal(false);
  const [pairing, setPairing] = createSignal(false);
  const [pairNeedsSharing, setPairNeedsSharing] = createSignal(false);
  const [forgetting, setForgetting] = createSignal<string | null>(null);
  // Settled once the Mac has answered for its hub records; until then neither the rows nor "Sync is off" show.
  const [checked, setChecked] = createSignal(false);
  void sync.refresh().then(() => hubDevices.refresh()).finally(() => setChecked(true));
  createEffect(() => props.onCount(hubDevices.state()?.devices.length ?? 0));
  const share = async (on: boolean) => {
    setBusy(true);
    setPairNeedsSharing(false);
    try {
      const sharing = await api.setSharing(on);
      const value = hubDevices.state();
      if (value) hubDevices.set({ ...value, sharing });
      return sharing.on;
    } catch (reason) { props.onError(message(reason)); return false; }
    finally { setBusy(false); void hubDevices.refresh(); }
  };
  const pair = async () => {
    if (busy()) return;
    const sharing = hubDevices.state()?.sharing;
    if (!sharing?.on && (!sharing?.available || !await share(true))) { setPairNeedsSharing(true); return; }
    setPairNeedsSharing(false); setPairing(true);
  };
  const forget = async (id: string) => {
    try { await api.forgetDevice(id); setForgetting(null); }
    catch (reason) { props.onError(message(reason)); }
    void hubDevices.refresh();
  };
  return <>
    {props.heading}
    <Show when={checked() && !hubDevices.state()}>
      <p class="settings-empty">Sync is off. This Mac is not serving its workshop to other devices, so no phone can pair with it.</p>
    </Show>
    <Show when={hubDevices.state()}>{value => <>
      <p class="settings-mono devices-hub">{value().hub_name} · {versionLine(value().this_device)}<Show when={value().sharing.url}>{url => <><br /><span class="devices-url">{url()}</span></>}</Show></p>
      <div class="settings-row">
        <div class="settings-label"><span class="settings-name"><label for="settings-sharing">Sharing</label><span class="settings-scope">This Mac</span></span>
          <p>{value().sharing.available ? 'Phones on your tailnet get a copy of this workshop. Changes go both ways.' : value().sharing.error ?? 'Tailscale is not available on this Mac.'}</p>
        </div>
        <input id="settings-sharing" class="settings-switch" type="checkbox" role="switch" checked={value().sharing.on} disabled={busy() || !value().sharing.available} onChange={event => { void share(event.currentTarget.checked); }} />
      </div>
      <For each={value().devices.map(device => device.id)}>{id => {
        const device = () => value().devices.find(device => device.id === id)!;
        const health = () => syncHealth(sync.state(), { ...value(), devices: [device()] }, sync.now())!;
        return <details class="devices-disclosure" data-device-id={id} open={props.deviceId === id}>
          <summary><Icon name="right" /><span class="devices-name">{device().name}</span><span class="devices-row-status" data-tone={health().tone}>{health().kind === 'synced' ? device().last_seen_at ? `Synced ${ago(device().last_seen_at!, sync.now())}` : 'Not synced yet' : health().title}</span></summary>
          <div class="devices-expanded">
            <div class="devices-versions"><div><h3>{device().name}</h3><p class="settings-mono">{versionLine(device().version)}</p></div><div><h3>{value().hub_name}</h3><p class="settings-mono">{versionLine(value().this_device)}</p></div></div>
            <Show when={health().kind !== 'synced'}><div class="devices-fix" data-tone={health().tone}><h3>{health().title}</h3><SyncExplanation health={health()} /><SyncFix health={health()} onError={props.onError} /></div></Show>
            <dl class="devices-facts"><dt>Last seen</dt><dd>{device().last_seen_at ? ago(device().last_seen_at!, sync.now()) : 'Not seen yet'}</dd>
              <Show when={device().refused}>{refusal => <><dt>Refused since</dt><dd>{ago(refusal().since, sync.now())} · {plural(refusal().attempts, 'attempt')}</dd></>}</Show>
              <Show when={device().last_attempt_at}><dt>Last attempt</dt><dd>{ago(device().last_attempt_at!, sync.now())}</dd></Show>
            </dl>
            <AttemptLedger attempts={device().attempts} when={props.when} />
            <div class="devices-actions"><Show when={forgetting() === id} fallback={<Button class="danger" onClick={() => setForgetting(id)}>Forget</Button>}>
              <span class="settings-backup-question">Forget {device().name}? It must pair again to sync.</span>
              <Button onClick={() => setForgetting(null)}>Cancel</Button>
              <Button class="bordered danger" onClick={() => { void forget(id); }}>Confirm</Button>
            </Show></div>
          </div>
        </details>;
      }}</For>
      <Show when={value().retained.changes > 0}><p class="settings-mono devices-retained">Keeping {plural(value().retained.changes, 'change')} for devices that have not caught up ({size(value().retained.bytes)}).</p></Show>
      <div class="settings-action devices-pair"><Button class="bordered" icon="plus" disabled={busy()} onClick={() => { void pair(); }}>Pair a phone</Button>
        <Show when={!value().sharing.on && (pairNeedsSharing() || !value().sharing.available)}><span class="settings-hint" role="status">Turn on Sharing first</span></Show>
      </div>
      <Show when={pairing()}><PairDialog url={value().sharing.url} onDone={() => { setPairing(false); void sync.refresh(); }} /></Show>
    </>}</Show>
    <NeedsReview notebook={props.notebook} onOpenPage={props.onOpenPage} onError={props.onError} />
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
        <li><span class="section-number">02</span><span>Choose <strong>Use my Mac's workshop</strong>.</span></li>
        <li><span class="section-number">03</span>Scan this code.</li>
      </ol>
    </div>}</Show>}>
      <p class="pair-paired" role="status">{paired()} is paired and copying the workshop.</p>
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

/** A replica has one relationship to inspect: this copy and the Mac that shares it. */
export function PhoneDevices(props: DeviceProps) {
  const [setup, setSetup] = createSignal(false);
  void sync.refresh();
  return <>
    {props.heading}
    <Show when={sync.state()}>{state => <Show when={replica()} fallback={<>
      <div class="settings-row">
        <div class="settings-label"><span class="settings-name">Use my Mac's workshop</span><p>A copy of your Mac's workshop. Changes go both ways.</p></div>
        <Button class="bordered" disabled={state().role !== 'none'} onClick={() => setSetup(true)}>Set up</Button>
      </div>
      <Show when={setup()}><SyncSetup onDone={() => setSetup(false)} /></Show>
    </>}>{value => <>
      <details class="devices-disclosure" data-device-id={value().device_id} open={props.deviceId === value().device_id}>
        <summary><Icon name="right" /><span class="devices-name">{value().hub_name ?? 'The Mac'}</span><span class="devices-row-status" data-tone={currentHealth()?.tone}>{currentHealth()?.title}</span></summary>
        <div class="devices-expanded">
          <div class="devices-versions"><div><h3>{value().device_name ? `This device · ${value().device_name}` : 'This device'}</h3><p class="settings-mono">{versionLine(state().this_device)}</p></div><div><h3>{value().hub_name ? `The Mac · ${value().hub_name}` : 'The Mac'}</h3><p class="settings-mono">{versionLine(value().hub_version)}</p></div></div>
          <p class="settings-mono devices-url">{value().hub_url}</p>
          <Show when={currentHealth()}>{health => <div class="devices-fix" data-tone={health().tone}><h3>{health().title}</h3><SyncExplanation health={health()} /><SyncFix health={health()} onError={props.onError} /></div>}</Show>
          <dl class="devices-facts"><dt>Last synced</dt><dd>{value().synced_at ? ago(value().synced_at!, sync.now()) : 'Not synced yet'}</dd>
            <Show when={value().failing_since}><dt>{currentHealth()?.kind === 'version' ? 'Refused since' : 'Failing since'}</dt><dd>{ago(value().failing_since!, sync.now())} · {plural(value().attempts.filter(attempt => !attempt.ok && attempt.first_at >= value().failing_since!).reduce((count, attempt) => count + attempt.count, 0), 'attempt')}</dd></Show>
            <dt>Changes waiting</dt><dd>{value().pending} · kept on this device</dd>
          </dl>
          <AttemptLedger attempts={value().attempts} when={props.when} />
        </div>
      </details>
      <Show when={value().offline.books > 0}><div class="settings-row"><div class="settings-label"><span class="settings-name">Offline books</span><p>{plural(value().offline.books, 'book')} · {size(value().offline.bytes)}</p></div><span class="settings-aside">On this device</span></div></Show>
    </>}</Show>}</Show>
    <NeedsReview notebook={props.notebook} onOpenPage={props.onOpenPage} onError={props.onError} />
  </>;
}

function AttemptLedger(props: { attempts: SyncAttempt[]; when(value: number): string }) {
  const when = (at: number) => props.when(at);
  return <div class="devices-attempts"><h3>Recent attempts</h3><Show when={props.attempts?.length} fallback={<p>No attempts recorded since this service started.</p>}>
    <table><thead><tr><th>When</th><th>Result</th><th>Attempts</th></tr></thead><tbody><For each={props.attempts?.slice(0, 6)}>{attempt => <tr><td class="settings-mono"><time dateTime={new Date(attempt.at).toISOString()} title={`First attempt ${when(attempt.first_at)}`}>{when(attempt.at)}</time></td><td data-tone={attempt.ok ? 'muted' : 'rubric'} title={attempt.message ?? undefined}>{attempt.ok ? 'Accepted' : attempt.code === 'schema_mismatch' ? 'Version refused' : attempt.code === 'hub_unreachable' ? 'Could not reach the Mac' : attempt.message ?? attempt.code ?? 'Failed'}</td><td class="settings-mono">{attempt.count}</td></tr>}</For></tbody></table>
  </Show><p class="devices-ledger-note">Recent attempts from this service run. They clear when Tessera restarts.</p></div>;
}

function NeedsReview(props: { notebook: NotebookClient; onOpenPage(pageId: string): void; onError(message: string): void }) {
  const [busy, setBusy] = createSignal(false);
  const [undo, setUndo] = createSignal<{ label: string; run(): Promise<void> } | null>(null);
  const settle = async (change: RejectedChange, copy: boolean) => {
    if (busy()) return;
    setBusy(true);
    try {
      const receipt = await settleRejection(props.notebook, change, copy);
      setUndo({ label: copy ? 'Text copied back.' : 'Change dismissed.', run: receipt.undo });
      await sync.refresh(); await syncConflicts.refresh();
    } catch (reason) { props.onError(message(reason)); }
    finally { setBusy(false); }
  };
  const undoLast = async () => {
    const last = undo();
    if (!last || busy()) return;
    setBusy(true);
    try { await last.run(); setUndo(null); await sync.refresh(); await syncConflicts.refresh(); }
    catch (reason) { props.onError(message(reason)); }
    finally { setBusy(false); }
  };
  return <Show when={(syncConflicts.state()?.kept.length ?? 0) + (syncConflicts.state()?.rejected.length ?? 0) > 0 || undo()}>
    <details class="devices-disclosure devices-review" aria-label="Needs review" open>
      <summary><Icon name="right" /><span class="devices-name">Needs review</span><span class="devices-row-status">{syncConflicts.state()?.kept.length ?? 0} kept · {syncConflicts.state()?.rejected.length ?? 0} rejected</span></summary>
      <div class="devices-expanded">
      <p>Kept versions are beside their atoms. Rejected changes are kept here until you copy them back or dismiss them.</p>
      <Show when={undo()}>{last => <div class="devices-undo" role="status"><span>{last().label}</span><Button class="bordered" disabled={busy()} onClick={() => { void undoLast(); }}>Undo</Button></div>}</Show>
      <For each={syncConflicts.state()?.kept}>{copy => <article class="devices-review-item">
        <p class="settings-mono">{copy.mine ? 'This device' : copy.origin_name ?? 'Another device'} · version kept beside</p><h4>{copy.page_title}</h4><blockquote>{copy.text}</blockquote>
        <div class="devices-actions"><Button class="bordered" onClick={() => props.onOpenPage(copy.page_id)}>Open the atom</Button></div>
      </article>}</For>
      <For each={syncConflicts.state()?.rejected}>{change => <article class="devices-review-item">
        <p class="settings-mono">{change.mine ? 'This device' : change.origin_name ?? 'Another device'} · rejected {ago(change.created_at, sync.now())}</p><h4>{change.page_title ?? 'Atom no longer available'}</h4>
        <For each={change.texts}>{text => <blockquote>{text}</blockquote>}</For><p class="devices-rejection-reason">{change.error}</p>
        <div class="devices-actions"><Show when={change.page_id}><Button class="bordered" onClick={() => props.onOpenPage(change.page_id!)}>Open the atom</Button></Show>
          <Show when={change.texts.length > 0}><Button class="bordered" disabled={busy()} onClick={() => { void settle(change, true); }}>Copy the text back</Button></Show>
          <Button class="bordered" disabled={busy()} onClick={() => { void settle(change, false); }}>Dismiss</Button>
        </div>
      </article>}</For>
      </div>
    </details>
  </Show>;
}
