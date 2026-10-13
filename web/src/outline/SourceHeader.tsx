import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { api, exportExtensions } from '../api/client';
import type { ExportFormat } from '../api/client';
import type { Citation, FieldDefinition, HighlightResult, ReadingState } from '../api/types';
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
import { saveDetails, sourceEntries, sourceFieldValue, sourceMetadata } from '../library/details';
import type { SourceCreator } from '../library/details';
import { publicationReading } from '../library/publication';
import { CollectionPicker, SourceCollections, createCollectionActions } from '../library/Collections';
import { changeCollectionMembers, collectionPages, sourceCollections } from '../document/collections';
import { highlightColors } from '../library/highlights';
import { sectionLabel } from '../reader/openings';
import { timeLeft } from '../reader/paged';
import { BookMap } from '../ui/BookMap';
import { bookChapters, chapterAt } from '../ui/book-map';
import '../library/library.css';

const stateLabels: Record<ReadingState, string> = { inbox: 'Inbox', reading: 'Reading', finished: 'Finished', abandoned: 'Abandoned' };

export function SourceHeader(props: {
  doc: PageDocument; notebook: NotebookClient;
  onOpen: OutlinePaneProps['onOpen']; onError(message: string): void;
  resetItems(): MenuItem[];
  onEditDetails(): void;
  onDelete?: OutlinePaneProps['onDelete'];
  compact?: boolean;
  highlights?: HighlightResult; colors: string[]; grouped: boolean; fieldsVisible: boolean;
  fields: readonly FieldDefinition[]; ready: boolean; onReady(ready: boolean): void;
  onColors(colors: string[]): void; onGrouped(grouped: boolean): void; onFieldsVisible(visible: boolean): void;
}) {
  const [source] = createResource(() => props.notebook.changeSequence(), () => props.notebook.api.source(props.doc.pageId));
  const [menu, setMenu] = createSignal<{ anchor: HTMLElement; label: string; items: MenuItem[] } | null>(null);
  const snapshot = createMemo(() => source()?.snapshots.find(snapshot => snapshot.id === source()?.source.current_snapshot_id));
  const metadata = createMemo(() => sourceMetadata(props.doc, props.notebook, props.fields));
  const authored = createMemo(() => sourceEntries(props.doc, props.fields));
  const creators = createMemo(() => sourceFieldValue(props.doc, props.notebook, props.fields, 'creators') as SourceCreator[]);
  const cover = createMemo(() => metadata().cover ?? (authored().has('cover') ? null : snapshot()?.metadata.cover));
  const description = createMemo(() => metadata().description ?? (authored().has('description') ? null : snapshot()?.metadata.description));
  const [loadedCover, setLoadedCover] = createSignal<string>();
  const coverVisibility = createMemo(() => cover() && loadedCover() !== cover() ? 'hidden' as const : undefined);
  const length = createMemo(() => snapshot()?.text_length ?? 0);
  const at = createMemo(() => (source()?.progress ?? 0) * length());
  const chapters = createMemo(() => bookChapters(source()?.toc ?? [], length()));
  const current = createMemo(() => chapterAt(chapters(), at()));
  const marks = createMemo(() => (props.highlights?.rows ?? []).flatMap(row => row.citation.snapshot_id === snapshot()?.id && row.citation.position !== undefined ? [{ at: row.citation.position, color: row.color }] : []));
  const imprint = createMemo(() => [source()?.source.siglum, { epub: 'EPUB', article: 'Article', record: 'Record' }[props.doc.root()!.source!.format], metadata().publisher, publicationReading(metadata().published, source()?.snapshots)?.slice(0, 4)].filter(Boolean).join(' · '));
  const collectionActions = createCollectionActions();
  const [collectionPicker, setCollectionPicker] = createSignal<HTMLElement>();
  const [result, setResult] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const coverMedia = window.matchMedia('(max-width: 599px) and (pointer: coarse)');
  const [coverLayout, setCoverLayout] = createSignal(coverMedia.matches);
  const [actionsHost, setActionsHost] = createSignal<HTMLElement>();
  let header!: HTMLDivElement;
  const coverChanged = () => setCoverLayout(coverMedia.matches);
  coverMedia.addEventListener('change', coverChanged);
  onCleanup(() => coverMedia.removeEventListener('change', coverChanged));
  // Escape the outline's query-container containment, but keep the owning pane's visibility and nav tokens.
  onMount(() => setActionsHost(header.closest<HTMLElement>('.pane') ?? undefined));
  createEffect(() => props.onReady(!!(source() || source.error) && (props.compact || !coverLayout() || !!actionsHost())));
  let coverInput!: HTMLInputElement;
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
  createEffect(() => { description(); setExpanded(false); });
  createEffect(() => {
    const element = descriptionElement();
    description();
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
    let collections;
    try {
      const [pages, ids] = await Promise.all([collectionPages(props.notebook.api), sourceCollections(props.notebook.api, props.doc.pageId)]);
      collections = pages.filter(page => ids.includes(page.id));
    } catch (error) { fail(error); return; }
    if (!anchor.isConnected) return;
    setMenu({ anchor, label: 'Source actions', items: [
      { label: 'Edit details…', action: props.onEditDetails },
      { label: 'Copy citation key', icon: 'copy', disabledReason: props.doc.root()?.source?.citation_key ? undefined : 'No citation key', action: () => { void navigator.clipboard.writeText(props.doc.root()!.source!.citation_key!).catch(fail); } },
      { label: 'Fill missing details', disabledReason: busy() ? 'Looking up…' : !metadata().identifiers.length ? 'No identifier' : undefined, action: () => { void fillMissing(); } },
      { label: 'Replace cover…', action: () => coverInput.click() },
      { label: props.fieldsVisible ? 'Hide metadata fields' : 'Show metadata fields', action: () => props.onFieldsVisible(!props.fieldsVisible) },
      ...props.resetItems(),
      { section: 'Collections', label: 'Add to collection…', action: () => setCollectionPicker(anchor) },
      ...collections.map(collection => ({ section: 'Collections', label: `Remove from ${collection.text}`, action: () => { void collectionActions.run(`Removed from ${collection.text}`, () => changeCollectionMembers(props.notebook, collection.id, [props.doc.pageId], false)); } })),
      { section: 'Export', label: 'BibTeX', icon: 'download', action: () => { void exportSource('bibtex'); } },
      { section: 'Export', label: 'CSL JSON', icon: 'download', action: () => { void exportSource('csl'); } },
      { section: 'Export', label: 'Markdown', icon: 'download', action: () => { void exportSource('markdown'); } },
      { section: 'Organize', label: 'Snapshots', icon: 'history', disabledReason: source.error ? String(source.error) : !source()?.snapshots.length ? 'No snapshots' : undefined,
        action: () => setMenu({ anchor, label: 'Snapshots', items: (source()?.snapshots ?? []).map(snapshot => ({
          label: `${new Date(snapshot.attached_at).toLocaleDateString()} · ${snapshot.passage_count} ${snapshot.passage_count === 1 ? 'passage' : 'passages'}`,
          action: () => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId, snapshotId: snapshot.id }, false),
        })) }) },
      ...(props.onDelete ? [{ section: 'Organize', label: 'Delete source…', icon: 'trash' as const, danger: true, action: () => props.onDelete!(anchor) }] : []),
    ] });
  }
  const ReadingActions = () => <div class="outline-source-actions" classList={{ 'source-cover-actions': coverLayout() && !!actionsHost() }} style={{ visibility: props.ready ? undefined : 'hidden' }}>
    <Show when={snapshot()}><Button class="outline-source-read" onClick={event => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId }, event.shiftKey)}>{source()?.position ? 'Continue reading' : 'Read'}</Button></Show>
    <Button class="bordered" aria-haspopup="menu" onClick={event => stateMenu(event.currentTarget)}>{stateLabels[props.doc.root()!.source!.state]}<Icon name="down" /></Button>
    <Button class="bordered" icon="more" label="Source actions" aria-haspopup="menu" onClick={event => { void sourceMenu(event.currentTarget); }} />
  </div>;
  return <>
    <Show when={props.compact} fallback={<>
    <div ref={header} class="outline-source-header" classList={{ 'outline-source-coverless-article': (snapshot()?.format ?? props.doc.root()?.source?.format) === 'article' && !cover() }}>
      <Show when={snapshot()} fallback={<div class="outline-source-cover library-cover" style={{ visibility: coverVisibility() }}>
        <Show when={cover()} fallback={<span class="library-spine"><span class="library-spine-siglum">{source()?.source.siglum}</span></span>}>{href => <ResourceImage snapshotId="" href={href()} loading="eager" alt="" onLoad={() => setLoadedCover(href())} onError={() => setLoadedCover(href())} />}</Show>
      </div>}>
        <Button class="outline-source-cover library-cover" style={{ visibility: coverVisibility() }} label={source()?.position ? 'Continue reading' : 'Read'} onClick={event => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId }, event.shiftKey)}>
          <Show when={cover()} fallback={<span class="library-spine"><span class="library-spine-siglum">{source()?.source.siglum}</span></span>}>{href => <ResourceImage snapshotId={snapshot()!.id} href={href()} loading="eager" alt="" onLoad={() => setLoadedCover(href())} onError={() => setLoadedCover(href())} />}</Show>
        </Button>
      </Show>
      <div class="outline-source-info">
        <Show when={metadata().subtitle && !props.doc.root()?.text.includes(metadata().subtitle!)}><p class="outline-source-subtitle">{metadata().subtitle}</p></Show>
        <div class="outline-source-summary">
          <For each={creators()}>{creator => <Show when={creator.id} fallback={<span class="outline-source-creator">{creator.name}{creator.role === 'editor' ? ' (ed.)' : creator.role === 'translator' ? ' (trans.)' : ''}</span>}>{id => <Button class="outline-source-creator" onClick={event => props.onOpen({ kind: 'page', pageId: id() }, event.shiftKey)}>{creator.name}{creator.role === 'editor' ? ' (ed.)' : creator.role === 'translator' ? ' (trans.)' : ''}</Button>}</Show>}</For>
          <span>{imprint()}</span>
        </div>
      </div>
      <Show when={!source.error && length() > 0}><div class="outline-source-progress-block">
        <p class="outline-source-chapter">{!source()?.position ? 'Not started' : current()?.chapter.title ? sectionLabel(current()!.chapter.title) : 'Reading position'}</p>
        <BookMap chapters={chapters()} length={length()} at={at()} highlights={marks()} />
        <div class="outline-source-time"><span><Show when={source()?.position && current()?.chapter.title ? current() : null}>{value => <>{timeLeft(value().chapter.end - at())} left in chapter</>}</Show></span><span>{formatProgress(source()?.progress ?? 0)} · {timeLeft(length() - at())} left</span></div>
      </div></Show>
      <Show when={coverLayout() && actionsHost()} fallback={<ReadingActions />}>{host => <Portal mount={host()}><ReadingActions /></Portal>}</Show>
      <Show when={description()}>{text => <div class="outline-source-description">
        <p ref={setDescriptionElement} classList={{ expanded: expanded() }}>{text()}</p>
        <Show when={overflows()}><Button class="text-button" aria-expanded={expanded()} onClick={() => setExpanded(value => !value)}>{expanded() ? 'Less' : 'More'}</Button></Show>
      </div>}</Show>
    </div>
    </>}>
      <div ref={header} class="outline-source-citation">
        <div>
          <p class="outline-source-citation-imprint">{imprint()}</p>
          <Show when={metadata().creators.length}><p class="outline-source-citation-byline">{metadata().creators.map(creator => creator.name).join(' · ')}</p></Show>
        </div>
        <Button icon="book" onClick={event => props.onOpen({ kind: 'page', pageId: props.doc.pageId }, event.shiftKey)}>Open source</Button>
      </div>
    </Show>
    <Show when={props.highlights}><div class="outline-source-highlight-toolbar">
      <h2>Highlights <span>· {props.highlights!.total}</span></h2>
      <Show when={props.highlights!.total > 0}><div class="outline-source-highlight-controls">
        <div class="outline-source-highlight-colors" role="group" aria-label="Highlight colours"><For each={highlightColors}>{color => <Button class="icon-only" aria-label={`Filter ${color} highlights`} aria-pressed={props.colors.includes(color)} onClick={() => props.onColors(props.colors.includes(color) ? props.colors.filter(value => value !== color) : [...props.colors, color])}><span class={`highlight-color-dot highlight-color-${color}`} aria-hidden="true" /></Button>}</For></div>
        <Button class="outline-source-group" aria-haspopup="menu" onClick={event => setMenu({ anchor: event.currentTarget, label: 'Group highlights', items: [
          { label: 'By chapter', icon: props.grouped ? 'check' : undefined, action: () => props.onGrouped(true) },
          { label: 'Reading order', icon: !props.grouped ? 'check' : undefined, action: () => props.onGrouped(false) },
        ] })}>{props.grouped ? 'By chapter' : 'Reading order'}<Icon name="down" /></Button>
      </div></Show>
    </div></Show>
    <Show when={source.error}><p class="outline-capability-error" role="alert">{String(source.error)}</p></Show>
    <Show when={menu()}>{state => <Menu {...state()} onDismiss={() => setMenu(null)} />}</Show>
    <input ref={coverInput} hidden type="file" aria-label="Choose cover image" accept="image/png,image/jpeg,image/webp" onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      if (file) void props.notebook.api.uploadCover(file).then(cover => saveDetails(props.doc, props.notebook, { ...metadata(), cover }, false, true)).catch(fail);
    }} />
    <Show when={result()}><p class="library-message" role="status">{result()}</p></Show>
    <SourceCollections notebook={props.notebook} sourceId={props.doc.pageId} actions={collectionActions} />
    <collectionActions.Notice />
    <Show when={collectionPicker()}>{anchor => <CollectionPicker anchor={anchor()} notebook={props.notebook} sourceIds={[props.doc.pageId]} onChanged={collectionActions.record} onDismiss={() => setCollectionPicker(undefined)} />}</Show>
  </>;
}

/** Short source title and passage number; opens the reader at the cited range. */
export function CitationChip(props: { citation: Citation; pageId: string; notebook: NotebookClient; onOpen: OutlinePaneProps['onOpen'] }) {
  const title = () => shortSourceTitle(props.notebook.lookup(props.citation.source_id)()?.text ?? 'Source');
  return <Button class={`outline-planning outline-citation${props.citation.source_id === props.pageId ? ' outline-citation-local' : ''}`} title={`Passage ${props.citation.ordinal + 1}${props.citation.chapter_title ? ` · ${props.citation.chapter_title}` : ''}`} onClick={event => props.onOpen({
    kind: 'reader', sourceId: props.citation.source_id, snapshotId: props.citation.snapshot_id,
    at: props.citation.start.passage_id, citationId: props.citation.id,
  }, event.shiftKey)}><Show when={props.citation.source_id !== props.pageId}><span class={`highlight-color-dot highlight-color-${props.citation.color ?? 'none'}`} aria-hidden="true" /></Show><span><Show when={props.citation.source_id !== props.pageId}>{title()} · </Show>¶{props.citation.ordinal + 1}</span></Button>;
}
