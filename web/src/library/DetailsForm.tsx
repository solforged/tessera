import { For, Index, Show, createMemo, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Block, ExtractedCreator, ExtractedMetadata } from '../api/types';
import { Button } from '../ui/Button';
import { similarPages } from './details';

const roles: readonly [ExtractedCreator['role'], string][] = [['author', 'Author'], ['editor', 'Editor'], ['translator', 'Translator']];
const textFields = [['title', 'Title'], ['subtitle', 'Subtitle']] as const;
const detailFields = [['published', 'Published', 'YYYY, YYYY-MM or YYYY-MM-DD'], ['publisher', 'Publisher', ''], ['language', 'Language', 'en, fr, la…']] as const;

/** A catalogue card: one labelled row per detail, creators as name and role pairs. A creator whose name resembles an
 * existing page offers that page, so a variant spelling links to the person already in the notebook. */
export function DetailsForm(props: { metadata: ExtractedMetadata; pages: Accessor<readonly Block[]>; submitLabel: 'Add' | 'Save'; onSave(metadata: ExtractedMetadata): Promise<void>; onCancel(): void }) {
  const [value, setValue] = createSignal<ExtractedMetadata>(structuredClone(props.metadata));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [creators, setCreators] = createSignal<ExtractedCreator[]>(props.metadata.creators.map(creator => ({ ...creator })));
  const patch = (key: keyof ExtractedMetadata, text: string) => setValue(previous => ({ ...previous, [key]: text || null }));
  const patchCreator = (index: number, change: Partial<ExtractedCreator>) => setCreators(previous => previous.map((row, at) => at === index ? { ...row, ...change } : row));
  async function submit() {
    if (busy()) return;
    setBusy(true); setError('');
    try { await props.onSave({ ...value(), creators: creators().filter(creator => creator.name.trim()).map(({ name, role }) => ({ name: name.trim(), role })) }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <form class="library-details" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <For each={textFields}>{([key, label]) => <label class="library-details-row"><span>{label}</span><input class="input" aria-label={label} required={key === 'title'} value={value()[key] ?? ''} disabled={busy()} onInput={event => patch(key, event.currentTarget.value)} /></label>}</For>
    <div class="library-details-row" role="group" aria-label="Creators"><span>Creators</span><div class="library-creators">
      <Index each={creators()}>{(creator, index) => {
        const similar = createMemo(() => similarPages(creator().name, props.pages()));
        return <div class="library-creator">
          <input class="input" aria-label="Creator name" placeholder="Name" value={creator().name} disabled={busy()} onInput={event => patchCreator(index, { name: event.currentTarget.value })} />
          <div class="mode-tabs" role="group" aria-label="Creator role"><For each={roles}>{([role, label]) => <Button aria-pressed={creator().role === role} disabled={busy()} onClick={() => patchCreator(index, { role })}>{label}</Button>}</For></div>
          <Button icon="close" label="Remove creator" disabled={busy()} onClick={() => setCreators(previous => previous.filter((_, at) => at !== index))} />
          <Show when={similar().length}><p class="library-creator-same">Same as <For each={similar()}>{(page, at) => <>{at() ? ' or ' : ''}<Button class="library-creator-page" disabled={busy()} onClick={() => patchCreator(index, { name: page.text })}>{page.text}</Button></>}</For>?</p></Show>
        </div>;
      }}</Index>
      <Button icon="plus" class="library-add-creator" disabled={busy()} onClick={() => setCreators(previous => [...previous, { name: '', role: 'author' }])}>Add creator</Button>
    </div></div>
    <For each={detailFields}>{([key, label, placeholder]) => <label class="library-details-row"><span>{label}</span><input class="input" aria-label={label} placeholder={placeholder || undefined} value={value()[key] ?? ''} disabled={busy()} onInput={event => patch(key, event.currentTarget.value)} /></label>}</For>
    <label class="library-details-row"><span>Identifier</span><input class="input" aria-label="Identifier" placeholder="ISBN, DOI or arXiv ID" value={value().identifiers[0] ?? ''} disabled={busy()} onInput={event => setValue(previous => ({ ...previous, identifiers: [event.currentTarget.value, ...previous.identifiers.slice(1)].filter(value => value.trim()) }))} /></label>
    <Show when={error()}><p class="library-error" role="alert">{error()}</p></Show>
    <div class="popup-actions"><Button disabled={busy()} onClick={props.onCancel}>Cancel</Button><Button type="submit" class="bordered" disabled={busy() || !value().title?.trim()}>{props.submitLabel}</Button></div>
  </form>;
}
