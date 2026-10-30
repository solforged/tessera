import { Show, createSignal } from 'solid-js';
import { api, ApiError } from '../api/client';
import { MOBILE } from '../demo/mode';
import { Button } from '../ui/Button';
import { isPhone } from '../ui/phone';
import { Popup } from '../ui/Popup';
import { deviceName, macName, normalizeHubUrl, scanPairing } from './device';
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

/**
 * The phone's first choice: copy the Mac's notebook, or keep a notebook of its own. With `again`, a forgotten phone pairs
 * with the same Mac once more; only the first choice is offered, with the Mac's address filled in. On a phone it is a sheet
 * of two leaves, Type code goes to a form with a way back, and joining is a sheet that cannot be dismissed.
 */
export function SyncSetup(props: { again?: { url: string }; onDone(): void }) {
  const phone = isPhone();
  const [step, setStep] = createSignal<'choose' | 'type' | 'joining'>('choose');
  const [address, setAddress] = createSignal(props.again?.url.replace(/^https:\/\//, '') ?? '');
  const [code, setCode] = createSignal('');
  const [error, setError] = createSignal('');
  const [mac, setMac] = createSignal('Your Mac');
  let codeInput!: HTMLInputElement;
  const finish = () => { localStorage.setItem(SETUP_SEEN_KEY, '1'); props.onDone(); };
  const join = async (target: PairingTarget) => {
    setError(''); setMac(macName(target.url)); setStep('joining');
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
  const back = () => { setStep('choose'); setError(''); };
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const device = MOBILE ? 'phone' : 'device';
  const form = <form class="sync-form" onSubmit={event => { event.preventDefault(); void join({ url: normalizeHubUrl(address()), code: code() }); }}
    ref={element => queueMicrotask(() => (address() ? codeInput : element.querySelector('input'))?.focus())}>
    <label><span>Mac address</span><input class="input sync-address" type="text" inputMode="url" autocapitalize="off" autocomplete="off" spellcheck={false} placeholder="mac-name.tailnet.ts.net:4319" value={address()} onInput={event => setAddress(event.currentTarget.value)} /></label>
    <label><span>Code</span><input ref={codeInput} class="input sync-code" type="text" autocapitalize="characters" autocomplete="one-time-code" spellcheck={false} placeholder="4F7K-92QD" value={code()} onInput={event => setCode(event.currentTarget.value)} /></label>
    <Show when={phone}><p class="sync-hint">The code expires a few minutes after the Mac makes it.</p></Show>
    <div class="sync-actions">
      <Button kind="stamp" class="sync-primary" size={phone ? 'lg' : undefined} type="submit" disabled={!address().trim() || code().replace(/[\s-]/g, '').length < 8}>Pair</Button>
      <Show when={!phone}><Button onClick={back}>Back</Button></Show>
    </div>
  </form>;
  return <Popup anchor={document.body} placement={touch ? 'sheet' : 'top'} width={560} label={props.again ? 'Pair again' : 'Set up this device'} class={`sync-setup${step() === 'joining' ? ' is-joining' : ''}${phone && step() === 'type' ? ' is-typing' : ''}`}
    title={phone && step() === 'type' ? 'Pair with your Mac' : undefined} onDismiss={step() === 'joining' ? () => undefined : finish}>
    <Show when={phone && step() === 'type'}><Button class="sync-back" icon="left" label="Back" onClick={back} /></Show>
    <Show when={step() === 'joining'} fallback={<>
      <Show when={!(phone && step() === 'type')}><header class="sync-setup-head">
        <p class="sync-register">Workshop · {MOBILE ? 'this phone' : 'this device'}</p>
        <h2>{props.again ? 'Pair with the Mac again' : 'Where is your workshop?'}</h2>
        <p>{props.again
          ? `The Mac forgot this ${device}. Your notes and the changes waiting here go to the Mac once it pairs again.`
          : `Choose how this ${device} will use Tessera.`}</p>
      </header></Show>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <Show when={phone && step() === 'type'} fallback={<>
        <section class="sync-choice">
          <h3><Show when={!phone}><span class="section-number">01</span></Show>{props.again ? 'Pair with a new code' : 'Use my Mac’s workshop'}</h3>
          <p>{props.again
            ? 'Make a code on the Mac in Settings › Devices › Pair a phone.'
            : `A copy of your Mac’s workshop. This ${device} sends its changes to the Mac and gets the Mac’s changes. Anything already here is added to the Mac’s workshop first.`}</p>
          <Show when={step() === 'type'} fallback={<>
            <div class="sync-actions">
              <Show when={MOBILE}><Button kind="stamp" class="sync-primary" onClick={() => { void scanCode(); }}>Scan code</Button></Show>
              <Button kind="tint" onClick={() => setStep('type')}>Type code</Button>
            </div>
            <Show when={!props.again}><p class="sync-hint">Open Settings › Devices on the Mac to pair.</p></Show>
          </>}>{form}</Show>
        </section>
        <Show when={!props.again}>
          <section class="sync-choice">
            <h3><Show when={!phone}><span class="section-number">02</span></Show>Start a workshop on this {device}</h3>
            <p>A separate workshop. It does not sync with your Mac.</p>
            <div class="sync-actions"><Button kind="tint" onClick={finish}>Start a workshop</Button></div>
          </section>
        </Show>
        <p class="sync-hint sync-setup-foot">Your workshop stays on your devices.</p>
      </>}>
        <p class="sync-lede">Make a code on the Mac in Settings › Devices › Pair a phone, then type it here.</p>
        {form}
      </Show>
    </>}>
      <header class="sync-setup-head">
        <p class="sync-register">Workshop · {MOBILE ? 'this phone' : 'this device'}</p>
        <h2>Pairing with your Mac</h2>
      </header>
      <section class="sync-joining" role="status" aria-label="Pairing progress">
        <p class="sync-joining-mac"><span>{mac()}</span><span>This Mac</span></p>
        <div class="sync-bar" aria-hidden="true"><i /></div>
        <ol class="sync-stages">
          <li data-stage="doing"><span class="sync-ring" aria-hidden="true" /><span><strong>Pairing and copying the workshop</strong><small>Your notes, books and tasks</small></span></li>
          <li data-stage="next"><span class="sync-ring" aria-hidden="true" /><span>Opening Today</span></li>
        </ol>
      </section>
      <p class="sync-hint sync-setup-foot">Keep Tessera open. Anything already on this {device} is added to the Mac’s workshop first.</p>
    </Show>
  </Popup>;
}
