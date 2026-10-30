import { Show, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { NotebookInfo, ServiceInfo } from '../api/types';
import { MOBILE } from '../demo/mode';
import { size } from '../sync/state';
import { Button } from '../ui/Button';
import { haptic } from '../ui/haptics';
import { Icon } from '../ui/Icon';
import { ListRow, PropertyRow } from '../ui/List';
import { workshopName } from './notebooks';
import { shortDate } from './time';

/**
 * About on a phone: the workshop by name, how big it is and when it was made, then two disclosures. The folder is not
 * printed until asked for; the id and service addresses sit behind Diagnostics, whose body the caller passes.
 */
export function PhoneAbout(props: { info: NotebookInfo; service: ServiceInfo | undefined; bytes: number | undefined; zone: string; children: JSX.Element }) {
  const [copy, setCopy] = createSignal<'idle' | 'copied' | 'failed'>('idle');
  let reset: number | undefined;
  onCleanup(() => window.clearTimeout(reset));
  const folder = () => props.info.path.split('/').filter(Boolean).at(-1) ?? props.info.path;
  // An app container's path starts with a random folder; from its Library on is the part worth reading.
  const shown = () => { const at = props.info.path.indexOf('/Library/'); return at >= 0 ? props.info.path.slice(at + 1) : props.info.path; };
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(props.info.path); setCopy('copied'); haptic('success'); }
    catch { setCopy('failed'); }
    window.clearTimeout(reset);
    reset = window.setTimeout(() => setCopy('idle'), 2000);
  };
  return <>
    <PropertyRow label="Workshop"><span class="settings-thing">{workshopName(folder())}</span></PropertyRow>
    <Show when={props.bytes !== undefined}><PropertyRow label="Size"><span class="settings-figure">{size(props.bytes!)}</span></PropertyRow></Show>
    <PropertyRow label="Created">{shortDate(props.info.created_at, props.zone)}</PropertyRow>
    <Show when={props.service}>{service => <>
      <PropertyRow label="Version">{service().version}<Show when={service().build}>{build => <> · {build()}</>}</Show></PropertyRow>
      {/* A missing launch agent needs the person; an installed one is a diagnostic. */}
      <Show when={!service().launch_agent.installed}><ListRow value="Not installed" detail="Opening Tessera.app installs it.">Launch agent</ListRow></Show>
    </>}</Show>
    <details class="settings-disclosure">
      <summary><span>Where it is stored</span><Icon name="right" /></summary>
      <div class="settings-disclosure-body">
        <p>{MOBILE ? 'The workshop lives in Tessera’s own folder on this phone.' : 'The workshop is a folder on the computer that runs Tessera.'}</p>
        <p class="settings-folder">{shown()}</p>
        <Button kind="tint" icon={copy() === 'copied' ? 'check' : 'copy'} onClick={() => { void copyPath(); }}>{copy() === 'copied' ? 'Copied' : copy() === 'failed' ? 'Couldn’t copy' : 'Copy the path'}</Button>
      </div>
    </details>
    <details class="settings-disclosure">
      <summary><span>Diagnostics</span><Icon name="right" /></summary>
      <div class="settings-disclosure-body">{props.children}</div>
    </details>
  </>;
}
