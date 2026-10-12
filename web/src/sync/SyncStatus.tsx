import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { SyncState } from '../api/types';
import { api } from '../api/client';
import { ANDROID, DEMO } from '../demo/mode';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { RELEASES, downloadPage, syncHealth, type SyncHealth } from './health';
import { SETUP_SEEN_KEY, SyncSetup } from './SyncSetup';
import { ago, hubDevices, plural, replica, sync, syncConflicts } from './state';
import './sync.css';

export const currentHealth = () => syncHealth(sync.state(), hubDevices.state(), sync.now(), syncConflicts.state(), DEMO);

export function SyncMark(props: { onOpen(anchor: HTMLElement): void; open: boolean }) {
  const [slip, setSlip] = createSignal<HTMLElement | null>(null);
  let pending = 0;
  const pointer = () => !window.matchMedia('(pointer: coarse)').matches;
  const close = () => { window.clearTimeout(pending); setSlip(null); };
  const over = (event: PointerEvent & { currentTarget: HTMLButtonElement }) => {
    if (!pointer() || event.pointerType !== 'mouse' || props.open) return;
    const anchor = event.currentTarget;
    window.clearTimeout(pending);
    // Match the delay used by reference previews.
    pending = window.setTimeout(() => {
      if (pointer() && !props.open && anchor.isConnected && anchor.matches(':hover')) setSlip(anchor);
    }, 350);
  };
  createEffect(() => { if (props.open) close(); });
  onCleanup(close);
  return <Show when={currentHealth()}>{health => <>
    <Button class="sync-mark" data-tone={health().tone} aria-haspopup="dialog" aria-expanded={props.open} aria-label={`Sync: ${health().rail}`}
      onPointerEnter={over} onPointerLeave={close} onBlur={close}
      onFocus={event => { if (pointer() && !props.open && event.currentTarget.matches(':focus-visible')) setSlip(event.currentTarget); }}
      onClick={event => { close(); props.onOpen(event.currentTarget); }}>
      <span class="sync-glyph" aria-hidden="true" />
    </Button>
    <Show when={!props.open && slip()}>{anchor => <Popup anchor={anchor()} role="tooltip" label="Sync status" class="sync-slip" autofocus={false} onDismiss={close}>
      <p class="sync-slip-state" data-tone={health().tone}>{health().rail}</p>
      <p class="sync-slip-hint">{health().hint}</p>
    </Popup>}</Show>
  </>}</Show>;
}

export function SyncCover(props: { onOpen(anchor: HTMLElement): void; open: boolean }) {
  return <Show when={currentHealth()?.cover}>{label => <Button class="sync-cover" data-tone={currentHealth()!.tone} aria-haspopup="dialog" aria-expanded={props.open} aria-label={`Sync: ${label()}, ${currentHealth()!.detail}`} onClick={event => props.onOpen(event.currentTarget)}>
    <span class="sync-glyph" aria-hidden="true" />
    <span>{label()}</span><span class="sync-cover-detail">{currentHealth()!.detail}</span><Icon name="right" />
  </Button>}</Show>;
}

/** Kept outside the hidden rail so first-run setup and cover sheets still mount on a phone. */
export function SyncLifecycle(props: { notebook: NotebookClient; anchor: HTMLElement | null; onClose(): void; onDevices(deviceId: string | null): void }) {
  const [setup, setSetup] = createSignal(false);
  onMount(() => {
    if (DEMO) return;
    void sync.refresh().then(state => {
      if (ANDROID && state?.role === 'none' && !localStorage.getItem(SETUP_SEEN_KEY)) setSetup(true);
    });
  });
  createEffect(on(() => props.notebook.changeSequence(), () => { if (!DEMO) void sync.refresh(); }, { defer: true }));
  return <>
    <Show when={props.anchor && currentHealth()}>{health => <SyncSummary health={health()} anchor={props.anchor!} onClose={props.onClose} onDevices={() => { const id = health().deviceId; props.onClose(); props.onDevices(id); }} />}</Show>
    <Show when={setup()}><SyncSetup onDone={() => setSetup(false)} /></Show>
  </>;
}

