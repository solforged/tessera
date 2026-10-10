import { For, Show, createSignal } from 'solid-js';
import type { ExtractedCreator, ExtractedMetadata } from '../api/types';
import { Button } from '../ui/Button';

export function DetailsForm(props: { metadata: ExtractedMetadata; submitLabel: 'Add' | 'Save'; onSave(metadata: ExtractedMetadata): Promise<void>; onCancel(): void }) {
  const [value, setValue] = createSignal<ExtractedMetadata>(structuredClone(props.metadata));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [creators, setCreators] = createSignal(props.metadata.creators.map((creator, key) => ({ ...creator, key })));
  let nextKey = creators().length;
  const patch = (key: keyof ExtractedMetadata, text: string) => setValue(previous => ({ ...previous, [key]: text || null }));
  async function submit() {
    if (busy()) return;
    setBusy(true); setError('');
    try { await props.onSave({ ...value(), creators: creators().filter(creator => creator.name.trim()).map(({ name, role }) => ({ name: name.trim(), role })) }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <form onSubmit={event => { event.preventDefault(); void submit(); }}>
    <For each={(['title', 'subtitle'] as const)}>{key => <label class="library-add-url">{key === 'title' ? 'Title' : 'Subtitle'}<input class="input" aria-label={key === 'title' ? 'Title' : 'Subtitle'} required={key === 'title'} value={value()[key] ?? ''} disabled={busy()} onInput={event => patch(key, event.currentTarget.value)} /></label>}</For>
    <fieldset disabled={busy()}><legend>Creators</legend><For each={creators()}>{creator => <div class="library-add-actions">
      <input class="input" aria-label="Creator name" value={creator.name} onInput={event => { creator.name = event.currentTarget.value; }} />
      <select class="input" aria-label="Creator role" value={creator.role} onChange={event => { creator.role = event.currentTarget.value as ExtractedCreator['role']; }}><option value="author">Author</option><option value="editor">Editor</option><option value="translator">Translator</option></select>
      <Button icon="close" label="Remove creator" onClick={() => setCreators(previous => previous.filter(row => row.key !== creator.key))} />
    </div>}</For><Button class="text-button" onClick={() => setCreators(previous => [...previous, { key: nextKey++, name: '', role: 'author' }])}>Add creator</Button></fieldset>
    <For each={(['published', 'publisher', 'language'] as const)}>{key => <label class="library-add-url">{key[0]!.toUpperCase() + key.slice(1)}<input class="input" aria-label={key[0]!.toUpperCase() + key.slice(1)} placeholder={key === 'published' ? 'YYYY, YYYY-MM or YYYY-MM-DD' : undefined} value={value()[key] ?? ''} disabled={busy()} onInput={event => patch(key, event.currentTarget.value)} /></label>}</For>
    <label class="library-add-url">Identifier<input class="input" aria-label="Identifier" placeholder="ISBN, DOI or arXiv" value={value().identifiers[0] ?? ''} disabled={busy()} onInput={event => setValue(previous => ({ ...previous, identifiers: [event.currentTarget.value, ...previous.identifiers.slice(1)].filter(value => value.trim()) }))} /></label>
    <Show when={error()}><p class="library-error" role="alert">{error()}</p></Show>
    <div class="popup-actions"><Button disabled={busy()} onClick={props.onCancel}>Cancel</Button><Button type="submit" class="bordered" disabled={busy() || !value().title?.trim()}>{props.submitLabel}</Button></div>
  </form>;
}
