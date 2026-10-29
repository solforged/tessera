import { For, Index, Show, createEffect, createMemo, createResource, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Block, ExtractedCreator, ExtractedMetadata } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { similarPages } from './details';
import { createInstance, instancePages } from '../fields/instances';
import { titleKey } from '../document/title-key';

const roles: readonly [ExtractedCreator['role'], string][] = [['author', 'Author'], ['editor', 'Editor'], ['translator', 'Translator']];
const textFields = [['title', 'Title'], ['subtitle', 'Subtitle']] as const;
const detailFields = [['published', 'Published', 'YYYY, YYYY-MM or YYYY-MM-DD'], ['publisher', 'Publisher', ''], ['volume', 'Volume', ''], ['issue', 'Issue', ''], ['page_range', 'Page range', ''], ['language', 'Language', 'en, fr, la…']] as const;

/** A catalogue card: one labelled row per detail, creators as name and role pairs. A creator whose name resembles an
 * existing page offers that page, so a variant spelling links to the person already in the notebook. */
export function DetailsForm(props: { metadata: ExtractedMetadata; notebook: NotebookClient; collections?: JSX.Element; submitLabel: string; autofocus?: boolean; onChange?(metadata: ExtractedMetadata): void; onSave(metadata: ExtractedMetadata): Promise<void>; onCancel(): void }) {
  const [value, setValue] = createSignal<ExtractedMetadata>(structuredClone(props.metadata));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [creators, setCreators] = createSignal<ExtractedCreator[]>(props.metadata.creators.map(creator => ({ ...creator })));
  let form!: HTMLFormElement;
  createEffect(() => props.onChange?.({ ...value(), creators: creators() }));
  onMount(() => {
    if (props.autofocus) queueMicrotask(() => form.isConnected && form.querySelector<HTMLInputElement>('[aria-label="Title"]')?.focus());
  });
  let composing = false;
  const patch = (key: keyof ExtractedMetadata, text: string) => setValue(previous => ({ ...previous, [key]: text || null }));
  const patchCreator = (index: number, change: Partial<ExtractedCreator>) => setCreators(previous => previous.map((row, at) => at === index ? { ...row, ...change } : row));
  const [definitions] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.fields());
  const [people] = createResource(() => ({ definitions: definitions(), sequence: props.notebook.changeSequence() }), async ({ definitions }) => {
    const index = await props.notebook.api.noteIndex();
    const defaults = index.kinds.filter(kind => kind.key === 'person' || kind.key === 'group').flatMap(kind => kind.type_id ? [kind.type_id] : []);
    const loaded = new Map<string, Promise<Block[]>>();
    const pages = await Promise.all(roles.map(async ([role]) => {
      const selected = definitions?.fields.find(field => field.name.toLowerCase() === role)?.targets;
      const targets = selected?.length ? selected : defaults;
      const key = targets.join(',');
      if (!loaded.has(key)) loaded.set(key, targets.length ? instancePages(props.notebook, targets) : Promise.resolve([]));
      return [role, await loaded.get(key)!] as const;
    }));
    return Object.fromEntries(pages);
  });
  async function createCreator(index: number, type: string) {
    if (busy()) return;
    setBusy(true); setError('');
    try { const page = await createInstance(props.notebook, creators()[index]!.name, type); patchCreator(index, { name: page.text }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (busy()) return;
    setBusy(true); setError('');
    try { await props.onSave({ ...value(), creators: creators().filter(creator => creator.name.trim()).map(creator => ({ ...creator, name: creator.name.trim() })) }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <form ref={form} class="library-details" onCompositionStart={() => { composing = true; }} onCompositionEnd={() => { composing = false; }} onKeyDown={event => {
    if (event.key === 'Enter' && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
  }} onSubmit={event => { event.preventDefault(); if (!composing) void submit(); }}>
    <For each={textFields}>{([key, label]) => <label class="library-details-row"><span>{label}</span><input class="input" aria-label={label} required={key === 'title'} value={value()[key] ?? ''} disabled={busy()} onInput={event => patch(key, event.currentTarget.value)} /></label>}</For>
    <div class="library-details-row" role="group" aria-label="Creators"><span>Creators</span><div class="library-creators">
      <Index each={creators()}>{(creator, index) => {
        const allowed = createMemo(() => people()?.[creator().role] ?? []);
        const similar = createMemo(() => {
          const name = titleKey(creator().name.trim());
          const exactOrPrefix = allowed().filter(page => name && titleKey(page.text).includes(name));
          const seen = new Set(exactOrPrefix.map(page => page.id));
          return [...exactOrPrefix, ...similarPages(creator().name, allowed()).filter(page => !seen.has(page.id))].slice(0, 8);
        });
        const createTypes = createMemo(() => {
          const targets = definitions()?.fields.find(field => field.name.toLowerCase() === creator().role)?.targets ?? [];
          return ['Person', 'Group'].filter(title => !targets.length || targets.some(id => props.notebook.lookup(id)()?.text.toLowerCase() === title.toLowerCase()));
        });
        return <div class="library-creator">
          <input class="input" aria-label="Creator name" placeholder="Name" value={creator().name} disabled={busy()} onInput={event => patchCreator(index, { name: event.currentTarget.value })} />
          <div class="mode-tabs" role="group" aria-label="Creator role"><For each={roles}>{([role, label]) => <Button aria-pressed={creator().role === role} disabled={busy()} onClick={() => patchCreator(index, { role })}>{label}</Button>}</For></div>
          <Button icon="close" label="Remove creator" disabled={busy()} onClick={() => setCreators(previous => previous.filter((_, at) => at !== index))} />
          <Show when={similar().length}><p class="library-creator-same">Same as <For each={similar()}>{(page, at) => <>{at() ? ' or ' : ''}<Button class="library-creator-page" disabled={busy()} onClick={() => patchCreator(index, { name: page.text })}>{page.text}</Button></>}</For>?</p></Show>
          <Show when={creator().name.trim() && !similar().length && !people.loading && !people.error}><p class="library-creator-same"><For each={createTypes()}>{type => <Button disabled={busy()} onClick={() => void createCreator(index, type)}>Create {type.toLowerCase()} “{creator().name.trim()}”</Button>}</For></p></Show>
          <Show when={people.error}><p class="library-error">Could not load People or Groups.</p></Show>
        </div>;
      }}</Index>
      <Button icon="plus" class="library-add-creator" disabled={busy()} onClick={() => {
        setCreators(previous => [...previous, { name: '', role: 'author' }]);
        queueMicrotask(() => { const inputs = form.querySelectorAll<HTMLInputElement>('.library-creator input[aria-label="Creator name"]'); inputs[inputs.length - 1]?.focus(); });
      }}>Add creator</Button>
    </div></div>
    <For each={detailFields}>{([key, label, placeholder]) => <label class="library-details-row"><span>{label}</span><input class="input" aria-label={label} placeholder={placeholder || undefined} value={value()[key] ?? ''} disabled={busy()} onInput={event => patch(key, event.currentTarget.value)} /></label>}</For>
    <label class="library-details-row"><span>Identifier</span><input class="input" aria-label="Identifier" placeholder="ISBN, DOI or arXiv ID" value={value().identifiers[0] ?? ''} disabled={busy()} onInput={event => setValue(previous => ({ ...previous, identifiers: [event.currentTarget.value, ...previous.identifiers.slice(1)].filter(value => value.trim()) }))} /></label>
    {props.collections}
    <Show when={error()}><p class="library-error" role="alert">{error()}</p></Show>
    <div class="popup-actions"><Button disabled={busy()} onClick={props.onCancel}>Cancel</Button><Button type="submit" class="bordered" disabled={busy() || !value().title?.trim()}>{props.submitLabel}</Button></div>
  </form>;
}
