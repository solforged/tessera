import { For, Show, createEffect, createMemo, createResource, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import { api } from '../api/client';
import type { Backups, HistoryEntry } from '../api/types';
import { DEMO, EMBEDDED, MOBILE } from '../demo/mode';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget, PaneId, SettingsViewState } from '../shell/contract';
import { besideHint, opensBeside } from '../shell/beside';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { setThemePreference, themePreference } from '../shell/theme';
import { hubDevices, size, sync } from '../sync/state';
import { backupLabel, backupStale } from './backup';
import { HubDevices, PhoneDevices } from './DevicesSection';
import { BrowserBackups } from './BrowserBackups';
import { forgetNotebook, knownNotebooks, loadNotebooks, notebookLabel, notebookOpening, notebookPlace, openNotebook, reloadNotebook, workshopName, workshopsHome } from './notebooks';
import { AgentSettings } from '../agent/AgentSettings';
import '../fields/field-page.css';
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
  const [historyError, setHistoryError] = createSignal('');
  const [hasMoreHistory, setHasMoreHistory] = createSignal(false);
  const [loadingHistory, setLoadingHistory] = createSignal(false);
  let historyGeneration = 0;
  const [history, { refetch: refreshHistory, mutate: updateHistory }] = createResource(() => props.notebook.changeSequence(), async () => {
    const generation = ++historyGeneration;
    setHistoryError('');
    try {
      const entries = await props.notebook.api.history();
      if (generation === historyGeneration) setHasMoreHistory(entries.length === 50);
      return entries;
    } catch (reason) {
      if (generation === historyGeneration) setHistoryError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    }
  });
  const showMoreHistory = async () => {
    const before = history()?.at(-1)?.seq;
    if (before === undefined || loadingHistory() || history.loading) return;
    const generation = historyGeneration;
    setLoadingHistory(true); setHistoryError('');
    try {
      const entries = await props.notebook.api.history(50, before);
      if (generation !== historyGeneration) return;
      updateHistory(values => [...(values ?? []), ...entries]);
      setHasMoreHistory(entries.length === 50);
    } catch (reason) {
      if (generation === historyGeneration) setHistoryError(reason instanceof Error ? reason.message : String(reason));
    } finally { setLoadingHistory(false); }
  };
  const [undoing, setUndoing] = createSignal<number | null>(null);
  const undoChange = async (seq: number) => {
    if (undoing() !== null) return;
    setUndoing(seq); setHistoryError('');
    try { await props.notebook.api.undoChange(seq); await refreshHistory(); }
    catch (reason) { setHistoryError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setUndoing(null); }
  };
  const historyActor = (entry: HistoryEntry) => {
    const replica = sync.state()?.replica;
    const remote = entry.origin && hubDevices.state()?.devices.find(device => device.id === entry.origin);
    if (remote) return remote.name || 'Phone';
    if (entry.origin && replica && entry.origin !== replica.device_id) return entry.origin;
    if (entry.actor.kind === 'agent') return 'Agent';
    return entry.actor.kind === 'person' || entry.actor.name.startsWith('tessera-web') ? 'You' : entry.actor.name;
  };
  const [backingUp, setBackingUp] = createSignal(false);
  const [removingBackups, setRemovingBackups] = createSignal(false);
  const [restoringBackup, setRestoringBackup] = createSignal(false);
  const [confirmBackup, setConfirmBackup] = createSignal<string | null>(null);
  // Back up now with nothing changed since the newest backup makes none; the status says so.
  const [unchanged, setUnchanged] = createSignal(false);
  const backupBusy = () => backingUp() || removingBackups() || restoringBackup();
  const otherBytes = createMemo(() => backups()?.others.reduce((total, other) => total + other.size, 0) ?? 0);
  // The newest change's time tells a stale backup from an unchanged workshop.
  const [latestChange] = createResource(() => !EMBEDDED && props.notebook.changeSequence(), async () => {
    try { return (await props.notebook.api.history(1))[0]?.created_at; }
    catch { return undefined; }
  });
  const removeBackups = async (remove: () => Promise<Backups>) => {
    if (backupBusy()) return;
    setRemovingBackups(true); setError('');
    try { updateBackups(await remove()); setConfirmBackup(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRemovingBackups(false); }
  };
  const backUp = async () => {
    if (backupBusy()) return;
    setBackingUp(true); setError(''); setUnchanged(false);
    try { const result = await api.createBackup(); updateBackups(result.backups); setUnchanged(!result.created); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBackingUp(false); }
  };
  const restoreBackup = async (name: string) => {
    if (backupBusy()) return;
    setRestoringBackup(true); setError('');
    try {
      const current = await api.notebook();
      await api.restoreBackup(name);
      setConfirmBackup(null);
      await reloadNotebook(current.path, 'The restored workshop');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setRestoringBackup(false);
    }
  };
  const [notebookPath, setNotebookPath] = createSignal('');
  const [forgetting, setForgetting] = createSignal<string | null>(null);
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  // A typed name or path goes by its last folder name while it opens.
  const switchTo = (path: string, create: boolean, label = workshopName(path.split('/').filter(Boolean).at(-1) ?? path)) => { setError(''); void openNotebook(props.notebook, path, create, label).catch(report); };
  const forget = async (path: string) => {
    if (forgetting()) return;
    setForgetting(path); setError('');
    try { await forgetNotebook(path); } catch (reason) { report(reason); } finally { setForgetting(null); }
  };
  const aliases: Record<string, string> = {
    'Africa/Asmera': 'Africa/Asmara', 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu',
    'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kiev': 'Europe/Kyiv',
    'America/Godthab': 'America/Nuuk', 'Pacific/Truk': 'Pacific/Chuuk', 'Pacific/Ponape': 'Pacific/Pohnpei', 'Pacific/Enderbury': 'Pacific/Kanton',
  };
  const canonicalZone = (value: string) => {
    const canonical = aliases[value] ?? new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
    return aliases[canonical] ?? canonical;
  };
  const deviceZone = canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const available = Intl.supportedValuesOf('timeZone').map(value => aliases[value] ?? value);
  const zone = createMemo(() => canonicalZone(props.notebook.settings()?.time_zone ?? deviceZone));
  const [zoneTime, setZoneTime] = createSignal(Date.now());
  const zoneLabel = (value: string) => {
    const offset = new Intl.DateTimeFormat('en', { timeZone: value, timeZoneName: 'shortOffset' }).formatToParts(zoneTime()).find(part => part.type === 'timeZoneName')!.value;
    const city = value === 'UTC' ? 'Coordinated Universal Time' : value.split('/').at(-1)!.replace(/_/g, ' ');
    return `${city} · ${offset.replace(/^GMT/, 'UTC').replace('-', '−')}${offset === 'GMT' || offset === 'UTC' ? '+0' : ''}`;
  };
  const zones = createMemo(() => {
    const rows = [...new Set([zone(), 'UTC', ...available])].filter(id => id !== deviceZone).map(id => ({ id, label: zoneLabel(id) }));
    return [{ id: deviceZone, label: zoneLabel(deviceZone) }, ...rows.sort((a, b) => a.label.localeCompare(b.label))];
  });
  const [zoneAnchor, setZoneAnchor] = createSignal<HTMLElement | null>(null);
  const [zoneQuery, setZoneQuery] = createSignal('');
  const zoneRows = createMemo(() => {
    const needle = zoneQuery().trim().toLocaleLowerCase().replace(/_/g, ' ');
    return zones().filter(value => `${value.label} ${value.id} ${value.id === deviceZone ? 'device' : ''}`.toLocaleLowerCase().replace(/_/g, ' ').includes(needle));
  });
  let region!: HTMLDivElement;
  // Devices: the Mac shares and pairs; the phone copies. The browser demo does not sync.
  const devices = !EMBEDDED || MOBILE;
  const [deviceCount, setDeviceCount] = createSignal(0);
  const sections = createMemo(() => [
    { key: 'preferences', label: 'Preferences', count: 0 },
    ...(DEMO && !MOBILE ? [{ key: 'backups', label: 'Backups', count: 0 }] : []),
    ...(EMBEDDED ? [] : [{ key: 'notebooks', label: 'Workshops', count: knownNotebooks()?.notebooks.length ?? 0 }, { key: 'backups', label: 'Backups', count: backups()?.backups.length ?? 0 }]),
    ...(devices ? [{ key: 'devices', label: 'Devices', count: deviceCount() }] : []),
    ...(DEMO ? [] : [{ key: 'agent', label: 'Models', count: 0 }]),
    { key: 'history', label: 'History', count: history()?.length ?? 0 },
    { key: 'about', label: 'About', count: 0 },
  ]);
  const number = (key: string) => sections().findIndex(section => section.key === key) + 1;
  const sectionId = (key: string) => `settings-${key}-${props.pane}`;
  const [current, setCurrent] = createSignal('preferences');
  const [scrolled, setScrolled] = createSignal(false);
  // A chosen section stays current until manual scrolling, since the last sections may not reach the header.
  const [chosen, setChosen] = createSignal<string | null>(null);
  const stickyHeaderHeight = () => {
    const header = region.querySelector<HTMLElement>('.settings-header');
    return header && getComputedStyle(header).position === 'sticky' ? header.offsetHeight : 0;
  };
  const follow = () => {
    setScrolled(region.scrollTop > 0);
    if (chosen()) { setCurrent(chosen()!); return; }
    const header = stickyHeaderHeight();
    let key = sections()[0]!.key;
    for (const section of sections()) {
      const element = document.getElementById(sectionId(section.key));
      if (element && element.getBoundingClientRect().top - region.getBoundingClientRect().top <= header + 1) key = section.key;
    }
    if (region.scrollTop > 0 && region.scrollTop + region.clientHeight >= region.scrollHeight - 1) key = sections().at(-1)!.key;
    setCurrent(key);
  };
  const release = () => { if (chosen()) { setChosen(null); follow(); } };
  const reveal = (key: string) => {
    const element = document.getElementById(sectionId(key));
    if (!element) return;
    setChosen(key); setCurrent(key);
    const header = stickyHeaderHeight();
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top = element.getBoundingClientRect().top - region.getBoundingClientRect().top + region.scrollTop - header;
    region.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  };
  const when = (value: number) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  };
  const heading = (index: number, key: string, label: string, aside?: JSX.Element) =>
    <h2 class="field-section-head" id={`${sectionId(key)}-heading`}><span class="field-rubric">{String(index).padStart(2, '0')}</span><span>{label}</span><span class="section-rule" />{aside}</h2>;
  const pathText = (value: string) => value.split('/').map((part, index) => <>{index > 0 && <>/<wbr /></>}{part}</>);
  createEffect(() => {
    const key = current();
    queueMicrotask(() => {
      const chips = region.querySelector<HTMLElement>('.settings-index');
      const selected = chips?.querySelector<HTMLElement>(`[data-section="${key}"]`);
      if (!chips || !selected) return;
      if (selected.offsetLeft < chips.scrollLeft) chips.scrollLeft = selected.offsetLeft;
      else if (selected.offsetLeft + selected.offsetWidth > chips.scrollLeft + chips.clientWidth) chips.scrollLeft = selected.offsetLeft + selected.offsetWidth - chips.clientWidth;
    });
  });
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
  const settingHistory = async (redo: boolean) => {
    try { if (redo) await props.notebook.redoSetting(); else await props.notebook.undoSetting(); }
    catch { /* The document displays the revision conflict or save error. */ }
  };
  return <div ref={region} class="settings-pane" tabIndex={0} aria-label="Settings" onScroll={() => { props.onViewChange({ scroll: region.scrollTop }); follow(); }} onWheel={release} onTouchStart={release} onKeyDown={event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) release();
    // Text fields keep their own undo; the pane's ⌘Z undoes settings everywhere else.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLElement && event.target.closest('input:not([type="checkbox"]), textarea, [contenteditable="true"]'))) {
      event.preventDefault(); void settingHistory(event.shiftKey);
    }
  }}>
    <div class="settings-layout">
      <div class="settings-main">
        <header class="settings-header" data-scrolled={scrolled() ? '' : undefined}>
          <div class="settings-heading"><h1>Settings</h1></div>
          <span class="settings-status" role="status">{props.notebook.settingsMessage()}</span>
          <Button icon="undo" label="Undo setting" shortcut="⌘Z" disabled={!props.notebook.canUndoSetting()} onClick={() => { void settingHistory(false); }} />
          <Button icon="redo" label="Redo setting" shortcut="⌘⇧Z" disabled={!props.notebook.canRedoSetting()} onClick={() => { void settingHistory(true); }} />
          <nav class="settings-index" aria-label="Settings sections">
            <For each={sections()}>{section => <button type="button" class="settings-index-item" data-section={section.key} aria-current={current() === section.key ? 'location' : undefined} onClick={() => reveal(section.key)}>
              <span>{section.label}</span><Show when={section.count > 0}><span class="settings-count">{section.count}</span></Show>
            </button>}</For>
          </nav>
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
          <div class="settings-row settings-vim">
            <div class="settings-label"><span class="settings-name"><label for={`settings-vim-${props.pane}`}>Vim keys</label><span class="settings-scope">Workshop</span></span><p>Normal, insert and visual modes inside an atom; j and k move between atoms.</p></div>
            <input id={`settings-vim-${props.pane}`} class="settings-switch" type="checkbox" role="switch" checked={props.notebook.vim()} disabled={props.notebook.settingsBusy()} onChange={event => { void change('vim', String(event.currentTarget.checked)); }} />
          </div>
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name"><label for={`settings-confirm_view_delete-${props.pane}`}>Ask before deleting views</label><span class="settings-scope">Workshop</span></span><p>Library, task and table views.</p></div>
            <input id={`settings-confirm_view_delete-${props.pane}`} class="settings-switch" type="checkbox" role="switch" checked={props.notebook.confirmViewDelete()} disabled={props.notebook.settingsBusy()} onChange={event => { void change('confirm_view_delete', String(event.currentTarget.checked)); }} />
          </div>
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name">Journal day<span class="settings-scope">Workshop</span></span><p>Decides which day Today opens and when scheduled times fall.</p></div>
            <Button class="bordered settings-select" aria-label="Time zone" aria-haspopup="listbox" aria-expanded={zoneAnchor() !== null} disabled={props.notebook.settingsBusy()} title={zone()} onClick={event => { setZoneTime(Date.now()); setZoneAnchor(event.currentTarget); }}>
              <span class="settings-select-text"><Show when={zone() === deviceZone}><span>Device</span></Show><span class="settings-mono">{zones().find(value => value.id === zone())?.label}</span></span><Icon name="down" />
            </Button>
          </div>
          <Show when={zoneAnchor()}>{anchor => <Picker<{ id: string; label: string }> anchor={anchor()} placement="below" class="settings-zone-picker" width={360} label="Choose time zone" onDismiss={() => { setZoneAnchor(null); setZoneQuery(''); }}
            query={zoneQuery()} onQuery={setZoneQuery} placeholder="Search time zones"
            items={zoneRows()} key={value => value.id} isCurrent={value => value.id === zone()} empty="No matching time zone."
            onPick={value => { setZoneAnchor(null); setZoneQuery(''); void change('time_zone', value.id); }}
            row={value => <><Show when={value.id === zone()} fallback={<span class="icon" />}><Icon name="check" /></Show><span class="settings-zone-text"><span>{value.label}</span><span class="settings-zone-id">{value.id}{value.id === deviceZone ? ' · Device' : ''}</span></span></>} />}</Show>
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name">Reader display<span class="settings-scope">This device</span></span><p>In the reader: typeface, size, measure and Scroll or Pages are set beside the text, so each change shows as you make it.</p></div>
            <span />
          </div>
        </section>
        {DEMO && !MOBILE && <BrowserBackups id={sectionId('backups')} heading={heading(number('backups'), 'backups', 'Backups')} when={when} onError={setError} />}
        {!EMBEDDED && <section id={sectionId('notebooks')} aria-labelledby={`${sectionId('notebooks')}-heading`} aria-busy={notebookOpening() !== null}>
          {heading(number('notebooks'), 'notebooks', 'Workshops')}
          <Show when={workshopsHome()}>{home => <p class="settings-empty">Workshops made by name live in <span class="settings-mono settings-path">{pathText(home())}</span>. Opening one reloads this window.</p>}</Show>
          <For each={knownNotebooks()?.notebooks}>{entry => <div class="settings-row notebooks-entry" data-current={entry.current ? '' : undefined}>
            <div class="settings-label">
              <span class="settings-name">{notebookLabel(entry)}<Show when={entry.current}><span class="settings-scope">Open</span></Show></span>
              <Show when={!entry.available ? entry.display_path : notebookPlace(entry)}>{place => <p class="settings-mono notebooks-path settings-path" title={entry.path}>{pathText(place())}</p>}</Show>
              <Show when={!entry.available && entry.default}><p>Move the folder back or open it from its new location below.</p></Show>
            </div>
            <Show when={!entry.current} fallback={<span />}>
              <span class="notebooks-actions">
                <Show when={!entry.default}><Button class="notebooks-forget" disabled={forgetting() !== null} title={forgetting() !== null ? 'Wait for the workshop list to finish updating.' : 'Remove from this list; the workshop folder is not deleted.'} onClick={() => { void forget(entry.path); }}>Forget</Button></Show>
                <Show when={entry.available} fallback={<span class="settings-aside">Folder missing</span>}>
                  <Button class="bordered" disabled={notebookOpening() !== null} onClick={() => switchTo(entry.path, false, notebookLabel(entry))}>Open</Button>
                </Show>
              </span>
            </Show>
          </div>}</For>
          <form class="settings-row notebooks-add" onSubmit={event => { event.preventDefault(); switchTo(notebookPath().trim(), false); }}>
            <div class="settings-label">
              <span class="settings-name"><label for={`settings-notebook-path-${props.pane}`}>Open or create</label></span>
              <p>A name, such as reading, or a folder anywhere, such as <span class="settings-path">{pathText('~/Documents/reading')}</span>. Open uses a workshop that is there; New starts an empty one.</p>
              <input id={`settings-notebook-path-${props.pane}`} class="input notebooks-path-input" type="text" autocapitalize="off" autocomplete="off" spellcheck={false} placeholder="reading" value={notebookPath()} disabled={notebookOpening() !== null} onInput={event => setNotebookPath(event.currentTarget.value)} />
            </div>
            <span class="notebooks-actions">
              <Button type="submit" class="bordered" disabled={!notebookPath().trim() || notebookOpening() !== null}>Open</Button>
              <Button class="bordered" disabled={!notebookPath().trim() || notebookOpening() !== null} onClick={() => switchTo(notebookPath().trim(), true)}>New</Button>
            </span>
          </form>
        </section>}
        {!EMBEDDED && <section id={sectionId('backups')} aria-labelledby={`${sectionId('backups')}-heading`} aria-busy={backupBusy()}>
          {heading(number('backups'), 'backups', 'Backups')}
          <p class="settings-empty">This workshop is backed up once a day and before each update, unless nothing has changed. One a day is kept for a week and one a week for a month, with the copies taken before an update or restore kept for a week.</p>
          <div class="settings-row">
            <div class="settings-label"><span class="settings-name">Database and files</span><Show when={backups()}>{value => <>
              <p role="status"><Show when={!restoringBackup()} fallback="Restoring…"><Show when={value().backups[0]} fallback="No backups yet.">{backup => <>Last backup <time class="settings-mono" dateTime={new Date(backup().created_at).toISOString()}>{when(backup().created_at)}</time>{unchanged() ? '; nothing has changed since' : ''}</>}</Show></Show></p>
              <p class="settings-mono">{value().backups.length} {value().backups.length === 1 ? 'backup' : 'backups'} · {size(value().store_size)}</p>
              <Show when={value().automatic_failure} fallback={<Show when={backupStale(value().backups[0]?.created_at, latestChange(), Date.now())}>
                <p class="settings-warning" role="alert">The workshop has changed, but the newest backup is more than two days old.</p>
              </Show>}>{failure => <p class="settings-warning" role="alert">The automatic backup failed at <time class="settings-mono" dateTime={new Date(failure().at).toISOString()}>{when(failure().at)}</time>: {failure().message}</p>}</Show>
            </>}</Show></div>
            <Button class="bordered" disabled={backupBusy()} onClick={() => { setConfirmBackup(null); void backUp(); }}>{backingUp() ? 'Backing up…' : 'Back up now'}</Button>
          </div>
          <Show when={(backups()?.backups.length ?? 0) > 0}><details class="settings-more">
            <summary><Icon name="right" />Stored backups</summary>
            <ul><For each={backups()!.backups}>{(backup, index) => <li class="settings-backup-row">
              <div><span>{backupLabel(backup, when)} · {size(backup.size)}{index() === 0 ? ' · newest' : ''}</span>
                <Show when={confirmBackup() === `restore:${backup.path}`}><p class="settings-empty">Replace the workshop with this backup? A backup of the current workshop is taken first. Paired phones keep changes made since then until they sync again.</p></Show>
              </div>
              <span class="settings-backup-actions"><Show when={confirmBackup() === backup.path || confirmBackup() === `restore:${backup.path}`} fallback={<>
                <Button disabled={backupBusy()} onClick={() => setConfirmBackup(`restore:${backup.path}`)}>Restore</Button>
                <Show when={index() > 0}><Button class="danger" disabled={backupBusy()} onClick={() => setConfirmBackup(backup.path)}>Delete</Button></Show>
              </>}>
                <Show when={confirmBackup() === backup.path}><span class="settings-backup-question">Delete?</span></Show>
                <Button disabled={backupBusy()} onClick={() => setConfirmBackup(null)}>Cancel</Button>
                <Button class="bordered danger" disabled={backupBusy()} onClick={() => { void (confirmBackup() === backup.path ? removeBackups(() => api.deleteBackup(backup.name)) : restoreBackup(backup.name)); }}>Confirm</Button>
              </Show></span>
            </li>}</For></ul>
          </details></Show>
          {/* Backups of workshops other than this one, including ones no longer on the list, until deleted here. */}
          <Show when={backups()?.others.length}><details class="settings-more">
            <summary><Icon name="right" />Other workshops · {size(otherBytes())}</summary>
            <ul><For each={backups()!.others}>{other => <li class="settings-backup-row">
              <span title={other.path}>{other.name ? workshopName(other.name) : `${other.workshop_id.slice(0, 10)}…`} · {other.count} {other.count === 1 ? 'backup' : 'backups'}{other.newest_at === null ? '' : ` · newest ${when(other.newest_at)}`} · {size(other.size)}</span>
              <span class="settings-backup-actions"><Show when={confirmBackup() === other.path} fallback={<Button class="danger" disabled={backupBusy()} onClick={() => setConfirmBackup(other.path)}>Delete</Button>}>
                <span class="settings-backup-question">Delete all?</span>
                <Button disabled={backupBusy()} onClick={() => setConfirmBackup(null)}>Cancel</Button>
                <Button class="bordered danger" disabled={backupBusy()} onClick={() => { void removeBackups(() => api.deleteOtherBackups(other.workshop_id)); }}>Confirm</Button>
              </Show></span>
            </li>}</For></ul>
          </details></Show>
        </section>}
        {devices && <section id={sectionId('devices')} aria-labelledby={`${sectionId('devices')}-heading`}>
          <Show when={MOBILE || sync.state()?.role === 'replica'} fallback={<HubDevices heading={heading(number('devices'), 'devices', 'Devices')} when={when} onError={setError} onCount={setDeviceCount} notebook={props.notebook} deviceId={props.deviceId} onOpenPage={pageId => props.onOpen({ kind: 'page', pageId }, false)} />}>
            <PhoneDevices heading={heading(number('devices'), 'devices', 'Devices')} when={when} onError={setError} notebook={props.notebook} deviceId={props.deviceId} onOpenPage={pageId => props.onOpen({ kind: 'page', pageId }, false)} />
          </Show>
        </section>}
        {!DEMO && <AgentSettings id={sectionId('agent')} heading={heading(number('agent'), 'agent', 'Models')} />}
        <section id={sectionId('history')} aria-labelledby={`${sectionId('history')}-heading`} aria-busy={history.loading || loadingHistory() || undoing() !== null}>
          {heading(number('history'), 'history', 'History')}
          <Show when={historyError()}>{message => <p class="error" role="alert">{message()}</p>}</Show>
          <Show when={history()}>{values => <Show when={values().length > 0} fallback={<p class="settings-empty">No changes yet. Edits to this workshop appear here with their author and Undo when available.</p>}>
            <ol class="settings-changes">
              <For each={values()}>{change => <li class="settings-change" data-undone={change.undone_by === null ? undefined : ''}>
                <div class="settings-label">
                  <span class="settings-name">{change.summary}</span>
                  <p><span class="settings-mono">{historyActor(change)} · <time dateTime={new Date(change.created_at).toISOString()}>{when(change.created_at)}</time></span>
                    <Show when={change.page}>{page => <><span class="settings-mono"> · </span><button type="button" class="settings-page-link" title={`Open atom · ${besideHint}`} onClick={event => props.onOpen({ kind: 'page', pageId: page().id }, opensBeside(event))}>{page().text}</button></>}</Show>
                  </p>
                </div>
                <Show when={change.undoable} fallback={<Show when={change.undone_by !== null}><span class="settings-aside">Undone</span></Show>}>
                  <Button class="bordered" disabled={undoing() !== null || history.loading || loadingHistory()} onClick={() => { void undoChange(change.seq); }}>{undoing() === change.seq ? 'Undoing…' : 'Undo'}</Button>
                </Show>
              </li>}</For>
            </ol>
            <Show when={hasMoreHistory()}>
              <Button class="settings-show-more" disabled={history.loading || loadingHistory() || undoing() !== null} onClick={() => { void showMoreHistory(); }}><Icon name="right" />{loadingHistory() ? 'Loading…' : 'Show more'}</Button>
            </Show>
          </Show>}</Show>
        </section>
        <section id={sectionId('about')} aria-labelledby={`${sectionId('about')}-heading`}>
          {heading(number('about'), 'about', 'About')}
          <Show when={info()}>{value => <dl>
            <dt>Workshop</dt><dd class="settings-path">{pathText(value().path)}</dd>
            <dt>Created</dt><dd>{new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value().created_at)}</dd>
            <dt>Id</dt><dd>{value().id}</dd>
          </dl>}</Show>
          {!EMBEDDED && <Show when={service()}>{value => <dl>
            <dt>Version</dt><dd>{value().version}<Show when={value().build}>{build => <> · {build()}</>}</Show></dd>
            <dt>URL</dt><dd class="settings-path">{pathText(`http://127.0.0.1:${value().port}`)}</dd>
            <dt>Assets</dt><dd class="settings-path">{pathText(value().assets)}</dd>
            <dt>Launch agent</dt><dd>{value().launch_agent.installed ? 'Installed' : 'Not installed'}<Show when={!value().launch_agent.installed}><span class="settings-hint">Opening Tessera.app installs it.</span></Show></dd>
          </dl>}</Show>}
        </section>
      </div>
    </div>
  </div>;
}
