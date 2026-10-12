import { For, Show, createEffect, createResource, createSignal, on, onMount } from 'solid-js';
import { api } from '../api/client';
import type { SyncConflicts, SyncState } from '../api/types';
import { ANDROID, DEMO } from '../demo/mode';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { SETUP_SEEN_KEY, SyncSetup } from './SyncSetup';
import { ago, forgotten, outboxHeading, outboxParts, outboxText, plural, problem, replica, size, sync } from './state';
import './sync.css';

/**
 * The top bar's sync status on a replica: how many changes are waiting, shown only while some are, or that the copy
 * must be downloaded again. It opens the sync sheet. On the phone's first run it also offers the setup choice.
 */
export function SyncStatus(props: { notebook: NotebookClient; onOpenPage(pageId: string): void }) {
  const [open, setOpen] = createSignal(false);
  const [setup, setSetup] = createSignal(false);
  onMount(() => {
    if (DEMO) return;
    void sync.refresh().then(state => {
      if (ANDROID && state?.role === 'none' && !localStorage.getItem(SETUP_SEEN_KEY)) setSetup(true);
    });
  });
  // A local commit adds to the outbox; ask again rather than wait for the next poll.
  createEffect(on(() => props.notebook.changeSequence(), () => { if (replica()) void sync.refresh(); }, { defer: true }));
  const shown = () => { const value = replica(); return !!value && (value.pending > 0 || value.retired || forgotten()); };
  return <>
    <Show when={shown()}>
      <Button class="sync-status" aria-haspopup="dialog" aria-expanded={open()} title="Sync" onClick={() => setOpen(true)}>
        <span class="sync-dot" data-error={replica()?.last_error ? '' : undefined} aria-hidden="true" />
        <span>{forgotten() ? 'Not paired' : replica()!.retired ? 'Out of date' : outboxText(replica()!.pending, replica()!.unapplied)}</span>
      </Button>
    </Show>
    <Show when={open()}><SyncSheet onClose={() => setOpen(false)} onOpenPage={pageId => { setOpen(false); props.onOpenPage(pageId); }} /></Show>
    <Show when={setup()}><SyncSetup onDone={() => setSetup(false)} /></Show>
  </>;
}

