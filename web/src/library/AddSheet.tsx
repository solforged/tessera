import { For, Show, createSignal } from 'solid-js';
import { ApiError } from '../api/client';
import type { ExtractedMetadata, IngestJob, LookupPreview } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { DetailsForm } from './DetailsForm';
import { emptyMetadata } from './details';

export function AddSheet(props: { anchor: HTMLElement; notebook: NotebookClient; onDismiss(): void; onChooseFile(): void; onFiles(files: File[]): void; onJob(job: IngestJob): void; onAdded(id: string): void }) {
  const [query, setQuery] = createSignal('');
  const [preview, setPreview] = createSignal<LookupPreview>();
  const [manual, setManual] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  async function submit() {
    if (busy() || !query().trim()) return;
    const value = query().trim();
    setBusy(true); setError(''); setPreview(undefined);
    try {
      let url: URL | undefined;
      try { url = new URL(value); } catch { /* Identifiers are not URLs. */ }
      if (url && ['http:', 'https:'].includes(url.protocol) && !['doi.org', 'dx.doi.org', 'arxiv.org', 'www.arxiv.org'].includes(url.hostname.toLowerCase())) {
        props.onJob(await props.notebook.api.queueUrl(value)); props.onDismiss();
      } else setPreview(await props.notebook.api.lookup(value));
    } catch (reason) {
      setError(reason instanceof ApiError && reason.code === 'not_found' ? `Nothing found for ${value}` : `Lookup failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally { setBusy(false); }
  }
  async function add(metadata: ExtractedMetadata, coverUrl?: string | null) {
    const plan = await props.notebook.api.planRecord(metadata, coverUrl);
    await props.notebook.commit(plan.operations, 'Add source');
    props.onAdded(plan.source_id); props.onDismiss();
  }
  return <Popup anchor={props.anchor} placement="top" class="library-add" label="Add to library" onDismiss={props.onDismiss}>
    <div onDragOver={event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={event => { if (event.dataTransfer?.files.length) { event.preventDefault(); event.stopPropagation(); props.onFiles(Array.from(event.dataTransfer.files)); props.onDismiss(); } }}>
      <h2 class="popup-title">Add to library</h2>
      <Show when={!manual()} fallback={<DetailsForm metadata={emptyMetadata()} submitLabel="Add" onSave={metadata => add(metadata)} onCancel={() => setManual(false)} />}>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label class="library-add-url">URL, ISBN, DOI or arXiv ID<input class="input" aria-label="URL, ISBN, DOI or arXiv ID" placeholder="https://… or 978…" value={query()} disabled={busy()} onInput={event => { setQuery(event.currentTarget.value); setPreview(undefined); setError(''); }} /></label>
          <div class="library-add-actions"><Button disabled={busy()} onClick={props.onChooseFile}>Choose file…</Button><Button class="text-button" disabled={busy()} onClick={() => setManual(true)}>Enter details by hand</Button></div>
          <Show when={busy()}><p class="library-message" role="status">Looking up…</p></Show>
          <Show when={error()}><p class="library-error" role="alert">{error()}</p></Show>
        </form>
        <Show when={preview()}>{value => <section aria-label="Lookup preview">
          <Show when={value().cover_url}><div class="outline-source-cover button"><img src={value().cover_url!} alt="" /></div></Show>
          <h3>{value().metadata.title}</h3><Show when={value().metadata.subtitle}><p>{value().metadata.subtitle}</p></Show>
          <For each={value().metadata.creators}>{creator => <p>{creator.name} · {creator.role[0]!.toUpperCase() + creator.role.slice(1)}</p>}</For>
          <p>{[value().metadata.published?.slice(0, 4), value().metadata.publisher].filter(Boolean).join(' · ')}</p>
          <p>{value().metadata.identifiers.join(', ')}</p><p class="library-message">{value().provider}</p>
          <div class="popup-actions"><Button disabled={busy()} onClick={() => setPreview(undefined)}>Cancel</Button><Button class="bordered" disabled={busy()} onClick={() => {
            setBusy(true); setError(''); void add(value().metadata, value().cover_url).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
          }}>Add</Button></div>
        </section>}</Show>
      </Show>
    </div>
  </Popup>;
}
