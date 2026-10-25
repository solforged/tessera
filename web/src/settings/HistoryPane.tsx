import { For, Show, createResource, createSignal, onMount } from 'solid-js';
import type { HistoryEntry } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget, PaneId, SettingsViewState } from '../shell/contract';
import { besideHint, opensBeside } from '../shell/beside';
import { hubDevices, sync } from '../sync/state';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { historyActor } from './history';
import { isoMinute, workshopZone } from './time';
import '../fields/field-page.css';
import './settings.css';

const PAGE = 50;

/** Every change to the workshop, newest first, with its author and Undo while it can still be undone. */
export function HistoryPane(props: { pane: PaneId; view: SettingsViewState; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void; onViewChange(view: SettingsViewState): void }) {
  const zone = workshopZone(props.notebook);
  const when = (value: number) => isoMinute(value, zone());
  const [error, setError] = createSignal('');
  const [hasMore, setHasMore] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  let generation = 0;
  const [history, { refetch, mutate }] = createResource(() => props.notebook.changeSequence(), async () => {
    const current = ++generation;
    setError('');
    try {
      const entries = await props.notebook.api.history();
      if (current === generation) setHasMore(entries.length === PAGE);
      return entries;
    } catch (reason) {
      if (current === generation) setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    }
  });
  const showMore = async () => {
    const before = history()?.at(-1)?.seq;
    if (before === undefined || loading() || history.loading) return;
    const current = generation;
    setLoading(true); setError('');
    try {
      const entries = await props.notebook.api.history(PAGE, before);
      if (current !== generation) return;
      mutate(values => [...(values ?? []), ...entries]);
      setHasMore(entries.length === PAGE);
    } catch (reason) {
      if (current === generation) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setLoading(false); }
  };
  const [undoing, setUndoing] = createSignal<number | null>(null);
  const undo = async (seq: number) => {
    if (undoing() !== null) return;
    setUndoing(seq); setError('');
    try { await props.notebook.api.undoChange(seq); await refetch(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setUndoing(null); }
  };
  const actor = (entry: HistoryEntry) => historyActor(entry, sync.state()?.replica?.device_id ?? null,
    id => hubDevices.state()?.devices.find(device => device.id === id)?.name);
  let region!: HTMLDivElement;
  const [scrolled, setScrolled] = createSignal(false);
  onMount(() => { region.scrollTop = props.view.scroll; setScrolled(region.scrollTop > 0); });
  return <div ref={region} class="settings-pane history-pane" tabIndex={0} aria-label="History" aria-busy={history.loading || loading() || undoing() !== null}
    onScroll={() => { props.onViewChange({ scroll: region.scrollTop }); setScrolled(region.scrollTop > 0); }}>
    <div class="settings-layout">
      <div class="settings-main">
        <header class="settings-header" data-scrolled={scrolled() ? '' : undefined}>
          <div class="settings-heading"><h1>History</h1></div>
        </header>
        <Show when={error()}>{message => <p class="error" role="alert">{message()}</p>}</Show>
        <Show when={history()}>{values => <Show when={values().length > 0} fallback={<p class="settings-empty">No changes yet. Edits to this workshop appear here with their author and Undo when available.</p>}>
          <ol class="settings-changes">
            <For each={values()}>{change => <li class="settings-change" data-undone={change.undone_by === null ? undefined : ''}>
              <div class="settings-label">
                <span class="settings-name">{change.summary}</span>
                <p><span class="settings-mono">{actor(change)} · <time dateTime={new Date(change.created_at).toISOString()}>{when(change.created_at)}</time></span>
                  <Show when={change.page}>{page => <><span class="settings-mono"> · </span><button type="button" class="settings-page-link" title={`Open atom · ${besideHint}`} onClick={event => props.onOpen({ kind: 'page', pageId: page().id }, opensBeside(event))}>{page().text}</button></>}</Show>
                </p>
              </div>
              <Show when={change.undoable} fallback={<Show when={change.undone_by !== null}><span class="settings-aside">Undone</span></Show>}>
                <Button class="bordered" disabled={undoing() !== null || history.loading || loading()} onClick={() => { void undo(change.seq); }}>{undoing() === change.seq ? 'Undoing…' : 'Undo'}</Button>
              </Show>
            </li>}</For>
          </ol>
          <Show when={hasMore()}>
            <Button class="settings-show-more" disabled={history.loading || loading() || undoing() !== null} onClick={() => { void showMore(); }}><Icon name="right" />{loading() ? 'Loading…' : 'Show more'}</Button>
          </Show>
        </Show>}</Show>
      </div>
    </div>
  </div>;
}
