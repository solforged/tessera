import { Show, createSignal } from 'solid-js';
import { api } from '../api/client';
import { DEMO, EMBEDDED, MOBILE } from '../demo/mode';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { hubDevices, plural, replica, sync } from '../sync/state';
import { Button } from '../ui/Button';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { knownNotebooks, notebookLabel, notebookOpening, notebookPlace, openNotebook } from './notebooks';

/**
 * The sidebar foot names the open workshop and nothing else; how it syncs belongs to the rail's sync mark. Its menu
 * switches workshops and starts pairing; Settings and Fields keep their own icons beside it.
 */
export function NotebookSwitcher(props: { notebook: NotebookClient; onOpen(target: OpenTarget): void; onError(reason: unknown): void }) {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const current = () => knownNotebooks()?.notebooks.find(entry => entry.current);
  const devices = (deviceId?: string | null) => props.onOpen({ kind: 'settings', section: 'devices', deviceId });
  // A workshop whose folder has gone is listed only in Settings, where it can be forgotten.
  const notebooks = (): MenuItem[] => (knownNotebooks()?.notebooks ?? []).filter(entry => entry.current || entry.available).map(entry => ({
    section: 'Workshops', label: notebookLabel(entry), checked: entry.current, secondary: notebookPlace(entry),
    disabledReason: entry.current ? undefined : notebookOpening() ? 'A workshop is already opening' : undefined,
    action: entry.current ? undefined : () => { void openNotebook(props.notebook, entry.path, false, notebookLabel(entry)).catch(props.onError); },
  }));
  const syncRows = (): MenuItem[] => {
    if (DEMO) return [];
    const copy = replica();
    if (copy) return [
      { section: 'Sync', label: 'Sync now', disabledReason: copy.syncing ? 'Already syncing' : copy.retired ? 'Download the workshop again first' : undefined,
        action: () => { void api.runSync().then(sync.set, props.onError); } },
      { section: 'Sync', label: 'Devices', secondary: copy.hub_name ?? undefined, action: () => devices(copy.device_id) },
    ];
    if (MOBILE) return [{ section: 'Sync', label: "Use my Mac's workshop…", action: () => devices() }];
    const count = hubDevices.state()?.devices.length ?? 0;
    return [count
      ? { section: 'Sync', label: 'Devices', secondary: plural(count, 'device'), action: () => devices() }
      : { section: 'Sync', label: 'Pair a phone…', action: () => devices() }];
  };
  const items = (): MenuItem[] => [
    ...notebooks(),
    ...(EMBEDDED ? [] : [{ section: 'Workshops', label: 'Open or create…', action: () => props.onOpen({ kind: 'settings', section: 'notebooks' }) }]),
    ...syncRows(),
  ];
  return <>
    <Button class="notebook-switcher" aria-haspopup="menu" aria-expanded={anchor() !== null} title={current()?.display_path}
      aria-label={`Workshop: ${current() ? notebookLabel(current()!) : 'this workshop'}`}
      onClick={event => { void sync.refresh(); setAnchor(event.currentTarget); }}>
      <span class="notebook-switcher-name" classList={{ 'notebook-switcher-other': !!current() && !current()!.default }}>{current() ? notebookLabel(current()!) : 'Workshop'}</span>
      {/* The foot is too narrow for a chevron beside two icons; the menu is announced by aria-haspopup. */}
    </Button>
    <Show when={anchor()}>{target => <Menu anchor={target()} label="Workshop" items={items()} class="notebook-switcher-menu" onDismiss={() => setAnchor(null)} />}</Show>
  </>;
}
