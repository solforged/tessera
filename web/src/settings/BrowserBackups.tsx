import { Show, createResource, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { browserNotebook } from '../demo/notebook';
import { localToday } from '../demo/seed';
import { size } from '../sync/state';
import { Button } from '../ui/Button';
import { cancelConfirm, escapeConfirm, focusCancel } from './confirm-focus';
import { Group } from './Group';

type Confirmation = { kind: 'file'; file: File } | { kind: 'upgrade' | 'reset' };
const lastBackupKey = 'tessera.browser.lastBackup';

export function BrowserBackups(props: { id: string; heading: JSX.Element; when(value: number): string; onError(message: string): void }) {
  const [working, setWorking] = createSignal<'notebook' | 'upgrade' | 'replace' | null>(null);
  const [confirm, setConfirm] = createSignal<Confirmation | null>(null);
  const [lastBackup, setLastBackup] = createSignal(Number(localStorage.getItem(lastBackupKey)) || null);
  const [keeping, setKeeping] = createSignal(false);
  const [declined, setDeclined] = createSignal(false);
  const [storage, { refetch: refreshStorage }] = createResource(async () => {
    if (!navigator.storage?.estimate) return null;
    try {
      const [estimate, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? false]);
      return { estimate, persisted };
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); return null; }
  });
  const keep = async () => {
    if (keeping() || !navigator.storage?.persist) return;
    setKeeping(true); setDeclined(false); props.onError('');
    try {
      setDeclined(!await navigator.storage.persist());
      await refreshStorage();
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setKeeping(false); }
  };
  const [copy] = createResource(async () => {
    try { return await browserNotebook.upgradeCopy(); }
    catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); return null; }
  });
  const busy = () => working() !== null || copy.loading;
  let picker!: HTMLInputElement;
  const download = async (upgrade: boolean) => {
    if (busy()) return;
    setWorking(upgrade ? 'upgrade' : 'notebook'); setConfirm(null); props.onError('');
    try {
      const bytes = await (upgrade ? browserNotebook.exportUpgradeCopy() : browserNotebook.exportNotebook());
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.sqlite3' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${upgrade ? 'tessera-before-upgrade' : 'tessera'}-${localToday()}.sqlite`;
      document.body.append(anchor);
      try {
        anchor.click();
        if (!upgrade) {
          const now = Date.now(); localStorage.setItem(lastBackupKey, String(now)); setLastBackup(now);
        }
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(null); }
  };
  const replace = async () => {
    const action = confirm();
    if (busy() || !action) return;
    setWorking('replace'); props.onError('');
    try {
      if (action.kind === 'file') await browserNotebook.restore(action.file);
      else if (action.kind === 'upgrade') await browserNotebook.restoreUpgradeCopy();
      else await browserNotebook.reset();
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(null); }
  };
  const cancel = (from: Element) => cancelConfirm(from, confirm()?.kind ?? '', () => setConfirm(null));
  const cancelOnEscape = (event: KeyboardEvent & { currentTarget: Element }) => escapeConfirm(event, confirm()?.kind ?? '', () => setConfirm(null));
  const confirmation = () => <>
    <Button ref={focusCancel} disabled={busy()} onClick={event => cancel(event.currentTarget)} onKeyDown={cancelOnEscape}>Cancel</Button>
    <Button class="bordered danger" disabled={busy()} onClick={() => { void replace(); }} onKeyDown={cancelOnEscape}>Confirm</Button>
  </>;
  const restoreQuestion = () => {
    const action = confirm();
    return action?.kind === 'file' ? `Replace this workshop with ${action.file.name}?` : 'Replaces this workshop with one from a file. Download a backup first to keep this one.';
  };
  return <section id={props.id} aria-labelledby={`${props.id}-heading`} aria-busy={busy()}>
    <Group heading={props.heading}>
    <div class="settings-row">
      <div class="settings-label"><span class="settings-name">Workshop file</span>
        <p>One file with every atom, card and book. Keep it somewhere outside this browser.</p>
        <p class="settings-mono" role="status">{lastBackup() ? `Last downloaded ${props.when(lastBackup()!)}` : 'Not downloaded yet.'}</p>
      </div>
      <Button class="bordered" disabled={busy()} onClick={() => { void download(false); }}>{working() === 'notebook' ? 'Preparing…' : 'Download'}</Button>
    </div>
    <div class="settings-row">
      <div class="settings-label"><span class="settings-name">Restore a backup</span><p>{restoreQuestion()}</p></div>
      <span class="settings-backup-actions"><Show when={confirm()?.kind === 'file'} fallback={<Button class="bordered" data-confirm="file" disabled={busy()} onClick={() => picker.click()}>Restore…</Button>}>{confirmation()}</Show></span>
      <input ref={picker} type="file" hidden disabled={busy()} onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        if (file) { props.onError(''); setConfirm({ kind: 'file', file }); }
      }} />
    </div>
    <Show when={copy()}>{value => <div class="settings-row">
      <div class="settings-label"><span class="settings-name">Before the last upgrade</span>
        <p>{confirm()?.kind === 'upgrade' ? 'Replace this workshop with the copy from before the upgrade?' : 'Tessera saved this copy before it upgraded the workshop to a newer format.'}</p>
        <p class="settings-mono">schema {value().schema_version} · {props.when(value().created_at)} · {size(value().size)}</p>
      </div>
      <span class="settings-backup-actions"><Show when={confirm()?.kind === 'upgrade'} fallback={<>
        <Button class="bordered" disabled={busy()} onClick={() => { void download(true); }}>{working() === 'upgrade' ? 'Preparing…' : 'Download'}</Button>
        <Button class="bordered" data-confirm="upgrade" disabled={busy()} onClick={() => { props.onError(''); setConfirm({ kind: 'upgrade' }); }}>Restore…</Button>
      </>}>{confirmation()}</Show></span>
    </div>}</Show>
    <Show when={storage()}>{value => <div class="settings-row">
      <div class="settings-label"><span class="settings-name">Storage</span>
        <p>{value().persisted ? 'This browser keeps the workshop until you clear its site data.' : 'This browser may clear the workshop when the disk runs low.'}</p>
        <Show when={declined() && !value().persisted}><p role="status">The browser declined. Download backups to keep a copy.</p></Show>
        <Show when={value().estimate.usage !== undefined && value().estimate.quota !== undefined}>
          <p class="settings-mono">{size(value().estimate.usage!)} used of {size(value().estimate.quota!)}</p>
        </Show>
      </div>
      <span class="settings-backup-actions"><Show when={!value().persisted}><Button class="bordered" disabled={keeping() || !navigator.storage?.persist} onClick={() => { void keep(); }}>Keep it</Button></Show></span>
    </div>}</Show>
    <div class="settings-row">
      <div class="settings-label"><span class="settings-name">Start over</span>
        <p>{confirm()?.kind === 'reset' ? 'Erase this workshop? Download a backup first to keep it.' : 'Erases the workshop in this browser and returns to the first-run choice.'}</p>
      </div>
      <span class="settings-backup-actions"><Show when={confirm()?.kind === 'reset'} fallback={<Button class="bordered danger" data-confirm="reset" disabled={busy()} onClick={() => { props.onError(''); setConfirm({ kind: 'reset' }); }}>Start over…</Button>}>{confirmation()}</Show></span>
    </div>
    </Group>
  </section>;
}
