import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ExtractedMetadata, FieldDefinition, SourceView } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { textTokens } from '../document/text-tokens';
import { documentReady } from '../outline/source-fields';
import { valueLabel } from '../outline/source';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ResourceImage } from './ResourceImage';
import { MetadataField } from './MetadataField';
import { metadataEqual, metadataText, metadataValues } from './metadata-values';
import { MetadataCreators } from './MetadataCreators';
import { publicationReading } from './publication';
import { derivedSourceSiglum, fillMissingSourceDetails, saveSourceField, sourceEntries, sourceFieldValue } from './details';
import type { SourceCreator, SourceField, SourceFieldChange, SourceFieldValue } from './details';
import './metadata-inspector.css';

const labels: Record<SourceField, string> = {
  title: 'Title', subtitle: 'Subtitle', creators: 'Creators', firstPublished: 'First published', originalLanguage: 'Original language',
  published: 'Published', publisher: 'Publisher', edition: 'Edition', series: 'Series', number: 'Number', pages: 'Pages', language: 'Language',
  identifiers: 'ISBN, DOI, arXiv', url: 'URL', site: 'Site', description: 'Description', cover: 'Cover', siglum: 'Siglum', citationKey: 'Citation key',
  state: 'Reading state', started: 'Started', finished: 'Finished', tags: 'Tags',
};
const dates: Partial<Record<SourceField, true>> = { firstPublished: true, published: true, started: true, finished: true };
const apparatus: Partial<Record<SourceField, true>> = { ...dates, number: true, pages: true, identifiers: true, siglum: true, citationKey: true };
const snapshotFields: Partial<Record<SourceField, keyof ExtractedMetadata>> = { title: 'title', subtitle: 'subtitle', published: 'published', publisher: 'publisher', language: 'language', identifiers: 'identifiers', url: 'url', site: 'site', description: 'description', cover: 'cover' };
interface Evidence { view: SourceView; extracted: Map<string, string[]> }
interface HistoryEntry { change: SourceFieldChange; label: string; count: number }

/** Keep long per-source registers bounded without mounting fifty independent editors. */
function SourceRegister(props: { docs: readonly PageDocument[]; label: string; summary?: string; children(doc: PageDocument): JSX.Element }) {
  const [page, setPage] = createSignal(0);
  createEffect(on(() => props.docs.map(doc => doc.pageId).join(','), () => setPage(0)));
  return <details class="metadata-register">
    <summary aria-label={props.label}>{props.summary ?? props.label}<span>{props.docs.length} sources</span><Icon name="right" /></summary>
    <div role="group" aria-label={props.label}>
      <For each={props.docs.slice(page() * 10, (page() + 1) * 10)}>{doc => <div class="metadata-register-source"><div class="metadata-register-title"><span>{doc.root()?.source?.siglum}</span>{doc.root()?.text}</div>{props.children(doc)}</div>}</For>
      <Show when={props.docs.length > 10}><div class="metadata-register-pages"><Button icon="left" label="Previous sources" disabled={page() === 0} onClick={() => setPage(value => value - 1)} /><span>{page() * 10 + 1}–{Math.min((page() + 1) * 10, props.docs.length)} of {props.docs.length} sources</span><Button icon="right" label="Next sources" disabled={(page() + 1) * 10 >= props.docs.length} onClick={() => setPage(value => value + 1)} /></div></Show>
    </div>
  </details>;
}

function InspectorGroup(props: { number: number; title: string; summary: string; phone?: boolean; children: JSX.Element }) {
  const [open, setOpen] = createSignal(props.phone ? props.number === 1 : props.title !== 'About');
  return <section class="metadata-group"><h3><Button class="metadata-group-toggle" aria-expanded={open()} onClick={() => setOpen(value => !value)}><span class="metadata-section-number">{props.number}</span><span>{props.title}</span><span class="metadata-section-rule" /><Show when={!open()}><span class="metadata-group-summary">{props.summary}</span></Show><Icon name={open() ? 'down' : 'right'} /></Button></h3><div class="metadata-group-content" hidden={!open()}>{props.children}</div></section>;
}

