import { For, Show, createMemo, createResource, createSignal, onMount } from 'solid-js';
import { api } from '../api/client';
import type { NotebookClient } from '../document/contract';
import type { PaneId, SettingsViewState } from '../shell/contract';
import { Button } from '../ui/Button';
import './settings.css';

export function SettingsPane(props: { pane: PaneId; view: SettingsViewState; notebook: NotebookClient; onViewChange(view: SettingsViewState): void }) {
  const [error, setError] = createSignal('');
  const [info] = createResource(async () => {
    try { return await api.notebook(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  });
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const available = Intl.supportedValuesOf('timeZone');
  const zone = () => props.notebook.settings()?.time_zone ?? deviceZone;
  const zones = createMemo(() => [...new Set([zone(), ...available])].filter(value => value !== deviceZone).sort());
  let region!: HTMLDivElement;
  onMount(() => {
    region.scrollTop = props.view.scroll;
    void props.notebook.refreshSettings().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  });
  const change = async (key: 'time_zone' | 'vim', value: string) => {
    setError('');
    try { await props.notebook.setSetting(key, value); }
    catch { /* The document owns the save error and retains acknowledged values. */ }
    // A rejected select/checkbox change must show the acknowledged value again.
    const select = region.querySelector('select'); if (select) select.value = zone();
    const checkbox = region.querySelector('input'); if (checkbox) checkbox.checked = props.notebook.vim();
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
      <h2 id={`settings-notebook-${props.pane}`}>Notebook</h2>
      <Show when={info()}>{value => <dl>
        <dt>Id</dt><dd>{value().id}</dd>
        <dt>Path</dt><dd>{value().path}</dd>
        <dt>Created</dt><dd>{new Date(value().created_at).toLocaleDateString()}</dd>
      </dl>}</Show>
    </section>
    <section aria-labelledby={`settings-zone-${props.pane}`}>
      <h2 id={`settings-zone-${props.pane}`}>Time zone</h2>
      <select class="input" aria-label="Time zone" value={zone()} disabled={props.notebook.settingsBusy()} onChange={event => { void change('time_zone', event.currentTarget.value); }}>
        <option value={deviceZone}>Device time zone ({deviceZone})</option>
        <For each={zones()}>{value => <option value={value}>{value}</option>}</For>
      </select>
    </section>
    <section aria-labelledby={`settings-editing-${props.pane}`}>
      <h2 id={`settings-editing-${props.pane}`}>Editing</h2>
      <label class="settings-checkbox"><input type="checkbox" checked={props.notebook.vim()} disabled={props.notebook.settingsBusy()} onChange={event => { void change('vim', String(event.currentTarget.checked)); }} /> Vim</label>
    </section>
  </div>;
}
