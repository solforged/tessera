import { Show, createSignal } from 'solid-js';
import { api, ApiError } from '../api/client';
import { ANDROID } from '../demo/mode';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { deviceName, normalizeHubUrl, scanPairing } from './device';
import type { PairingTarget } from './device';
import { sync } from './state';
import './sync.css';

/** Set once the phone has chosen how to use Tessera, so the first-run choice is not offered again. */
export const SETUP_SEEN_KEY = 'tessera.sync.setup-seen';

const failure = (reason: unknown) => {
  if (reason instanceof ApiError) {
    if (reason.code === 'bad_code') return 'That code does not match. Check it against the Mac.';
    if (reason.code === 'expired_code') return 'That code has expired. Make a new one on the Mac.';
    if (reason.code === 'hub_unreachable' || reason.code === 'unreachable') return 'Can’t reach the Mac. Check that it is awake and that Tailscale is on for both devices.';
  }
  return reason instanceof Error ? reason.message : String(reason);
};

/** The phone's first choice: copy the Mac's notebook, or keep a notebook of its own. */
export function SyncSetup(props: { onDone(): void }) {
  const [step, setStep] = createSignal<'choose' | 'type' | 'joining'>('choose');
  const [address, setAddress] = createSignal('');
  const [code, setCode] = createSignal('');
  const [error, setError] = createSignal('');
  const finish = () => { localStorage.setItem(SETUP_SEEN_KEY, '1'); props.onDone(); };
  const join = async (target: PairingTarget) => {
    setError(''); setStep('joining');
    try {
      sync.set(await api.joinHub(target.url, target.code, deviceName()));
      finish();
    } catch (reason) {
      setError(failure(reason));
      setStep(address() || code() ? 'type' : 'choose');
    }
  };
  const scanCode = async () => {
    setError('');
    try {
      const target = await scanPairing();
      if (target) await join(target);
      else setError('That is not a Tessera pairing code. Scan the code in Settings › Devices on the Mac.');
    } catch (reason) { setError(failure(reason)); }
  };
  const touch = window.matchMedia('(pointer: coarse)').matches;
  return <Popup anchor={document.body} placement={touch ? 'sheet' : 'top'} width={560} label="Set up this device" class="sync-setup" onDismiss={step() === 'joining' ? () => undefined : finish}>
    <header class="sync-setup-head">
      <p class="sync-register">Notebook · {ANDROID ? 'this phone' : 'this device'}</p>
      <h2>Where is your notebook?</h2>
      <p>Choose how {ANDROID ? 'this phone' : 'this device'} will use Tessera.</p>
    </header>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={step() !== 'joining'} fallback={<p class="sync-joining" role="status"><span class="sync-dot" aria-hidden="true" />Pairing and copying your Mac’s notebook…</p>}>
      <section class="sync-choice">
        <h3><span class="section-number">01</span>Use my Mac's notebook</h3>
        <p>A copy of your Mac's notebook. This {ANDROID ? 'phone' : 'device'} sends its changes to the Mac and gets the Mac's changes. Anything already here is added to the Mac's notebook first.</p>
        <Show when={step() === 'type'} fallback={<>
          <div class="sync-actions">
            <Show when={ANDROID}><Button class="bordered sync-primary" onClick={() => { void scanCode(); }}>Scan code</Button></Show>
            <Button class="bordered" onClick={() => setStep('type')}>Type code</Button>
          </div>
          <p class="sync-hint">Open Settings → Devices on the Mac to pair.</p>
        </>}>
          <form class="sync-form" onSubmit={event => { event.preventDefault(); void join({ url: normalizeHubUrl(address()), code: code() }); }}>
            <label>Mac address<input class="input" type="text" inputMode="url" autocapitalize="off" autocomplete="off" spellcheck={false} placeholder="mac-name.tailnet.ts.net:4319" value={address()} onInput={event => setAddress(event.currentTarget.value)} /></label>
            <label>Code<input class="input" type="text" autocapitalize="characters" autocomplete="one-time-code" spellcheck={false} placeholder="4F7K-92QD" value={code()} onInput={event => setCode(event.currentTarget.value)} /></label>
            <div class="sync-actions">
              <Button class="bordered sync-primary" type="submit" disabled={!address().trim() || code().replace(/[\s-]/g, '').length < 8}>Pair</Button>
              <Button onClick={() => { setStep('choose'); setError(''); }}>Back</Button>
            </div>
          </form>
        </Show>
      </section>
      <section class="sync-choice">
        <h3><span class="section-number">02</span>Start a notebook on this {ANDROID ? 'phone' : 'device'}</h3>
        <p>A separate notebook. It does not sync with your Mac.</p>
        <div class="sync-actions"><Button class="bordered" onClick={finish}>Start a notebook</Button></div>
      </section>
      <p class="sync-hint sync-setup-foot">Your books and notes stay on your devices.</p>
    </Show>
  </Popup>;
}