export function SyncExplanation(props: { health: SyncHealth }) {
  const value = () => props.health;
  const device = () => value().role === 'replica' ? `this ${value().deviceName}` : value().deviceName;
  return <Switch>
    <Match when={value().kind === 'version'}>
      <p><Show when={value().deviceVersion && value().hubVersion} fallback={<>The devices run different versions of Tessera.</>}>
        {value().deviceName} runs <span class="sync-mono">schema {value().deviceVersion?.schema}</span> and {value().hubName} <span class="sync-mono">schema {value().hubVersion?.schema}</span>.{' '}
        <Show when={value().behind}>{side => <>{side() === 'hub' ? value().hubName : value().deviceName} is behind.</>}</Show>
      </Show></p>
      <p>Update {value().behind === 'hub' ? value().hubName : value().behind === 'replica' ? value().deviceName : 'both devices'}, then reopen Tessera.</p>
      <Show when={value().pending > 0}><p class="sync-waiting">{plural(value().pending, 'change')} {value().pending === 1 ? 'stays' : 'stay'} on {device()} and {value().pending === 1 ? 'sends' : 'send'} after the update.</p></Show>
    </Match>
    <Match when={value().kind === 'unreachable'}>
      <Show when={value().pending > 0}><p>{plural(value().pending, 'change')} waiting.<Show when={replica()?.synced_at}>{at => <> Last successful sync {ago(at(), sync.now())}.</>}</Show></p></Show>
      <p>Tessera cannot tell whether {device()} is off the tailnet or {value().hubName} is not answering.</p>
      <p>Check Tailscale on {value().deviceName}. If it is connected, check that {value().hubName} is awake and Tessera is running with sharing on.</p>
      <p class="sync-waiting">Your changes stay here. Tessera keeps trying.</p>
    </Match>
    <Match when={value().kind === 'review'}>
      <div class="sync-review-counts">
        <Show when={value().kept}><p><span class="sync-rubric sync-mono">{value().kept}</span> {value().kept === 1 ? 'version kept beside its block' : 'versions kept beside their blocks'}</p></Show>
        <Show when={value().rejected}><p><span class="sync-rubric sync-mono">{value().rejected}</span> {value().rejected === 1 ? 'rejected change' : 'rejected changes'} the Mac could not apply</p></Show>
      </div>
      <p><Show when={value().kept}>The kept versions are still beside their blocks. </Show><Show when={value().rejected}>Rejected changes are available in Settings.</Show></p><p class="sync-waiting">Review when convenient. Nothing has been discarded.</p>
    </Match>
    <Match when={value().kind === 'forgotten'}><p>{value().hubName} no longer accepts this device's key. Pair it again to sync.</p><p class="sync-waiting">Changes waiting here stay on this device.</p></Match>
    <Match when={value().kind === 'retired'}><p>{value().role === 'hub' ? `${value().deviceName} needs to download the notebook again.` : `${value().hubName} stopped keeping changes for this device after 30 days away.`}</p><p class="sync-waiting">Pins and downloaded books stay.</p></Match>
    <Match when={value().kind === 'sending'}><p>{value().pending ? `${plural(value().pending, 'change')} waiting. Tessera is sending them.` : 'Tessera is getting the latest changes.'}</p></Match>
    <Match when={value().kind === 'synced'}><p>{value().role === 'hub' ? 'Your paired devices have no reported sync problems.' : 'No changes waiting.'}<Show when={value().role === 'replica' && replica()?.synced_at}>{at => <> Synced {ago(at() as number, sync.now())}.</>}</Show></p></Match>
  </Switch>;
}

