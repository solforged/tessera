import { For, Show, createMemo, createResource, createSignal, onMount } from 'solid-js';
import { api } from '../api/client';
import { EMBEDDED } from '../demo/mode';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget, PaneId, SettingsViewState } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { setThemePreference, themePreference } from '../shell/theme';
import { backupLabel } from './backup';
import './settings.css';

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
  onMount(() => {
    region.scrollTop = props.view.scroll;
    void props.notebook.refreshSettings().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  });
  const change = async (key: 'time_zone' | 'vim', value: string) => {
    setError('');
    try { await props.notebook.setSetting(key, value); }
    catch { /* The document owns the save error and retains acknowledged values. */ }
    // A rejected checkbox change must show the acknowledged value again.
    const checkbox = region.querySelector('input[type="checkbox"]') as HTMLInputElement | null; if (checkbox) checkbox.checked = props.notebook.vim();
  };
  const history = async (redo: boolean) => {
    try { if (redo) await props.notebook.redoSetting(); else await props.notebook.undoSetting(); }
    catch { /* The document displays the revision conflict or save error. */ }
  };
  return <div ref={region} class="settings-pane" tabIndex={0} aria-label="Settings" onScroll={() => props.onViewChange({ scroll: region.scrollTop })} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault(); void history(event.shiftKey);
    }
  }}>
    <header class="settings-header">
      <div class="settings-heading">
        <div class="settings-register">Notebook and device</div>
        <h1>Settings</h1>
      </div>
      <span class="settings-status" role="status">{props.notebook.settingsMessage()}</span>
      <Button icon="undo" label="Undo setting" shortcut="⌘Z" disabled={!props.notebook.canUndoSetting()} onClick={() => { void history(false); }} />
      <Button icon="redo" label="Redo setting" shortcut="⌘⇧Z" disabled={!props.notebook.canRedoSetting()} onClick={() => { void history(true); }} />
    </header>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <section aria-labelledby={`settings-appearance-${props.pane}`}>
      <h2 id={`settings-appearance-${props.pane}`}><span class="section-number">01</span>Appearance<span class="section-rule" /></h2>
      <div class="settings-row">
        <div class="settings-label">Theme<p>Applies to this device only.</p></div>
        <div class="mode-tabs" role="group" aria-label="Theme">
          <For each={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const}>{([value, label]) =>
            <Button aria-pressed={themePreference() === value} onClick={() => setThemePreference(value)}>{label}</Button>}</For>
        </div>
      </div>
    </section>
    <section aria-labelledby={`settings-editing-${props.pane}`}>
      <h2 id={`settings-editing-${props.pane}`}><span class="section-number">02</span>Editing<span class="section-rule" /></h2>
      <div class="settings-row">
        <div class="settings-label"><label for={`settings-vim-${props.pane}`}>Vim keys</label><p>Normal, insert and visual modes inside a block; j and k move between blocks.</p></div>
        <input id={`settings-vim-${props.pane}`} class="settings-switch" type="checkbox" checked={props.notebook.vim()} disabled={props.notebook.settingsBusy()} onChange={event => { void change('vim', String(event.currentTarget.checked)); }} />
      </div>
    </section>
    <section aria-labelledby={`settings-zone-${props.pane}`}>
      <h2 id={`settings-zone-${props.pane}`}><span class="section-number">03</span>Time zone<span class="section-rule" /></h2>
      <div class="settings-row">
        <div class="settings-label">Journal day<p>Decides which day Today opens and when scheduled times fall.</p></div>
        <Button class="bordered" aria-label="Time zone" aria-haspopup="listbox" disabled={props.notebook.settingsBusy()} onClick={event => setZoneAnchor(event.currentTarget)}>{zone() === deviceZone ? `Device (${deviceZone})` : zone()} <Icon name="down" /></Button>
      </div>
      <Show when={zoneAnchor()}>{anchor => <Picker<string> anchor={anchor()} width={360} label="Choose time zone" onDismiss={() => { setZoneAnchor(null); setZoneQuery(''); }}
        query={zoneQuery()} onQuery={setZoneQuery} placeholder="Search time zones"
        items={zoneRows()} key={value => value} empty="No matching time zone."
        onPick={value => { setZoneAnchor(null); setZoneQuery(''); void change('time_zone', value); }}
        row={value => <><Show when={value === zone()} fallback={<span class="icon" />}><Icon name="check" /></Show><span class="picker-text">{value === deviceZone ? `Device time zone (${deviceZone})` : value}</span></>} />}</Show>
    </section>
    {!EMBEDDED && <section aria-labelledby={`settings-backups-${props.pane}`} aria-busy={backingUp()}>
      <h2 id={`settings-backups-${props.pane}`}><span class="section-number">04</span>Backups<span class="section-rule" /></h2>
      <div class="settings-row">
        <div class="settings-label">Database and files<Show when={backups()}>{values => <p role="status">{values()[0] ? `Last backup ${backupLabel(values()[0]!)}` : 'No backups yet.'}</p>}</Show></div>
        <Button class="bordered" disabled={backingUp()} onClick={() => { void backUp(); }}>{backingUp() ? 'Backing up…' : 'Back up now'}</Button>
      </div>
      <Show when={(backups()?.length ?? 0) > 1}><details class="settings-more">
        <summary>{backups()!.length - 1} earlier {backups()!.length === 2 ? 'backup' : 'backups'}</summary>
        <ul><For each={backups()!.slice(1)}>{backup => <li>{backupLabel(backup)}</li>}</For></ul>
      </details></Show>
    </section>}
    <section aria-labelledby={`settings-agent-changes-${props.pane}`} aria-busy={undoing() !== null}>
      <h2 id={`settings-agent-changes-${props.pane}`}><span class="section-number">{EMBEDDED ? '04' : '05'}</span>Agent changes<span class="section-rule" /></h2>
      <Show when={agentChanges()}>{values => <Show when={values().length > 0} fallback={<p class="settings-empty">No agent changes yet.</p>}>
        <For each={values().slice(0, 20)}>{change => <div class="settings-row settings-agent-change">
          <div class="settings-label">{change.summary}
            <p>{change.actor.kind === 'person' ? 'Person' : change.actor.name} · <time dateTime={new Date(change.created_at).toISOString()}>{new Date(change.created_at).toLocaleString()}</time>
              <Show when={change.page}>{page => <> · <button type="button" class="settings-page-link" title="Open page · Shift to open beside" onClick={event => props.onOpen({ kind: 'page', pageId: page().id }, event.shiftKey)}>{page().text}</button></>}</Show>
            </p>
          </div>
          <Show when={change.undone_by === null} fallback={<span class="settings-undone">Undone</span>}>
            <Button class="bordered" disabled={undoing() !== null} onClick={() => { void undoAgentChange(change.seq); }}>{undoing() === change.seq ? 'Undoing…' : 'Undo'}</Button>
          </Show>
        </div>}</For>
      </Show>}</Show>
    </section>
    <section aria-labelledby={`settings-notebook-${props.pane}`}>
      <h2 id={`settings-notebook-${props.pane}`}><span class="section-number">{EMBEDDED ? '05' : '06'}</span>Notebook<span class="section-rule" /></h2>
      <Show when={info()}>{value => <dl>
        <dt>Path</dt><dd>{value().path}</dd>
        <dt>Created</dt><dd>{new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value().created_at)}</dd>
        <dt>Id</dt><dd>{value().id}</dd>
      </dl>}</Show>
    </section>
    {!EMBEDDED && <section aria-labelledby={`settings-service-${props.pane}`}>
      <h2 id={`settings-service-${props.pane}`}><span class="section-number">07</span>Service<span class="section-rule" /></h2>
      <Show when={service()}>{value => <dl>
        <dt>Version</dt><dd>{value().version}<Show when={value().build}>{build => <> · {build()}</>}</Show></dd>
        <dt>URL</dt><dd>{`http://127.0.0.1:${value().port}`}</dd>
        <dt>Assets</dt><dd>{value().assets}</dd>
        <dt>Launch agent</dt><dd>{value().launch_agent.installed ? 'Installed' : 'Not installed · run tessera install'}</dd>
      </dl>}</Show>
    </section>}
  </div>;
}
