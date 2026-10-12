import { For, Show, createMemo, createResource, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import { api } from '../api/client';
import { ANDROID, EMBEDDED } from '../demo/mode';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget, PaneId, SettingsViewState } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { setThemePreference, themePreference } from '../shell/theme';
import { backupLabel } from './backup';
import { HubDevices, PhoneDevices } from './DevicesSection';
import './settings.css';
import './devices.css';

export function SettingsPane(props: { pane: PaneId; view: SettingsViewState; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void; onViewChange(view: SettingsViewState): void }) {
  const [error, setError] = createSignal('');
  const [info] = createResource(async () => {
    try { return await api.notebook(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  });
  const [service] = createResource(() => !EMBEDDED, async () => {
    try { return await api.service(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  });
  const [backups, { refetch: refreshBackups }] = createResource(() => !EMBEDDED, async () => {
    try { return await api.backups(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  });
  const [agentChanges, { refetch: refreshAgentChanges }] = createResource(() => props.notebook.changeSequence(), async () => {
    try { return await api.agentChanges(20); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  });
  const [undoing, setUndoing] = createSignal<number | null>(null);
  const undoAgentChange = async (seq: number) => {
    if (undoing() !== null) return;
    setUndoing(seq); setError('');
    try { await api.undoAgentChange(seq); await refreshAgentChanges(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setUndoing(null); }
  };
  const [backingUp, setBackingUp] = createSignal(false);
  const backUp = async () => {
    if (backingUp()) return;
    setBackingUp(true); setError('');
    try { await api.createBackup(); await refreshBackups(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBackingUp(false); }
  };
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const available = Intl.supportedValuesOf('timeZone');
  const zone = () => props.notebook.settings()?.time_zone ?? deviceZone;
  const zones = createMemo(() => [deviceZone, ...[...new Set([zone(), ...available])].filter(value => value !== deviceZone).sort()]);
  const [zoneAnchor, setZoneAnchor] = createSignal<HTMLElement | null>(null);
  const [zoneQuery, setZoneQuery] = createSignal('');
  const zoneRows = createMemo(() => {
    const needle = zoneQuery().trim().toLocaleLowerCase().replace(/ /g, '_');
    return zones().filter(value => value.toLocaleLowerCase().includes(needle));
  });
  let region!: HTMLDivElement;
  // Devices: the Mac shares and pairs; the phone copies. The browser demo does not sync.
  const devices = !EMBEDDED || ANDROID;
  const [deviceCount, setDeviceCount] = createSignal(0);
  const sections = createMemo(() => [
    { key: 'preferences', label: 'Preferences', count: 0 },
    ...(EMBEDDED ? [] : [{ key: 'backups', label: 'Backups', count: backups()?.length ?? 0 }]),
    ...(devices ? [{ key: 'devices', label: 'Devices', count: deviceCount() }] : []),
    { key: 'agent-changes', label: 'Agent changes', count: agentChanges()?.length ?? 0 },
    { key: 'about', label: 'About', count: 0 },
  ]);
  const number = (key: string) => sections().findIndex(section => section.key === key) + 1;
  const sectionId = (key: string) => `settings-${key}-${props.pane}`;
  const [current, setCurrent] = createSignal('preferences');
  const [scrolled, setScrolled] = createSignal(false);
  const [allChanges, setAllChanges] = createSignal(false);
  // The index follows the last section whose heading has reached the sticky header. A section chosen from the index
  // stays current until the reader scrolls by hand, since the last sections may never reach the header.
  const [chosen, setChosen] = createSignal<string | null>(null);
  const follow = () => {
    setScrolled(region.scrollTop > 0);
    if (chosen()) { setCurrent(chosen()!); return; }
    const header = region.querySelector<HTMLElement>('.settings-header')?.offsetHeight ?? 0;
    let key = sections()[0]!.key;
    for (const section of sections()) {
      const element = document.getElementById(sectionId(section.key));
      if (element && element.offsetTop - region.scrollTop <= header + 1) key = section.key;
    }
    setCurrent(key);
  };
  const release = () => { if (chosen()) { setChosen(null); follow(); } };
  const reveal = (key: string) => {
    const element = document.getElementById(sectionId(key));
    if (!element) return;
    setChosen(key); setCurrent(key);
    const header = region.querySelector<HTMLElement>('.settings-header')?.offsetHeight ?? 0;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    region.scrollTo({ top: element.offsetTop - header, behavior: smooth ? 'smooth' : 'auto' });
  };
  const when = (value: number) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(value);
  const heading = (index: number, key: string, label: string, aside?: JSX.Element) =>
    <h2 id={`${sectionId(key)}-heading`}><span class="section-number">{String(index).padStart(2, '0')}</span><span class="settings-section-name">{label}</span>{aside}<span class="section-rule" /></h2>;
  onMount(() => {
    region.scrollTop = props.view.scroll;
    follow();
    void props.notebook.refreshSettings().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  });
  const change = async (key: 'time_zone' | 'vim' | 'confirm_view_delete', value: string) => {
    setError('');
    try { await props.notebook.setSetting(key, value); }
    catch { /* The document owns the save error and retains acknowledged values. */ }
    // A rejected checkbox change must show the acknowledged value again.
    const checkbox = region.querySelector<HTMLInputElement>(`#settings-${key}-${props.pane}`);
    if (checkbox) checkbox.checked = key === 'vim' ? props.notebook.vim() : props.notebook.confirmViewDelete();
  };
  const history = async (redo: boolean) => {
    try { if (redo) await props.notebook.redoSetting(); else await props.notebook.undoSetting(); }
    catch { /* The document displays the revision conflict or save error. */ }
  };
  return <div ref={region} class="settings-pane" tabIndex={0} aria-label="Settings" onScroll={() => { props.onViewChange({ scroll: region.scrollTop }); follow(); }} onWheel={release} onTouchStart={release} onKeyDown={event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) release();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault(); void history(event.shiftKey);
    }
  }}>
    <div class="settings-layout">
      <nav class="settings-index" aria-label="Settings sections">
        <For each={sections()}>{section =>
          <button type="button" class="settings-index-item" aria-current={current() === section.key ? 'location' : undefined} onClick={() => reveal(section.key)}>
            <span>{section.label}</span><Show when={section.count > 0}><span class="settings-count">{section.count}</span></Show>
          </button>}</For>
      </nav>
      <div class="settings-main">
        <header class="settings-header" data-scrolled={scrolled() ? '' : undefined}>
          <div class="settings-heading">
            <div class="settings-register">Notebook and device</div>
            <h1>Settings</h1>
          </div>
          <span class="settings-status" role="status">{props.notebook.settingsMessage()}</span>
          <Button icon="undo" label="Undo setting" shortcut="⌘Z" disabled={!props.notebook.canUndoSetting()} onClick={() => { void history(false); }} />
          <Button icon="redo" label="Redo setting" shortcut="⌘⇧Z" disabled={!props.notebook.canRedoSetting()} onClick={() => { void history(true); }} />
        </header>
        <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
        <section id={sectionId('preferences')} aria-labelledby={`${sectionId('preferences')}-heading`}>
          {heading(1, 'preferences', 'Preferences')}
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name">Theme<span class="settings-scope">This device</span></span><p>Follows the system unless you choose light or dark.</p></div>
            <div class="mode-tabs settings-segments" role="group" aria-label="Theme">
              <For each={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const}>{([value, label]) =>
                <Button aria-pressed={themePreference() === value} onClick={() => setThemePreference(value)}>{label}</Button>}</For>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name"><label for={`settings-vim-${props.pane}`}>Vim keys</label><span class="settings-scope">Notebook</span></span><p>Normal, insert and visual modes inside a block; j and k move between blocks.</p></div>
            <input id={`settings-vim-${props.pane}`} class="settings-switch" type="checkbox" role="switch" checked={props.notebook.vim()} disabled={props.notebook.settingsBusy()} onChange={event => { void change('vim', String(event.currentTarget.checked)); }} />
          </div>
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name"><label for={`settings-confirm_view_delete-${props.pane}`}>Ask before deleting views</label><span class="settings-scope">Notebook</span></span><p>Library, task and table views.</p></div>
            <input id={`settings-confirm_view_delete-${props.pane}`} class="settings-switch" type="checkbox" role="switch" checked={props.notebook.confirmViewDelete()} disabled={props.notebook.settingsBusy()} onChange={event => { void change('confirm_view_delete', String(event.currentTarget.checked)); }} />
          </div>
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name">Journal day<span class="settings-scope">Notebook</span></span><p>Decides which day Today opens and when scheduled times fall.</p></div>
            <Button class="bordered settings-select" aria-label="Time zone" aria-haspopup="listbox" aria-expanded={zoneAnchor() !== null} disabled={props.notebook.settingsBusy()} onClick={event => setZoneAnchor(event.currentTarget)}>
              <span class="settings-select-text"><Show when={zone() === deviceZone}><span>Device</span></Show><span class="settings-mono">{zone()}</span></span><Icon name="down" />
            </Button>
          </div>
          <Show when={zoneAnchor()}>{anchor => <Picker<string> anchor={anchor()} width={360} label="Choose time zone" onDismiss={() => { setZoneAnchor(null); setZoneQuery(''); }}
            query={zoneQuery()} onQuery={setZoneQuery} placeholder="Search time zones"
            items={zoneRows()} key={value => value} empty="No matching time zone."
            onPick={value => { setZoneAnchor(null); setZoneQuery(''); void change('time_zone', value); }}
            row={value => <><Show when={value === zone()} fallback={<span class="icon" />}><Icon name="check" /></Show><span class="picker-text">{value === deviceZone ? `Device time zone (${deviceZone})` : value}</span></>} />}</Show>
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name">Reader display<span class="settings-scope">This device</span></span><p>Typeface, size, measure and Scroll or Pages are set in the reader, beside the text, so each change shows as you make it.</p></div>
            <span class="settings-aside">In the reader</span>
          </div>
        </section>
        {!EMBEDDED && <section id={sectionId('backups')} aria-labelledby={`${sectionId('backups')}-heading`} aria-busy={backingUp()}>
          {heading(2, 'backups', 'Backups')}
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name">Database and files</span><Show when={backups()}>{values => <p role="status">{values()[0] ? `Last backup ${when(values()[0]!.created_at)}` : 'No backups yet.'}</p>}</Show></div>
            <Button class="bordered" disabled={backingUp()} onClick={() => { void backUp(); }}>{backingUp() ? 'Backing up…' : 'Back up now'}</Button>
          </div>
          <Show when={(backups()?.length ?? 0) > 1}><details class="settings-more">
            <summary><Icon name="right" />{backups()!.length - 1} earlier {backups()!.length === 2 ? 'backup' : 'backups'}</summary>
            <ul><For each={backups()!.slice(1)}>{backup => <li>{backupLabel(backup)}</li>}</For></ul>
          </details></Show>
        </section>}
        {devices && <section id={sectionId('devices')} aria-labelledby={`${sectionId('devices')}-heading`}>
          {ANDROID
            ? <PhoneDevices heading={heading(number('devices'), 'devices', 'Devices')} onError={setError} />
            : <HubDevices heading={heading(number('devices'), 'devices', 'Devices')} onError={setError} onCount={setDeviceCount} />}
        </section>}
        <section id={sectionId('agent-changes')} aria-labelledby={`${sectionId('agent-changes')}-heading`} aria-busy={undoing() !== null}>
          {heading(number('agent-changes'), 'agent-changes', 'Agent changes')}
          <Show when={agentChanges()}>{values => <Show when={values().length > 0} fallback={<p class="settings-empty">No agent changes yet. When an agent edits this notebook, each change appears here with its own Undo.</p>}>
            <ol class="settings-changes">
              <For each={allChanges() ? values() : values().slice(0, 3)}>{change => <li class="settings-change" data-undone={change.undone_by === null ? undefined : ''}>
                <div class="settings-label">
                  <span class="settings-name">{change.summary}</span>
                  <p><span class="settings-mono">{change.actor.kind === 'person' ? 'Person' : change.actor.name} · <time dateTime={new Date(change.created_at).toISOString()}>{when(change.created_at)}</time></span>
                    <Show when={change.page}>{page => <><span class="settings-mono"> · </span><button type="button" class="settings-page-link" title="Open page · Shift to open beside" onClick={event => props.onOpen({ kind: 'page', pageId: page().id }, event.shiftKey)}>{page().text}</button></>}</Show>
                  </p>
                </div>
                <Show when={change.undone_by === null} fallback={<span class="settings-aside">Undone</span>}>
                  <Button class="bordered" disabled={undoing() !== null} onClick={() => { void undoAgentChange(change.seq); }}>{undoing() === change.seq ? 'Undoing…' : 'Undo'}</Button>
                </Show>
              </li>}</For>
            </ol>
            <Show when={values().length > 3}>
              <Button class="settings-show-more" aria-expanded={allChanges()} onClick={() => setAllChanges(value => !value)}><Icon name="right" />{allChanges() ? 'Show fewer' : `Show ${values().length - 3} earlier`}</Button>
            </Show>
          </Show>}</Show>
        </section>
        <section id={sectionId('about')} aria-labelledby={`${sectionId('about')}-heading`}>
          {heading(number('about'), 'about', 'About')}
          <Show when={info()}>{value => <dl>
            <dt>Notebook</dt><dd>{value().path}</dd>
            <dt>Created</dt><dd>{new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value().created_at)}</dd>
            <dt>Id</dt><dd>{value().id}</dd>
          </dl>}</Show>
          {!EMBEDDED && <Show when={service()}>{value => <dl>
            <dt>Version</dt><dd>{value().version}<Show when={value().build}>{build => <> · {build()}</>}</Show></dd>
            <dt>URL</dt><dd>{`http://127.0.0.1:${value().port}`}</dd>
            <dt>Assets</dt><dd>{value().assets}</dd>
            <dt>Launch agent</dt><dd>{value().launch_agent.installed ? 'Installed' : 'Not installed · run tessera install'}</dd>
          </dl>}</Show>}
        </section>
      </div>
    </div>
  </div>;
}