/** The same fixing action in the short summary and the expanded device row. */
export function SyncFix(props: { health: SyncHealth; onError(message: string): void }) {
  const [running, setRunning] = createSignal(false);
  const [pairing, setPairing] = createSignal(false);
  const value = () => props.health;
  const download = () => downloadPage(value().role === 'replica' ? replica()?.hub_url : hubDevices.state()?.sharing.url);
  const useDownload = () => value().behind === 'replica' && (ANDROID || /Android/.test(navigator.userAgent) || value().role === 'hub') && download();
  const act = async (action: () => Promise<SyncState>) => {
    if (running()) return;
    setRunning(true);
    try { sync.set(await action()); }
    catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRunning(false); }
  };
  return <>
    <Show when={value().kind === 'version'}>
      <div class="sync-fix-actions">
        <Show when={useDownload()}>{page => <a class="button bordered" href={page().url} target="_blank" rel="noopener noreferrer">Download page on {page().host} ↗</a>}</Show>
        <a class={useDownload() ? 'sync-release-link' : 'button bordered'} href={RELEASES} target="_blank" rel="noopener noreferrer">GitHub releases ↗</a>
      </div>
    </Show>
    <Show when={value().role === 'replica' && ['unreachable', 'sending', 'synced'].includes(value().kind)}>
      <Button class="bordered" disabled={running() || replica()?.syncing} onClick={() => { void act(api.runSync); }}>{running() ? 'Trying…' : value().kind === 'unreachable' ? 'Try again' : 'Sync now'}</Button>
    </Show>
    <Show when={value().role === 'replica' && value().kind === 'forgotten'}><Button class="bordered" onClick={() => setPairing(true)}>Pair again</Button></Show>
    <Show when={value().role === 'replica' && value().kind === 'retired'}><Button class="bordered" disabled={running()} onClick={() => { void act(api.reclone); }}>{running() ? 'Downloading…' : 'Download the notebook again'}</Button></Show>
    <Show when={pairing()}><SyncSetup again={{ url: replica()!.hub_url }} onDone={() => setPairing(false)} /></Show>
  </>;
}

function SyncSummary(props: { health: SyncHealth; anchor: HTMLElement; onClose(): void; onDevices(): void }) {
  const [error, setError] = createSignal('');
  const touch = window.matchMedia('(pointer: coarse)').matches;
  return <>
    <Show when={touch}><Portal><div class="sync-summary-shade" aria-hidden="true" /></Portal></Show>
    <Popup anchor={props.anchor} placement={touch ? 'sheet' : 'anchor'} width={380} label="Sync summary" class={`sync-summary ${touch ? 'sync-summary-touch' : 'sync-summary-pointer'}`} onDismiss={props.onClose}>
    <div class="sync-summary-inner" data-tone={props.health.tone}>
      <header class="sync-sheet-head"><div><p class="sync-register">{props.health.role === 'hub' ? `${props.health.hubName} · devices` : `${props.health.deviceName} → ${props.health.hubName}`}</p><h2>{props.health.title}</h2></div><Button icon="close" label="Close sync summary" onClick={props.onClose} /></header>
      <div class="sync-explanation"><SyncExplanation health={props.health} /></div>
      <Show when={props.health.role === 'hub'}><For each={hubDevices.state()?.devices.slice(0, 3)}>{device => <div class="sync-summary-device" data-tone={device.refused ? 'rubric' : 'muted'}>
        <span class="sync-mono">{device.name}{device.refused ? ` · refused since ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(device.refused.since)}` : ''}</span>
        <span class="sync-mono">{device.refused ? plural(device.refused.attempts, 'attempt') : device.last_seen_at ? `Synced ${ago(device.last_seen_at, sync.now())}` : 'Not synced yet'}</span>
      </div>}</For></Show>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <Show when={props.health.kind !== 'review'}><div class="sync-summary-action"><SyncFix health={props.health} onError={setError} /></div></Show>
      <button type="button" class="sync-details" onClick={props.onDevices}><span>Settings › Devices<small>{props.health.kind === 'review' ? 'Kept versions and rejected changes' : props.health.kind === 'unreachable' ? 'Connection and recent attempts' : 'Versions, attempts and devices'}</small></span><Icon name="right" /></button>
    </div>
    </Popup>
  </>;
}