/** Sync now, kept copies and offline books; a retired copy offers to download the notebook again, a forgotten one to pair again. */
export function SyncSheet(props: { onClose(): void; onOpenPage(pageId: string): void }) {
  const [view, setView] = createSignal<'sync' | 'conflicts'>('sync');
  const [running, setRunning] = createSignal(false);
  const [error, setError] = createSignal('');
  const [pairing, setPairing] = createSignal(false);
  const [conflicts] = createResource(() => view() === 'conflicts', () => api.syncConflicts());
  const act = async (action: () => Promise<SyncState>) => {
    setRunning(true); setError('');
    try { sync.set(await action()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRunning(false); }
  };
  const touch = window.matchMedia('(pointer: coarse)').matches;
  return <Show when={!pairing()} fallback={<Show when={replica()}>{value => <SyncSetup again={{ url: value().hub_url }} onDone={() => { setPairing(false); props.onClose(); }} />}</Show>}>
    <Popup anchor={document.body} placement={touch ? 'sheet' : 'top'} width={480} label="Sync" class="sync-sheet" onDismiss={props.onClose}>
    <Show when={replica()}>{value => <>
      <header class="sync-sheet-head">
        <div><p class="sync-register">{value().device_name ?? 'This device'} → {value().hub_name ?? 'Mac'}</p><h2>{view() === 'sync' ? 'Sync' : 'Conflicts'}</h2></div>
        <Button icon="close" label="Close" onClick={props.onClose} />
      </header>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <Show when={view() === 'sync'} fallback={<Conflicts conflicts={conflicts()} loading={conflicts.loading} onOpenPage={props.onOpenPage} onBack={() => setView('sync')} />}>
        <Show when={value().retired} fallback={
          <div class="sync-row">
            <div><strong>{outboxHeading(value().pending, value().unapplied)}</strong>
              <p>{value().syncing || running() ? 'Syncing…' : value().synced_at ? `Synced ${ago(value().synced_at!)}` : 'Not synced yet'}</p>
              <Show when={outboxParts(value().pending, value().unapplied).waiting > 0 && value().unapplied > 0}>
                <p>{plural(value().unapplied, 'change')} not applied</p>
              </Show>
              <For each={value().unapplied_errors}>{item => <p class="sync-error" title={item.change_id}>{item.error}</p>}</For>
              <Show when={value().last_error}>{failure => <p class="sync-error" title={failure().message}>{problem(failure())}</p>}</Show>
            </div>
            <Show when={forgotten()} fallback={<Button class="bordered" disabled={running() || value().syncing} onClick={() => { void act(api.runSync); }}>Sync now</Button>}>
              <Button class="bordered sync-primary" onClick={() => setPairing(true)}>Pair again</Button>
            </Show>
          </div>}>
          <div class="sync-retired">
            <p class="sync-register">{ANDROID ? 'This phone' : 'This device'} · notebook copy</p>
            <strong>The Mac stopped keeping changes for this {ANDROID ? 'phone' : 'device'} after 30 days away.</strong>
            <p>Changes made here were sent to the Mac first.</p>
            <Button class="bordered sync-primary" disabled={running()} onClick={() => { void act(api.reclone); }}>{running() ? 'Downloading…' : 'Download the notebook again'}</Button>
            <p class="sync-hint">Pins and downloaded books stay.</p>
          </div>
        </Show>
        <Show when={value().kept_copies > 0 || value().rejected > 0}>
          <button type="button" class="sync-row sync-link" onClick={() => setView('conflicts')}>
            <span><strong>{value().kept_copies > 0 ? `${plural(value().kept_copies, 'version')} kept beside` : `${plural(value().rejected, 'change')} the Mac could not apply`}</strong>
              <Show when={value().kept_copies > 0 && value().rejected > 0}><span class="sync-hint">{plural(value().rejected, 'change')} the Mac could not apply</span></Show>
            </span>
            <Icon name="right" />
          </button>
        </Show>
        <div class="sync-row">
          <div><strong>Offline books</strong><p>{value().offline.books ? `${plural(value().offline.books, 'book')} · ${size(value().offline.bytes)}` : 'None yet. Keep a book offline from its page.'}</p></div>
          <span class="sync-hint">On this {ANDROID ? 'phone' : 'device'}</span>
        </div>
      </Show>
    </>}</Show>
    </Popup>
  </Show>;
}

function Conflicts(props: { conflicts: SyncConflicts | undefined; loading: boolean; onOpenPage(pageId: string): void; onBack(): void }) {
  return <div class="sync-conflicts">
    <Show when={props.conflicts} fallback={<p class="sync-hint">{props.loading ? 'Loading…' : ''}</p>}>{conflicts => <>
      <p class="sync-register">Kept beside · {conflicts().kept.length}</p>
      <For each={conflicts().kept}>{copy => <button type="button" class="sync-row sync-link" onClick={() => props.onOpenPage(copy.page_id)}>
        <span><strong>{copy.page_title}</strong><span class="sync-hint">{copy.mine ? `${ANDROID ? 'This phone' : 'This device'}'s version, kept beside` : `${copy.origin_name ?? 'Another device'}'s version, kept beside`}</span></span>
        <Icon name="right" />
      </button>}</For>
      <p class="sync-register">Rejected · {conflicts().rejected.length}</p>
      <Show when={conflicts().rejected.length > 0} fallback={<p class="sync-hint">No rejected changes.</p>}>
        <For each={conflicts().rejected}>{change => <div class="sync-row"><div><strong>{change.error}</strong><p>{ago(change.created_at)}</p></div></div>}</For>
      </Show>
    </>}</Show>
    <div class="sync-actions sync-back"><Button class="bordered" onClick={props.onBack}>Back to sync</Button></div>
  </div>;
}
