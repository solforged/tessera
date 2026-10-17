import { Show, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { ApiError } from '../api/client';
import type { ExtractedCreator, ExtractedMetadata, IngestJob, LookupPreview } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { titleKey } from '../document/title-key';
import { formatSourceValue } from '../outline/source';
import { Button } from '../ui/Button';
import { Popup, type PopupPlacement } from '../ui/Popup';
import { DetailsForm } from './DetailsForm';
import { emptyMetadata } from './details';

/** Creators read as a catalogue line: names in order, editors and translators marked. */
const roleMarks: Record<ExtractedCreator['role'], string> = { author: '', editor: ' (ed.)', translator: ' (trans.)' };

export interface AddSourceBodyProps {
  notebook: NotebookClient;
  initialText?: string;
  onAdded(sourceId: string): void;
  onDismiss(): void;
  onChooseFile?(): void;
  onFiles?(files: File[]): void;
  onJob?(job: IngestJob): void;
}

type BarcodeDetectorConstructor = new (options: { formats: string[] }) => {
  detect(image: ImageBitmap): Promise<{ rawValue: string }[]>;
};

const catalogKey = (value: string) => titleKey(value.normalize('NFD').replace(/\p{M}/gu, '').trim());
const isIdentifier = (value: string) => /^(?:https?:\/\/\S+|(?:urn:)?isbn:?\s*[\dX -]+|[\d -]{13,17}|\d[\d -]{8,15}[\dX]|(?:doi:)?10\.\d{4,9}\/\S+|(?:arxiv:)?\d{4}\.\d{4,5}(?:v\d+)?|(?:arxiv:)?[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i.test(value);

/** The ingestion form can also live inside the creation slip without owning a popup. */
export function AddSourceBody(props: AddSourceBodyProps) {
  const [query, setQuery] = createSignal(props.initialText ?? '');
  const [preview, setPreview] = createSignal<LookupPreview>();
  /** The hand-entry form, blank or seeded from a lookup so its creators can be matched to people already here. */
  const [editing, setEditing] = createSignal<{ metadata: ExtractedMetadata; coverUrl: string | null } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [draft, setDraft] = createSignal<ExtractedMetadata>();
  const [sources] = createResource(() => props.notebook.changeSequence(), async () => {
    try { return { rows: (await props.notebook.api.library({ limit: Number.MAX_SAFE_INTEGER })).rows, error: false }; }
    catch { return { rows: [], error: true }; }
  });
  const duplicate = createMemo(() => {
    const metadata = editing() ? draft() : preview()?.metadata;
    const title = catalogKey(metadata?.title ?? '');
    if (!title) return;
    const creators = metadata!.creators.map(creator => catalogKey(creator.name)).filter(Boolean);
    return sources()?.rows.find(row => catalogKey(row.page.text) === title
      && (!creators.length || !row.creators.length || row.creators.some(creator => creators.includes(catalogKey(creator)))));
  });
  const coarseMedia = window.matchMedia('(pointer: coarse)');
  const [coarse, setCoarse] = createSignal(coarseMedia.matches);
  const coarseChanged = () => setCoarse(coarseMedia.matches);
  coarseMedia.addEventListener('change', coarseChanged);
  onCleanup(() => coarseMedia.removeEventListener('change', coarseChanged));
  const canPaste = typeof navigator.clipboard?.readText === 'function';
  const canScan = 'BarcodeDetector' in window;
  let photoInput!: HTMLInputElement;
  let fileInput!: HTMLInputElement;
  function changeQuery(value: string) { setQuery(value); setPreview(undefined); setError(''); }
  async function paste() {
    try { changeQuery(await navigator.clipboard.readText()); }
    catch (reason) { setError(`Paste failed: ${reason instanceof Error ? reason.message : String(reason)}`); }
  }
  async function scan(file: File) {
    if (busy()) return;
    setBusy(true); setError('');
    let image: ImageBitmap | undefined;
    let isbn: string | undefined;
    try {
      // BarcodeDetector is a browser API not yet declared in TypeScript's DOM library.
      const barcodeWindow = window as unknown as { BarcodeDetector: BarcodeDetectorConstructor };
      const Detector = barcodeWindow.BarcodeDetector;
      image = await createImageBitmap(file);
      const codes = await new Detector({ formats: ['ean_13'] }).detect(image);
      isbn = codes.map(code => code.rawValue).find(value => /^97[89]\d{10}$/.test(value));
      if (!isbn) setError('No ISBN barcode found in that photo.');
    } catch (reason) { setError(`Scan failed: ${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { image?.close(); setBusy(false); }
    if (isbn) { changeQuery(isbn); await submit(); }
  }
  async function files(files: File[]) {
    if (!files.length || busy()) return;
    if (props.onFiles) { props.onFiles(files); props.onDismiss(); return; }
    setBusy(true); setError('');
    try {
      for (const file of files) {
        const job = await props.notebook.api.upload(file, file.name);
        props.onJob?.(job);
      }
      props.onDismiss();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  onMount(() => { if (isIdentifier(query().trim())) void submit(); });
  async function submit() {
    if (busy() || !query().trim()) return;
    const value = query().trim();
    setBusy(true); setError(''); setPreview(undefined);
    try {
      let url: URL | undefined;
      try { url = new URL(value); } catch { /* Identifiers are not URLs. */ }
      if (url && ['http:', 'https:'].includes(url.protocol) && !['doi.org', 'dx.doi.org', 'arxiv.org', 'www.arxiv.org'].includes(url.hostname.toLowerCase())) {
        const job = await props.notebook.api.queueUrl(value);
        props.onJob?.(job); props.onDismiss();
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
  const Duplicate = () => <Show when={duplicate()}>{source => <div class="library-add-duplicate" role="status">
    <span>“{source().page.text}” is already in the library.</span>
    <Button disabled={busy()} onClick={() => { props.onAdded(source().page.id); props.onDismiss(); }}>Open</Button>
  </div>}</Show>;
  return <div class="library-add" onDragOver={event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={event => { if (event.dataTransfer?.files.length) { event.preventDefault(); event.stopPropagation(); void files(Array.from(event.dataTransfer.files)); } }}>
      <h2 class="popup-title">Add to library</h2>
      <Show when={!editing()} fallback={<>
        <DetailsForm metadata={editing()!.metadata} notebook={props.notebook} autofocus submitLabel={duplicate() ? 'Add another copy' : 'Add'} onChange={setDraft} onSave={metadata => add(metadata, editing()!.coverUrl)} onCancel={() => setEditing(null)} />
        <Duplicate />
      </>}>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <div class="library-add-query">
            <label class="library-add-url">URL, ISBN, DOI or arXiv ID<input class="input" aria-label="URL, ISBN, DOI or arXiv ID" placeholder="https://… or 978…" value={query()} disabled={busy()} onInput={event => changeQuery(event.currentTarget.value)} /></label>
            <Show when={coarse() && (canPaste || canScan)}><div class="library-add-touch">
              <Show when={canPaste}><Button disabled={busy()} onClick={() => void paste()}>Paste</Button></Show>
              <Show when={canScan}><Button disabled={busy()} onClick={() => photoInput.click()}>Scan ISBN</Button></Show>
            </div></Show>
          </div>
          <div class="library-add-actions"><Button icon="upload" disabled={busy()} onClick={() => props.onChooseFile ? props.onChooseFile() : fileInput.click()}>Choose file…</Button><Button icon="edit" disabled={busy()} onClick={() => setEditing({ metadata: emptyMetadata(), coverUrl: null })}>Enter details by hand</Button></div>
          <Show when={busy()}><p class="library-message" role="status">Looking up…</p></Show>
          <Show when={error()}><p class="library-error" role="alert">{error()}</p></Show>
        </form>
        <Show when={preview()}>{value => <>
          <section class="library-preview" aria-label="Lookup preview">
            <Show when={value().cover_url}><img class="library-preview-cover" src={value().cover_url!} alt="" /></Show>
            <div class="library-preview-text">
              <h3>{value().metadata.title}</h3>
              <Show when={value().metadata.subtitle}><p class="library-preview-subtitle">{value().metadata.subtitle}</p></Show>
              <Show when={value().metadata.creators.length}><p>{value().metadata.creators.map(creator => creator.name + roleMarks[creator.role]).join(', ')}</p></Show>
              <p class="library-preview-apparatus">{[value().metadata.published?.slice(0, 4), value().metadata.publisher, ...value().metadata.identifiers.map(id => formatSourceValue('Identifier', id))].filter(Boolean).join(' · ')}</p>
              <p class="library-preview-provider">From {value().provider}</p>
            </div>
          </section>
          <div class="popup-actions"><Button disabled={busy()} onClick={() => setPreview(undefined)}>Cancel</Button><Button disabled={busy()} onClick={() => { setEditing({ metadata: value().metadata, coverUrl: value().cover_url }); setPreview(undefined); }}>Edit details</Button><Button class="bordered" disabled={busy()} onClick={() => {
            setBusy(true); setError(''); void add(value().metadata, value().cover_url).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
          }}>{duplicate() ? 'Add another copy' : 'Add'}</Button></div>
          <Duplicate />
        </>}</Show>
      </Show>
      <Show when={sources()?.error}><p class="library-error" role="alert">Could not check for existing sources.</p></Show>
      <input ref={fileInput} type="file" hidden aria-label="Choose EPUB files" accept=".epub,application/epub+zip" multiple onChange={event => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void files(selected); }} />
      <input ref={photoInput} type="file" hidden aria-label="Scan ISBN" accept="image/*" capture="environment" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void scan(file); }} />
    </div>;
}

export function AddSheet(props: AddSourceBodyProps & { anchor: HTMLElement; placement?: PopupPlacement }) {
  return <Popup anchor={props.anchor} placement={props.placement} fitContent class="library-add" label="Add to library" onDismiss={props.onDismiss}>
    <AddSourceBody {...props} />
  </Popup>;
}
