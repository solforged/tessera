import { Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import { api, exportExtensions } from '../api/client';
import type { ExportFormat } from '../api/client';
import type { Citation, ReadingState } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OutlinePaneProps } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { downloadBlob } from '../ui/download';
import { ResourceImage } from '../library/ResourceImage';
import { formatProgress } from '../library/query';
import { shortSourceTitle } from './source';
import { DetailsForm } from '../library/DetailsForm';
import { saveDetails, sourceMetadata } from '../library/details';
import { Popup } from '../ui/Popup';
import '../library/library.css';

const stateLabels: Record<ReadingState, string> = { inbox: 'Inbox', reading: 'Reading', finished: 'Finished', abandoned: 'Abandoned' };

export function SourceHeader(props: {
  doc: PageDocument; notebook: NotebookClient;
  onOpen: OutlinePaneProps['onOpen']; onError(message: string): void;
  resetItems(): MenuItem[];
  onDelete?: OutlinePaneProps['onDelete'];
}) {
  const [source] = createResource(() => props.notebook.changeSequence(), () => api.source(props.doc.pageId));
  const [menu, setMenu] = createSignal<{ anchor: HTMLElement; label: string; items: MenuItem[] } | null>(null);
  const snapshot = createMemo(() => source()?.snapshots.find(snapshot => snapshot.id === source()?.source.current_snapshot_id));
  const [fields, { mutate: setFields }] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.fields());
  const metadata = createMemo(() => sourceMetadata(props.doc, props.notebook, fields()?.fields ?? []));
  const cover = createMemo(() => metadata().cover ?? snapshot()?.metadata.cover);
  const [details, setDetails] = createSignal<HTMLElement>();
  const [result, setResult] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let coverInput!: HTMLInputElement;
  function closeDetails() {
    const outline = details()?.closest<HTMLElement>('.outline-pane');
    setDetails(undefined);
    outline?.focus({ preventScroll: true });
  }
  async function fillMissing() {
    const identifier = metadata().identifiers[0];
    if (!identifier || busy()) return;
    setBusy(true); setResult('');
    try {
      const preview = await props.notebook.api.lookup(identifier);
      const filled = await saveDetails(props.doc, props.notebook, { ...preview.metadata, title: metadata().title, cover: cover() ? null : preview.cover_url }, true);
      setResult(filled ? `Filled ${filled} details` : 'Nothing to fill');
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  }
  const [expanded, setExpanded] = createSignal(false);
  const [overflows, setOverflows] = createSignal(false);
  const [descriptionElement, setDescriptionElement] = createSignal<HTMLParagraphElement>();
  createEffect(() => { snapshot()?.metadata.description; setExpanded(false); });
  createEffect(() => {
    const element = descriptionElement();
    snapshot()?.metadata.description;
    if (!element) { setOverflows(false); return; }
    const measure = () => setOverflows(element.scrollHeight > Number.parseFloat(getComputedStyle(element).lineHeight) * 3 + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    onCleanup(() => observer.disconnect());
  });
  const fail = (error: unknown) => props.onError(error instanceof Error ? error.message : String(error));
  function stateMenu(anchor: HTMLElement) {
    setMenu({ anchor, label: 'Reading state', items: (Object.keys(stateLabels) as ReadingState[]).map(state => ({
      label: stateLabels[state], icon: props.doc.root()?.source?.state === state ? 'check' : undefined,
      action: () => {
        const current = props.doc.root()?.source;
        if (!current) return;
        const result = props.doc.edit({ kind: 'source', id: props.doc.pageId, value: { ...current, state } });
        if (!result.ok) { fail(result.reason); return; }
        void props.doc.flush().catch(fail);
      },
    })) });
  }
  async function exportSource(format: ExportFormat) {
    try {
      const blob = await api.exportSources(format, [props.doc.pageId]);
      downloadBlob(blob, `${props.doc.root()?.source?.citation_key ?? props.doc.pageId}.${exportExtensions[format]}`);
    } catch (error) { fail(error); }
  }
  async function sourceMenu(anchor: HTMLElement) {
    if (!fields()) {
      try { setFields(await props.notebook.api.fields()); }
      catch (error) { fail(error); return; }
    }
    setMenu({ anchor, label: 'Source actions', items: [
      ...props.resetItems(),
      { label: 'Copy citation key', icon: 'copy', disabledReason: props.doc.root()?.source?.citation_key ? undefined : 'No citation key', action: () => { void navigator.clipboard.writeText(props.doc.root()!.source!.citation_key!).catch(fail); } },
      { label: 'Edit details…', action: () => setDetails(anchor) },
      { label: 'Replace cover…', action: () => coverInput.click() },
      ...(metadata().identifiers.length ? [{ label: 'Fill missing details', disabledReason: busy() ? 'Looking up…' : undefined, action: () => { void fillMissing(); } }] : []),
      { label: 'Export BibTeX', icon: 'download', action: () => { void exportSource('bibtex'); } },
      { label: 'Export CSL JSON', icon: 'download', action: () => { void exportSource('csl'); } },
      { label: 'Export Markdown', icon: 'download', action: () => { void exportSource('markdown'); } },
      { label: 'Snapshots', icon: 'history', disabledReason: source.error ? String(source.error) : !source()?.snapshots.length ? 'No snapshots' : undefined,
        action: () => setMenu({ anchor, label: 'Snapshots', items: (source()?.snapshots ?? []).map(snapshot => ({
          label: `${new Date(snapshot.attached_at).toLocaleDateString()} · ${snapshot.passage_count} ${snapshot.passage_count === 1 ? 'passage' : 'passages'}`,
          action: () => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId, snapshotId: snapshot.id }, false),
        })) }) },
      ...(props.onDelete ? [{ label: 'Delete source…', icon: 'trash' as const, danger: true, action: () => props.onDelete!(anchor) }] : []),
    ] });
  }
  return <>
    <div class="outline-source-header">
      <Show when={cover()}>{href => <Show when={snapshot()} fallback={<div class="outline-source-cover button"><ResourceImage snapshotId="" href={href()} loading="lazy" alt="" /></div>}>
        <Button class="outline-source-cover" label="Read" onClick={event => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId }, event.shiftKey)}>
          <ResourceImage snapshotId={snapshot()!.id} href={href()} loading="lazy" alt="" />
        </Button>
      </Show>}</Show>
      <div class="outline-source-info">
        <div class="outline-source-summary">
          <Show when={source()?.source.siglum}>{siglum => <span class="source-siglum" title="Siglum: add a Siglum field to change it">{siglum()}</span>}</Show>
          <span>{{ epub: 'EPUB', article: 'Article', record: 'Record' }[props.doc.root()!.source!.format]}</span>
          <Show when={!source.error && source() && source()!.progress > 0}><span class="outline-source-progress" aria-label="Reading position" title="Reading position">{formatProgress(source()!.progress)}</span></Show>
        </div>
        <div class="outline-source-actions">
          <Button aria-haspopup="menu" onClick={event => stateMenu(event.currentTarget)}>{stateLabels[props.doc.root()!.source!.state]}<Icon name="down" /></Button>
          <Show when={snapshot()}><Button class="bordered" icon="book" onClick={event => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId }, event.shiftKey)}>Read</Button></Show>
          <Button icon="more" label="Source actions" aria-haspopup="menu" onClick={event => { void sourceMenu(event.currentTarget); }} />
        </div>
        <Show when={snapshot()?.metadata.description}>{description => <div class="outline-source-description">
          <p ref={setDescriptionElement} classList={{ expanded: expanded() }}>{description()}</p>
          <Show when={overflows()}><Button class="text-button" aria-expanded={expanded()} onClick={() => setExpanded(value => !value)}>{expanded() ? 'Less' : 'More'}</Button></Show>
        </div>}</Show>
      </div>
    </div>
    <Show when={source.error}><p class="outline-capability-error" role="alert">{String(source.error)}</p></Show>
    <Show when={menu()}>{state => <Menu {...state()} onDismiss={() => setMenu(null)} />}</Show>
    <input ref={coverInput} hidden type="file" aria-label="Choose cover image" accept="image/png,image/jpeg,image/webp" onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      if (file) void props.notebook.api.uploadCover(file).then(cover => saveDetails(props.doc, props.notebook, { ...metadata(), cover }, false, true)).catch(fail);
    }} />
    <Show when={result()}><p class="library-message" role="status">{result()}</p></Show>
    <Show when={details()}>{anchor => <Popup anchor={anchor()} placement="top" label="Edit details" class="library-add" onDismiss={closeDetails}>
      <h2 class="popup-title">Edit details</h2>
      <DetailsForm metadata={metadata()} submitLabel="Save" onCancel={closeDetails} onSave={async metadata => { await saveDetails(props.doc, props.notebook, metadata); closeDetails(); }} />
    </Popup>}</Show>
  </>;
}

/** Short source title and passage number; opens the reader at the cited range. */
export function CitationChip(props: { citation: Citation; pageId: string; notebook: NotebookClient; onOpen: OutlinePaneProps['onOpen'] }) {
  const title = () => shortSourceTitle(props.notebook.lookup(props.citation.source_id)()?.text ?? 'Source');
  return <Button class={`outline-planning outline-citation${props.citation.source_id === props.pageId ? ' outline-citation-local' : ''}`} title={`Passage ${props.citation.ordinal + 1}${props.citation.chapter_title ? ` · ${props.citation.chapter_title}` : ''}`} onClick={event => props.onOpen({
    kind: 'reader', sourceId: props.citation.source_id, snapshotId: props.citation.snapshot_id,
    at: props.citation.start.passage_id, citationId: props.citation.id,
  }, event.shiftKey)}><span class={`highlight-color-dot highlight-color-${props.citation.color ?? 'none'}`} aria-hidden="true" /><span><Show when={props.citation.source_id !== props.pageId}>{title()} · </Show>¶{props.citation.ordinal + 1}</span></Button>;
}