export function MetadataInspector(props: {
  notebook: NotebookClient;
  sourceIds: readonly string[];
  onOpen(target: OpenTarget, beside: boolean): void;
  onClose(): void;
  phone?: boolean;
  backLabel?: string;
  onBack?(): void;
  onSaveState?(state: 'saved' | 'saving' | 'error', message?: string): void;
}): JSX.Element {
  let root!: HTMLDivElement;
  let coverInput!: HTMLInputElement;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let coverDocs: readonly PageDocument[] = [];
  const [docs, setDocs] = createSignal<PageDocument[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal('');
  const [actionError, setActionError] = createSignal('');
  const [errors, setErrors] = createSignal(new Map<string, string>());
  const [pending, setPending] = createSignal(0);
  const [slow, setSlow] = createSignal(false);
  const [history, setHistory] = createSignal<HistoryEntry[]>([]);
  const [cursor, setCursor] = createSignal(0);
  const [toast, setToast] = createSignal<{ label: string; count: number; action?: 'undo' | 'redo' }>();
  const selection = createMemo(() => [...new Set(props.sourceIds)].join('\0'));
  createEffect(on(() => [props.notebook, selection()] as const, ([notebook, ids]) => {
    let cancelled = false;
    const opened = ids ? ids.split('\0').map(id => notebook.open(id)) : [];
    setDocs([]); setLoading(true); setLoadError(''); setErrors(new Map()); setActionError('');
    void Promise.all(opened.map(documentReady)).then(() => {
      if (cancelled) return;
      if (opened.some(doc => !doc.root()?.source)) throw new Error('One of the selected pages is no longer a source.');
      setDocs(opened); setLoading(false);
    }).catch(reason => { if (!cancelled) { setLoadError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); } });
    onCleanup(() => { cancelled = true; for (const doc of opened) doc.release(); });
  }));
  const [definitions] = createResource(() => [props.notebook, props.notebook.changeSequence()] as const, ([notebook]) => notebook.api.fields());
  const evidenceKey = createMemo(() => docs().map(doc => `${doc.pageId}:${doc.root()?.source?.current_snapshot_id ?? ''}`).join('\0'));
  const [evidence] = createResource(() => [props.notebook, evidenceKey()] as const, async ([notebook, key]) => {
    const result = await Promise.all((key ? key.split('\0') : []).map(async source => {
      const id = source.split(':', 1)[0]!;
      const [view, extracted] = await Promise.all([notebook.api.source(id), notebook.api.extracted(id)]);
      return [id, { view, extracted: new Map(extracted.map(([name, values]) => [name.toLocaleLowerCase(), values])) }] as const;
    }));
    return new Map<string, Evidence>(result);
  });
  const fields = createMemo<readonly FieldDefinition[]>(() => definitions()?.fields ?? []);
  const ready = createMemo(() => !loading() && !loadError() && !!definitions() && !definitions.error && !evidence.loading && !evidence.error);
  const batch = createMemo(() => docs().length > 1);
  function extractedValue(doc: PageDocument, field: SourceField): SourceFieldValue | undefined {
    const item = evidence()?.get(doc.pageId);
    if (!item) return undefined;
    const snapshot = item.view.snapshots.find(snapshot => snapshot.id === doc.root()?.source?.current_snapshot_id);
    if (!snapshot) return undefined;
    if (field === 'creators') {
      const creators: SourceCreator[] = [];
      for (const role of ['author', 'editor', 'translator'] as const) {
        for (const text of item.extracted.get(role) ?? []) {
          const reference = textTokens(text).find(token => token.kind === 'reference');
          creators.push({ id: reference?.id ?? null, name: valueLabel(text, id => props.notebook.lookup(id)), role });
        }
      }
      return creators.length ? creators : snapshot.metadata.creators.map(creator => ({ ...creator, id: null }));
    }
    const key = snapshotFields[field];
    if (!key) return undefined;
    if (field === 'published') return publicationReading(snapshot.metadata.published, item.view.snapshots) ?? '';
    const raw = item.extracted.get(field === 'identifiers' ? 'identifier' : labels[field].toLocaleLowerCase());
    if (raw) return field === 'identifiers' ? raw.map(text => valueLabel(text, id => props.notebook.lookup(id))) : valueLabel(raw[0] ?? '', id => props.notebook.lookup(id));
    const value = snapshot.metadata[key];
    return Array.isArray(value) ? value as string[] : value ?? '';
  }
  function current(doc: PageDocument, field: SourceField): SourceFieldValue {
    const value = sourceFieldValue(doc, props.notebook, fields(), field);
    if (field === 'published') return publicationReading(String(value), evidence()?.get(doc.pageId)?.view.snapshots) ?? '';
    if (['url', 'site', 'description', 'cover'].includes(field) && !sourceEntries(doc, fields()).has(labels[field].toLocaleLowerCase())) return extractedValue(doc, field) ?? value;
    return value;
  }
  const updateError = (key: string, message: string) => setErrors(previous => {
    const next = new Map(previous); if (message) next.set(key, message); else next.delete(key); return next;
  });
  createEffect(() => {
    const count = errors().size;
    const fatal = loadError() || (definitions.error ? String(definitions.error) : '') || (evidence.error ? String(evidence.error) : '') || actionError();
    if (count) props.onSaveState?.('error', `${count} ${count === 1 ? 'field' : 'fields'} not saved`);
    else if (fatal) props.onSaveState?.('error', fatal);
    else if (slow()) props.onSaveState?.('saving', 'Saving…');
    else props.onSaveState?.('saved');
  });
  const saving = createMemo(() => pending() > 0);
  createEffect(() => {
    if (!saving()) { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 1000);
    onCleanup(() => window.clearTimeout(timer));
  });
  async function perform(label: string, count: number, operation: () => Promise<SourceFieldChange | undefined>) {
    setPending(value => value + 1);
    const result = queue.then(operation);
    queue = result.catch(() => {});
    try {
      const change = await result;
      if (disposed) return;
      if (change) {
        setHistory(previous => [...previous.slice(0, cursor()), { change, label, count }]);
        setCursor(history().length);
      }
      setToast({ label, count, action: change ? 'undo' : undefined });
    } finally { if (!disposed) setPending(value => value - 1); }
  }
  async function save(selected: readonly PageDocument[], field: SourceField, value: SourceFieldValue) {
    if (selected.every(doc => metadataEqual(current(doc, field), value))) return;
    await perform(`${labels[field]} set`, selected.length, () => saveSourceField(selected, props.notebook, field, value));
  }
  async function travel(redo: boolean) {
    if (pending()) return;
    const index = cursor() + (redo ? 0 : -1);
    const entry = history()[index];
    if (!entry) return;
    setPending(value => value + 1); setActionError('');
    const result = queue.then(async () => {
      await (redo ? entry.change.redo() : entry.change.undo());
      if (disposed) return;
      setCursor(index + (redo ? 1 : 0));
      setToast({ label: `${entry.label} ${redo ? 'redone' : 'undone'}`, count: entry.count, action: redo ? 'undo' : 'redo' });
    });
    queue = result.catch(() => {});
    try { await result; }
    catch (reason) { if (!disposed) setActionError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!disposed) setPending(value => value - 1); }
  }
  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLocaleLowerCase() !== 'z') return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .popup')) return;
      const pane = root.closest('.pane');
      if (pane ? !pane.classList.contains('active') || !target || !pane.contains(target) : !target || !root.contains(target)) return;
      if (event.shiftKey ? cursor() >= history().length : cursor() === 0) return;
      event.preventDefault(); event.stopImmediatePropagation(); void travel(event.shiftKey);
    };
    document.addEventListener('keydown', keydown, true);
    onCleanup(() => document.removeEventListener('keydown', keydown, true));
  });
  onCleanup(() => { disposed = true; props.onSaveState?.('saved'); });
  function field(field: SourceField, selected: readonly PageDocument[] = docs(), extra: { hint?: JSX.Element; placeholder?: string } = {}) {
    const values = createMemo(() => selected.map(doc => current(doc, field)));
    const key = `${selected.map(doc => doc.pageId).join(',')}:${field}`;
    const extracted = createMemo(() => {
      const list = selected.map(doc => extractedValue(doc, field));
      return list[0] !== undefined && list.every(value => value !== undefined && metadataEqual(value, list[0]!)) ? list[0] : undefined;
    });
    return <MetadataField label={labels[field]} values={values()} disabled={!ready()} extracted={extracted()}
      voice={field === 'title' ? 'title' : field === 'description' ? 'description' : apparatus[field] ? 'mono' : undefined}
      kind={field === 'language' || field === 'originalLanguage' ? 'language' : field === 'state' ? 'state' : field === 'identifiers' || field === 'tags' ? 'lines' : 'text'}
      placeholder={extra.placeholder ?? (dates[field] ? 'Add date' : undefined)}
      scope={selected.length > 1 ? `Enter or blur sets this on all ${selected.length} sources.` : batch() ? `Changes only “${selected[0]?.root()?.text}”.` : undefined}
      hint={extra.hint} onSave={value => save(selected, field, value)} onError={message => updateError(key, message)} />;
  }
  function perSource(fieldName: SourceField) {
    const values = createMemo(() => metadataValues(docs().map(doc => current(doc, fieldName))));
    // A field that differs across the selection keeps its label column; its body is the per-source register.
    return <Show when={batch() && (values().mixed || dates[fieldName] || fieldName === 'number')} fallback={field(fieldName)}><div class="metadata-field"><span class="metadata-label">{labels[fieldName]}</span><div class="metadata-field-body"><SourceRegister docs={docs()} label={`${labels[fieldName]} per source`} summary={[values().distinct.length ? `${values().distinct.length} ${values().distinct.length === 1 ? 'value' : 'values'}` : '', values().empty ? `${values().empty} empty` : '', 'per source'].filter(Boolean).join(' · ')}>{doc => field(fieldName, [doc])}</SourceRegister></div></div></Show>;
  }
  function creators(selected: readonly PageDocument[]) {
    const key = `${selected.map(doc => doc.pageId).join(',')}:creators`;
    const value = createMemo(() => current(selected[0]!, 'creators') as SourceCreator[]);
    const extracted = createMemo(() => {
      const values = selected.map(doc => extractedValue(doc, 'creators'));
      const comparable = (value: SourceFieldValue | undefined) => JSON.stringify(Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : { name: item.name, role: item.role }) : value);
      return values[0] !== undefined && values.every(item => comparable(item) === comparable(values[0])) && comparable(values[0]) !== comparable(value()) ? values[0] as SourceCreator[] : undefined;
    });
    return <><MetadataCreators notebook={props.notebook} docs={selected} value={value()} disabled={!ready()} onOpen={props.onOpen} onSave={value => save(selected, 'creators', value)} onChange={perform} onPermanentChange={() => { setHistory([]); setCursor(0); }} onError={message => updateError(key, message)} /><Show when={extracted()}>{value => <Button class="metadata-text-action" onClick={() => { void save(selected, 'creators', value()).catch(reason => updateError(key, String(reason))); }}>Reset to extracted</Button>}</Show></>;
  }
  const creatorValues = createMemo(() => metadataValues(docs().map(doc => current(doc, 'creators'))));
  function cover(selected: readonly PageDocument[]) {
    const currentCover = createMemo(() => current(selected[0]!, 'cover') as string);
    const extracted = createMemo(() => extractedValue(selected[0]!, 'cover'));
    return <div class="metadata-cover"><Show when={currentCover()}>{href => <ResourceImage snapshotId={selected[0]?.root()?.source?.current_snapshot_id ?? ''} href={href()} loading="lazy" alt={`Cover of ${selected[0]?.root()?.text}`} />}</Show><div><Button class="metadata-text-action" disabled={!ready()} onClick={() => { coverDocs = selected; coverInput.click(); }}>Replace cover…</Button><Show when={extracted() !== undefined && !metadataEqual(currentCover(), extracted()!)}><Button class="metadata-text-action" disabled={!ready()} onClick={() => { void save(selected, 'cover', extracted()!).catch(reason => setActionError(String(reason))); }}>Reset to extracted cover</Button></Show><Show when={selected.length > 1}><p class="metadata-hint">Replaces the cover on all {selected.length} sources.</p></Show></div></div>;
  }
  function siglum(selected: readonly PageDocument[]) {
    const doc = selected[0]!;
    const derived = createMemo(() => derivedSourceSiglum(current(doc, 'creators') as SourceCreator[], String(current(doc, 'site')), String(current(doc, 'title'))));
    return field('siglum', selected, { placeholder: `${derived().mark} · Set override…`, hint: <div class="metadata-hint metadata-siglum-basis"><span>Derived {derived().mark} from {derived().basis}. Authored override: 1–4 letters.</span><Show when={current(doc, 'siglum')}><Button class="metadata-text-action" onClick={() => { void save(selected, 'siglum', '').catch(reason => setActionError(String(reason))); }}>Use derived</Button></Show></div> });
  }
  async function fill() {
    setActionError('');
    const selected = docs();
    try { await perform('Missing details checked', selected.length, () => fillMissingSourceDetails(selected, props.notebook)); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <div ref={root} class="metadata-inspector" classList={{ 'metadata-inspector-phone': !!props.phone }} tabIndex={-1} aria-label="Source details">
    <header class="metadata-inspector-head">
      <Show when={props.backLabel}><Button class="metadata-back" icon="left" onClick={() => (props.onBack ?? props.onClose)()}>{props.backLabel}</Button></Show>
      <div class="metadata-inspector-heading">
        <span>{batch() ? `${docs().length} sources selected` : `${docs()[0]?.root()?.source?.siglum ?? ''} Catalogue card`}</span>
        <div><Show when={docs().length === 1}><Button class="metadata-open" onClick={event => props.onOpen({ kind: 'page', pageId: docs()[0]!.pageId }, event.shiftKey)}>Open page<Icon name="right" /></Button></Show><Button icon="close" label="Close source details" onClick={props.onClose} /></div>
      </div>
      <Show when={batch()}><p class="metadata-hint">An entered value replaces the field on all {docs().length} sources, unless a source is named.</p></Show>
    </header>
    <div class="metadata-inspector-scroll">
      <Show when={loading() || definitions.loading && !definitions() || evidence.loading}><p class="metadata-hint" role="status">Loading source details…</p></Show>
      <Show when={loadError() || definitions.error || evidence.error}><p class="metadata-error" role="alert">{loadError() || String(definitions.error || evidence.error)}</p></Show>
      <Show when={docs().length && definitions()}>
        <InspectorGroup number={1} title="Work" summary="Title, creators" phone={props.phone}>
          {perSource('title')}{field('subtitle')}
          <div class="metadata-field"><span class="metadata-label">Creators</span><div class="metadata-field-body">
            <Show when={batch() && creatorValues().mixed} fallback={creators(docs())}>
              <SourceRegister docs={docs()} label="Creators per source" summary={`${creatorValues().distinct.length} values${creatorValues().empty ? ` · ${creatorValues().empty} empty` : ''} · per source`}>{doc => creators([doc])}</SourceRegister>
            </Show>
          </div></div>
          {perSource('firstPublished')}{field('originalLanguage')}
        </InspectorGroup>
        <InspectorGroup number={2} title="Edition" summary="Publication, series, language" phone={props.phone}>
          {perSource('published')}{field('publisher')}{field('edition')}{field('series')}{perSource('number')}{field('pages')}{field('language')}
        </InspectorGroup>
        <InspectorGroup number={3} title="Identifiers" summary="ISBN, DOI, arXiv, URL" phone={props.phone}>
          {field('identifiers')}{field('url')}{field('site')}
          <div class="metadata-lookup"><Button class="bordered" disabled={!ready() || !!pending() || !docs().some(doc => metadataText(current(doc, 'identifiers')))} onClick={() => { void fill(); }}>Fill missing details</Button><span class="metadata-hint">Only empty fields</span></div>
        </InspectorGroup>
        <InspectorGroup number={4} title="About" summary="Description · Cover" phone={props.phone}>
          {field('description')}
          <Show when={batch()} fallback={cover(docs())}><div class="metadata-field"><span class="metadata-label">Cover</span><div class="metadata-field-body"><SourceRegister docs={docs()} label="Covers per source" summary="Per source">{doc => cover([doc])}</SourceRegister><Button class="metadata-text-action" onClick={() => { coverDocs = docs(); coverInput.click(); }}>Replace cover on all {docs().length} sources…</Button></div></div></Show>
        </InspectorGroup>
        <InspectorGroup number={5} title="Apparatus" summary="Siglum, citation key" phone={props.phone}>
          <Show when={batch()} fallback={siglum(docs())}><div class="metadata-field"><span class="metadata-label">Siglum</span><div class="metadata-field-body"><SourceRegister docs={docs()} label="Sigla per source" summary="Per source">{doc => siglum([doc])}</SourceRegister></div></div></Show>
          {perSource('citationKey')}
        </InspectorGroup>
        <InspectorGroup number={6} title="Shelf" summary="Reading, dates, tags" phone={props.phone}>
          {field('state')}{perSource('started')}{perSource('finished')}{field('tags')}
        </InspectorGroup>
      </Show>
      <Show when={actionError()}><p class="metadata-error" role="alert">{actionError()}</p></Show>
    </div>
    <Show when={toast()}>{notice => <div class="metadata-toast" role="status"><span>{notice().label} on {notice().count} {notice().count === 1 ? 'source' : 'sources'}.</span><Show when={notice().action}><Button disabled={!!pending()} onClick={() => { void travel(notice().action === 'redo'); }}>{notice().action === 'redo' ? 'Redo' : 'Undo'}</Button></Show><Button icon="close" label="Dismiss change notice" onClick={() => setToast(undefined)} /></div>}</Show>
    <input ref={coverInput} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose cover image" onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      const selected = [...coverDocs];
      if (!file) return;
      setActionError('');
      void perform('Cover replaced', selected.length, async () => saveSourceField(selected, props.notebook, 'cover', await props.notebook.api.uploadCover(file))).catch(reason => setActionError(reason instanceof Error ? reason.message : String(reason)));
    }} />
  </div>;
}
