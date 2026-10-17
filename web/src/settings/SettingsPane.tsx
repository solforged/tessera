import { For, Show, createEffect, createMemo, createResource, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import { api } from '../api/client';
import { ANDROID, DEMO, EMBEDDED } from '../demo/mode';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget, PaneId, SettingsViewState } from '../shell/contract';
import { besideHint, opensBeside } from '../shell/beside';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { setThemePreference, themePreference } from '../shell/theme';
import { size, sync } from '../sync/state';
import { backupLabel } from './backup';
import { HubDevices, PhoneDevices } from './DevicesSection';
import { BrowserBackups } from './BrowserBackups';
import { forgetNotebook, knownNotebooks, loadNotebooks, notebookLabel, notebookOpening, openNotebook } from './notebooks';
import { AgentSettings } from '../agent/AgentSettings';
import './settings.css';
import './devices.css';

export function SettingsPane(props: { pane: PaneId; view: SettingsViewState; section?: 'notebooks' | 'devices' | 'agent'; deviceId?: string | null; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void; onViewChange(view: SettingsViewState): void }) {
  const [error, setError] = createSignal('');
  const [info] = createResource(async () => {
    try { return await api.notebook(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  });
  const [service] = createResource(() => !EMBEDDED, async () => {
    try { return await api.service(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  });
  const [backups, { refetch: refreshBackups, mutate: updateBackups }] = createResource(() => !EMBEDDED, async () => {
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
  const [removingBackups, setRemovingBackups] = createSignal(false);
  const [confirmBackup, setConfirmBackup] = createSignal<string | null>(null);
  const backupBusy = () => backingUp() || removingBackups();
  const backupBytes = createMemo(() => backups()?.reduce((total, backup) => total + backup.size, 0) ?? 0);
  const olderBackups = createMemo(() => backups()?.slice(10) ?? []);
  const olderBytes = createMemo(() => olderBackups().reduce((total, backup) => total + backup.size, 0));
  const removeBackups = async (name?: string) => {
    if (backupBusy()) return;
    setRemovingBackups(true); setError('');
    try {
      updateBackups(name === undefined ? (await api.pruneBackups(10)).backups : await api.deleteBackup(name));
      setConfirmBackup(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRemovingBackups(false); }
  };
  const backUp = async () => {
    if (backupBusy()) return;
    setBackingUp(true); setError('');
    try { await api.createBackup(); await refreshBackups(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBackingUp(false); }
  };
  const [notebookPath, setNotebookPath] = createSignal('');
  const [forgetting, setForgetting] = createSignal<string | null>(null);
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  // A typed path goes by its last folder name while it opens.
  const switchTo = (path: string, create: boolean, label = path.split('/').filter(Boolean).at(-1) ?? path) => { setError(''); void openNotebook(props.notebook, path, create, label).catch(report); };
  const forget = async (path: string) => {
    if (forgetting()) return;
    setForgetting(path); setError('');
    try { await forgetNotebook(path); } catch (reason) { report(reason); } finally { setForgetting(null); }
  };
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const available = Intl.supportedValuesOf('timeZone');
  const zone = () => props.notebook.settings()?.time_zone ?? deviceZone;
  const zones = createMemo(() => [deviceZone, ...[...new Set([zone(), 'UTC', ...available])].filter(value => value !== deviceZone).sort()]);
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
    ...(DEMO && !ANDROID ? [{ key: 'backups', label: 'Backups', count: 0 }] : []),
    ...(EMBEDDED ? [] : [{ key: 'notebooks', label: 'Notebooks', count: knownNotebooks()?.notebooks.length ?? 0 }, { key: 'backups', label: 'Backups', count: backups()?.length ?? 0 }]),
    ...(devices ? [{ key: 'devices', label: 'Devices', count: deviceCount() }] : []),
    ...(DEMO ? [] : [{ key: 'agent', label: 'Agent', count: 0 }]),
    { key: 'agent-changes', label: 'Agent changes', count: agentChanges()?.length ?? 0 },
    { key: 'about', label: 'About', count: 0 },
  ]);
  const number = (key: string) => sections().findIndex(section => section.key === key) + 1;
  const sectionId = (key: string) => `settings-${key}-${props.pane}`;
  const [current, setCurrent] = createSignal('preferences');
  const [scrolled, setScrolled] = createSignal(false);
  const [allChanges, setAllChanges] = createSignal(false);
  // The index follows the last section whose heading has reached the sticky header, and the last section once the
  // pane can scroll no further. A section chosen from the index stays current until the reader scrolls by hand, since
  // the last sections may never reach the header.
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
    if (region.scrollTop > 0 && region.scrollTop + region.clientHeight >= region.scrollHeight - 1) key = sections().at(-1)!.key;
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
  createEffect(() => {
    const section = props.section;
    if (section) requestAnimationFrame(() => reveal(section));
  });
  onMount(() => {
    region.scrollTop = props.view.scroll;
    follow();
    void props.notebook.refreshSettings().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
    if (!EMBEDDED) void loadNotebooks().catch(report);
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
        {DEMO && !ANDROID && <BrowserBackups id={sectionId('backups')} heading={heading(number('backups'), 'backups', 'Backups')} when={when} onError={setError} />}
        {!EMBEDDED && <section id={sectionId('notebooks')} aria-labelledby={`${sectionId('notebooks')}-heading`} aria-busy={notebookOpening() !== null}>
          {heading(number('notebooks'), 'notebooks', 'Notebooks')}
          <For each={knownNotebooks()?.notebooks}>{entry => <div class="settings-row notebooks-entry" data-current={entry.current ? '' : undefined}>
            <div class="settings-label">
              <span class="settings-name">{notebookLabel(entry)}<Show when={entry.current}><span class="settings-scope">Open</span></Show></span>
              <p class="settings-mono notebooks-path">{entry.path}</p>
            </div>
            <Show when={!entry.current} fallback={<span />}>
              <span class="notebooks-actions">
                <Show when={!entry.default}><Button class="notebooks-forget" disabled={forgetting() !== null} onClick={() => { void forget(entry.path); }}>Forget</Button></Show>
                <Show when={entry.available} fallback={<span class="settings-aside">Folder missing</span>}>
                  <Button class="bordered" disabled={notebookOpening() !== null} onClick={() => switchTo(entry.path, false, notebookLabel(entry))}>Open</Button>
                </Show>
              </span>
            </Show>
          </div>}</For>
          <form class="settings-row notebooks-add" onSubmit={event => { event.preventDefault(); switchTo(notebookPath().trim(), false); }}>
            <div class="settings-label">
              <span class="settings-name"><label for={`settings-notebook-path-${props.pane}`}>Another notebook</label></span>
              <p>A folder’s full path. Open uses the notebook in it; New starts an empty notebook in a new or empty folder. This window reloads on the notebook you choose.</p>
              <input id={`settings-notebook-path-${props.pane}`} class="input notebooks-path-input" type="text" autocapitalize="off" autocomplete="off" spellcheck={false} placeholder="~/Notebooks/Clickaround" value={notebookPath()} disabled={notebookOpening() !== null} onInput={event => setNotebookPath(event.currentTarget.value)} />
            </div>
            <span class="notebooks-actions">
              <Button type="submit" class="bordered" disabled={!notebookPath().trim() || notebookOpening() !== null}>Open</Button>
              <Button class="bordered" disabled={!notebookPath().trim() || notebookOpening() !== null} onClick={() => switchTo(notebookPath().trim(), true)}>New</Button>
            </span>
          </form>
        </section>}
        {!EMBEDDED && <section id={sectionId('backups')} aria-labelledby={`${sectionId('backups')}-heading`} aria-busy={backupBusy()}>
          {heading(number('backups'), 'backups', 'Backups')}
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name">Database and files</span><Show when={backups()}>{values => <>
              <p role="status">{values()[0] ? `Last backup ${when(values()[0]!.created_at)}` : 'No backups yet.'}</p>
              <p class="settings-mono">{values().length} {values().length === 1 ? 'backup' : 'backups'} · {size(backupBytes())}</p>
            </>}</Show></div>
            <Button class="bordered" disabled={backupBusy()} onClick={() => { setConfirmBackup(null); void backUp(); }}>{backingUp() ? 'Backing up…' : 'Back up now'}</Button>
          </div>
          <Show when={olderBackups().length > 0}><div class="settings-row">
            <div class="settings-label"><span class="settings-name">Keep the latest 10</span>
              <p>{confirmBackup() === 'older' ? `Delete ${olderBackups().length} older ${olderBackups().length === 1 ? 'backup' : 'backups'} and free ${size(olderBytes())}? This cannot be undone.` : 'The newest backup is always kept as a restore point.'}</p>
            </div>
            <span class="settings-backup-actions"><Show when={confirmBackup() === 'older'} fallback={<Button class="bordered danger" disabled={backupBusy()} onClick={() => setConfirmBackup('older')}>Delete older backups</Button>}>
              <Button disabled={backupBusy()} onClick={() => setConfirmBackup(null)}>Cancel</Button>
              <Button class="bordered danger" disabled={backupBusy()} onClick={() => { void removeBackups(); }}>Confirm</Button>
            </Show></span>
          </div></Show>
          <Show when={(backups()?.length ?? 0) > 1}><details class="settings-more">
            <summary><Icon name="right" />{backups()!.length - 1} earlier {backups()!.length === 2 ? 'backup' : 'backups'}</summary>
            <ul><For each={backups()!.slice(1)}>{backup => <li class="settings-backup-row">
              <span>{backupLabel(backup)} · {size(backup.size)}</span>
              <span class="settings-backup-actions"><Show when={confirmBackup() === backup.path} fallback={<Button class="danger" disabled={backupBusy()} onClick={() => setConfirmBackup(backup.path)}>Delete</Button>}>
                <span class="settings-backup-question">Delete?</span>
                <Button disabled={backupBusy()} onClick={() => setConfirmBackup(null)}>Cancel</Button>
                <Button class="bordered danger" disabled={backupBusy()} onClick={() => { void removeBackups(backup.path.split('/').at(-1)!); }}>Confirm</Button>
              </Show></span>
            </li>}</For></ul>
          </details></Show>
        </section>}
        {devices && <section id={sectionId('devices')} aria-labelledby={`${sectionId('devices')}-heading`}>
          <Show when={ANDROID || sync.state()?.role === 'replica'} fallback={<HubDevices heading={heading(number('devices'), 'devices', 'Devices')} onError={setError} onCount={setDeviceCount} notebook={props.notebook} deviceId={props.deviceId} onOpenPage={pageId => props.onOpen({ kind: 'page', pageId }, false)} />}>
            <PhoneDevices heading={heading(number('devices'), 'devices', 'Devices')} onError={setError} notebook={props.notebook} deviceId={props.deviceId} onOpenPage={pageId => props.onOpen({ kind: 'page', pageId }, false)} />
          </Show>
        </section>}
        {!DEMO && <AgentSettings id={sectionId('agent')} heading={heading(number('agent'), 'agent', 'Agent')} />}
        <section id={sectionId('agent-changes')} aria-labelledby={`${sectionId('agent-changes')}-heading`} aria-busy={undoing() !== null}>
          {heading(number('agent-changes'), 'agent-changes', 'Agent changes')}
          <Show when={agentChanges()}>{values => <Show when={values().length > 0} fallback={<p class="settings-empty">No agent changes yet. When an agent edits this notebook, each change appears here with its own Undo.</p>}>
            <ol class="settings-changes">
              <For each={allChanges() ? values() : values().slice(0, 3)}>{change => <li class="settings-change" data-undone={change.undone_by === null ? undefined : ''}>
                <div class="settings-label">
                  <span class="settings-name">{change.summary}</span>
                  <p><span class="settings-mono">{change.actor.kind === 'person' ? 'Person' : change.actor.name} · <time dateTime={new Date(change.created_at).toISOString()}>{when(change.created_at)}</time></span>
                    <Show when={change.page}>{page => <><span class="settings-mono"> · </span><button type="button" class="settings-page-link" title={`Open page · ${besideHint}`} onClick={event => props.onOpen({ kind: 'page', pageId: page().id }, opensBeside(event))}>{page().text}</button></>}</Show>
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
