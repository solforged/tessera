import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import type { Type } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import type { IconName } from '../ui/glyphs';
import { autoPlural } from './presentation';

const icons = ['book', 'article', 'note', 'quote', 'person', 'group', 'concept', 'thesis', 'flag', 'library', 'shelf', 'tag', 'calendar', 'table', 'page', 'highlight', 'clock', 'question-open', 'compare', 'constellation', 'perspective'] as const satisfies readonly IconName[];

/** Type-wide display choices share the type page's document and undo history. */
export function TypePresentation(props: { type: Type; notebook: NotebookClient; onError(message: string): void }) {
  const doc = createMemo(() => {
    const value = props.notebook.open(props.type.page.id);
    onCleanup(() => value.release());
    return value;
  });
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const [plural, setPlural] = createSignal('');
  const [icon, setIcon] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  async function save(reset = false) {
    if (busy()) return;
    setBusy(true); props.onError('');
    try {
      const current = await props.notebook.api.type(props.type.page.id);
      const result = doc().edit({ kind: 'typePresentation', id: current.page.id, revision: current.page.revision,
        previous: { plural: current.plural, icon: current.icon },
        value: { plural: reset ? null : plural().trim() || null, icon: reset ? null : icon() } });
      if (!result.ok) throw new Error(result.reason);
      await doc().flush();
      if (doc().saveState() === 'error') throw new Error(doc().saveMessage());
      setAnchor(null);
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function history(redo: boolean) {
    if (busy()) return;
    setBusy(true); props.onError('');
    try {
      if (redo) doc().redo(); else doc().undo();
      await doc().flush();
      if (doc().saveState() === 'error') throw new Error(doc().saveMessage());
    } catch (reason) { props.onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <>
    <div class="template-actions">
      <Button aria-haspopup="dialog" aria-expanded={!!anchor()} disabled={busy() || doc().status() !== 'ready'} onClick={event => {
        setPlural(props.type.plural ?? ''); setIcon(props.type.icon); setAnchor(event.currentTarget);
      }}>Icon and name…</Button>
      <Show when={doc().canUndo()}><Button icon="undo" label="Undo tag change" disabled={busy()} onClick={() => void history(false)} /></Show>
      <Show when={doc().canRedo()}><Button icon="redo" label="Redo tag change" disabled={busy()} onClick={() => void history(true)} /></Show>
    </div>
    <Show when={anchor()}>{trigger => <Popup anchor={trigger()} label="Icon and name" fitContent onDismiss={() => setAnchor(null)}>
      <form class="type-presentation-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <h2 class="popup-title">Icon and name</h2>
        <div class="type-presentation-icons" role="group" aria-label="Tag icon"><For each={icons}>{name =>
          <Button icon={name} label={name.replaceAll('-', ' ')} aria-pressed={icon() === name} disabled={busy()} onClick={() => setIcon(name)} />
        }</For></div>
        <label>Plural name<input class="input" value={plural()} placeholder={autoPlural(props.type.page.text)} disabled={busy()} onInput={event => setPlural(event.currentTarget.value)} /></label>
        <div class="popup-actions"><Button disabled={busy()} onClick={() => void save(true)}>Reset</Button><Button disabled={busy()} onClick={() => setAnchor(null)}>Cancel</Button><Button type="submit" class="bordered" disabled={busy()}>Apply</Button></div>
      </form>
    </Popup>}</Show>
  </>;
}
