import { For, Show, createMemo, createResource, createSignal, onMount } from 'solid-js';
import { api } from '../api/client';
import type { NotebookClient } from '../document/contract';
import type { PaneId, SettingsViewState } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { backupLabel } from './backup';
import './settings.css';

export function SettingsPane(props: { pane: PaneId; view: SettingsViewState; notebook: NotebookClient; onViewChange(view: SettingsViewState): void }) {
  const [error, setError] = createSignal('');
  const [info] = createResource(async () => {
    try { return await api.notebook(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  });
  const [service] = createResource(async () => {
    try { return await api.service(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  });
  const [backups, { refetch: refreshBackups }] = createResource(async () => {
    try { return await api.backups(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  });
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
    <div class="settings-actions">
      <span role="status">{props.notebook.settingsMessage()}</span>
      <Button icon="undo" disabled={!props.notebook.canUndoSetting()} onClick={() => { void history(false); }}>Undo</Button>
      <Button icon="redo" disabled={!props.notebook.canRedoSetting()} onClick={() => { void history(true); }}>Redo</Button>
    </div>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <section aria-labelledby={`settings-notebook-${props.pane}`}>
      <h2 id={`settings-notebook-${props.pane}`}><span class="section-number">01</span>Notebook<span class="section-rule" /></h2>
      <Show when={info()}>{value => <dl>
        <dt>Id</dt><dd>{value().id}</dd>
        <dt>Path</dt><dd>{value().path}</dd>
        <dt>Created</dt><dd>{new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value().created_at)}</dd>
      </dl>}</Show>
    </section>
    <section aria-labelledby={`settings-service-${props.pane}`}>
      <h2 id={`settings-service-${props.pane}`}><span class="section-number">02</span>Service<span class="section-rule" /></h2>
      <Show when={service()}>{value => <dl>
        <dt>Version</dt><dd>{value().version}</dd>
        <Show when={value().build}>{build => <><dt>Build</dt><dd>{build()}</dd></>}</Show>
        <dt>URL</dt><dd>{`http://127.0.0.1:${value().port}`}</dd>
        <dt>Assets</dt><dd>{value().assets}</dd>
        <dt>Launch agent</dt><dd>{value().launch_agent.installed ? 'Installed' : 'Not installed · run tessera install'}</dd>
      </dl>}</Show>
    </section>
    <section aria-labelledby={`settings-backups-${props.pane}`} aria-busy={backingUp()}>
      <h2 id={`settings-backups-${props.pane}`}><span class="section-number">03</span>Backups<span class="section-rule" /></h2>
      <Button class="bordered" disabled={backingUp()} onClick={() => { void backUp(); }}>Back up now</Button>
      <Show when={backups()}>{values => <>
        <p role="status">{values()[0] ? `Last backup: ${backupLabel(values()[0]!)}` : 'No backups yet'}</p>
        <Show when={values().length > 1}><ul><For each={values().slice(1)}>{backup => <li>{backupLabel(backup)}</li>}</For></ul></Show>
      </>}</Show>
    </section>
    <section aria-labelledby={`settings-zone-${props.pane}`}>
      <h2 id={`settings-zone-${props.pane}`}><span class="section-number">04</span>Time zone<span class="section-rule" /></h2>
      <Button class="bordered" aria-label="Time zone" aria-haspopup="listbox" disabled={props.notebook.settingsBusy()} onClick={event => setZoneAnchor(event.currentTarget)}>{zone() === deviceZone ? `Device time zone (${deviceZone})` : zone()} <Icon name="down" /></Button>
      <Show when={zoneAnchor()}>{anchor => <Picker<string> anchor={anchor()} width={360} label="Choose time zone" onDismiss={() => { setZoneAnchor(null); setZoneQuery(''); }}
        query={zoneQuery()} onQuery={setZoneQuery} placeholder="Search time zones"
        items={zoneRows()} key={value => value} empty="No matching time zone."
        onPick={value => { setZoneAnchor(null); setZoneQuery(''); void change('time_zone', value); }}
        row={value => <><Show when={value === zone()} fallback={<span class="icon" />}><Icon name="check" /></Show><span class="picker-text">{value === deviceZone ? `Device time zone (${deviceZone})` : value}</span></>} />}</Show>
    </section>
    <section aria-labelledby={`settings-editing-${props.pane}`}>
      <h2 id={`settings-editing-${props.pane}`}><span class="section-number">05</span>Editing<span class="section-rule" /></h2>
      <label class="settings-checkbox"><input type="checkbox" checked={props.notebook.vim()} disabled={props.notebook.settingsBusy()} onChange={event => { void change('vim', String(event.currentTarget.checked)); }} /> Vim</label>
    </section>
  </div>;
}
