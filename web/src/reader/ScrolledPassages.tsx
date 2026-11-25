import { For, Show, createMemo, onCleanup, onMount } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { VirtualItem } from '@tanstack/solid-virtual';
import type { ApiClient } from '../api/client';
import type { Citation, HighlightRow, Passage, SourceView, TocEntry } from '../api/types';
import type { HighlightSection } from '../library/highlights';
import type { sourceMetadata } from '../library/details';
import { ResourceImage } from '../library/ResourceImage';
import { Button } from '../ui/Button';
import { chapterEntries } from './book-map';
import { deferred } from './createReaderChrome';
import { isFrontMatter, sectionName } from './openings';
import type { Opening } from './openings';
import { timeLeft } from './paged';
import { PassageText } from './PassageText';

export interface ReaderPassageView {
  api: ApiClient;
  active: Accessor<boolean>;
  version: Accessor<number>;
  snapshot: Accessor<string>;
  source: Accessor<SourceView | undefined>;
  currentSnapshot: Accessor<SourceView['snapshots'][number] | undefined>;
  details: Accessor<ReturnType<typeof sourceMetadata>>;
  title: () => string;
  titleCover: () => string | null;
  creators: Accessor<string>;
  year: () => string | undefined;
  contents: Accessor<TocEntry[]>;
  sections: Accessor<HighlightSection[]>;
  openings: Accessor<Map<number, Opening>>;
  absorbed: Accessor<{ hidden: Set<number>; first: Set<number> }>;
  quotesAreText: Accessor<boolean>;
  cursor: Accessor<number | null>;
  citations: Accessor<Citation[]>;
  highlightNotes: Accessor<Map<string, HighlightRow>>;
  ordinals: Map<string, number>;
  passages: Map<number, Passage>;
  flashId: () => string | null;
  inkId: Accessor<string | null>;
  onJumpTo(at: string): void;
  onNote(at: string, anchor: HTMLElement): void;
  onCitation(values: Citation[], anchor: HTMLElement, beside: boolean): void;
  onHighlightNote(row: HighlightRow): void;
  onOpenSection(entry: TocEntry, begin?: boolean): void;
}

/** A section's numeral in mono, then its title in display italic, as the toolbar and the foot name it. */
export function SectionLabel(props: { title: string }) {
  const name = createMemo(() => sectionName(props.title));
  return (
    <>
      <Show when={name().numeral}>
        <b class="reader-section-numeral">{name().numeral}</b>
      </Show>
      <i class="reader-section-title">{name().title}</i>
    </>
  );
}

/** The start of the book: a small cover beside the imprint, the title and subtitle, the author, the book's length and where its text begins. */
export function ReaderTitlePage(props: { view: ReaderPassageView }) {
  const heading = createMemo(() => {
    const value = props.view.title(),
      colon = value.indexOf(':');
    return colon > 0
      ? { main: value.slice(0, colon), subtitle: value.slice(colon + 1).trim() }
      : {
          main: value,
          subtitle: props.view.details().subtitle ?? props.view.currentSnapshot()?.metadata.subtitle ?? null,
        };
  });
  const imprint = () => {
    const metadata = props.view.currentSnapshot()?.metadata;
    return [
      props.view.source()?.source.siglum,
      props.view.details().publisher ?? metadata?.publisher ?? (props.view.creators() ? null : metadata?.site),
      props.view.year(),
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const facts = () => {
    const chapters = new Set(
        chapterEntries(props.view.sections())
          .filter(entry => !isFrontMatter(entry.title))
          .map(entry => entry.ordinal),
      ).size,
      length = props.view.currentSnapshot()?.text_length ?? 0;
    return [chapters > 1 ? `${chapters} chapters` : '', length ? timeLeft(length) : ''].filter(Boolean).join(' · ');
  };
  // The first opening past the cover and front matter: the preface, or chapter one.
  const begin = createMemo(() =>
    [...props.view.openings().values()].reduce<Opening | null>(
      (first, value) => (!first || value.ordinal < first.ordinal ? value : first),
      null,
    ),
  );
  return (
    <div class="reader-title-page">
      <Show when={props.view.titleCover()}>
        {href => (
          <ResourceImage
            api={props.view.api}
            class="reader-title-cover"
            snapshotId={props.view.snapshot()}
            href={href()}
            alt=""
          />
        )}
      </Show>
      <div class="reader-title-text">
        <Show when={imprint()}>
          <p class="reader-title-imprint">{imprint()}</p>
        </Show>
        <h1>
          {heading().main}
          <Show when={heading().subtitle}>
            <span class="reader-title-subtitle">{heading().subtitle}</span>
          </Show>
        </h1>
        <Show when={props.view.creators()}>
          <p class="reader-title-author">{props.view.creators()}</p>
        </Show>
        <span class="reader-title-rule" aria-hidden="true" />
        <Show when={facts()}>
          <p class="reader-title-facts">{facts()}</p>
        </Show>
        <Show when={begin()?.ordinal ? begin() : null}>
          {value => (
            <Button
              class="reader-title-begin"
              onClick={() => {
                const entry = props.view.contents().find(item => item.ordinal === value().ordinal);
                if (entry) props.view.onOpenSection(entry, true);
              }}
            >
              Begin at {value().name}
            </Button>
          )}
        </Show>
      </div>
    </div>
  );
}

export function ReaderPassageContent(props: { view: ReaderPassageView; ordinal: number; onImageLoad(): void }) {
  const passage = createMemo(() => {
    props.view.version();
    return props.view.passages.get(props.ordinal);
  });
  return (
    <>
      <Show when={props.view.openings().get(props.ordinal)}>
        {opening => (
          <div class="reader-opening">
            <Show when={opening().part}>{part => <p class="reader-opening-part">{part().text}</p>}</Show>
            <Show when={opening().label}>
              <p class="reader-opening-label">{opening().label}</p>
            </Show>
            <h2 class="reader-opening-title">{opening().title}</h2>
            <span class="reader-opening-rule" aria-hidden="true" />
          </div>
        )}
      </Show>
      <Show when={passage()} fallback={<div class="reader-placeholder" aria-hidden="true" />}>
        {value => (
          <Dynamic
            component={
              value().kind === 'heading'
                ? `h${Math.min(3, Math.max(1, value().level ?? 1))}`
                : value().kind === 'quote' && !props.view.quotesAreText()
                  ? 'blockquote'
                  : value().kind === 'code'
                    ? 'pre'
                    : 'div'
            }
            class={`reader-passage reader-${value().kind === 'quote' && props.view.quotesAreText() ? 'paragraph' : value().kind}`}
            classList={{
              'reader-cursor': props.view.active() && props.view.cursor() === props.ordinal,
              'reader-absorbed': props.view.absorbed().hidden.has(props.ordinal),
              'reader-first': props.view.absorbed().first.has(props.ordinal),
            }}
            aria-current={props.view.active() && props.view.cursor() === props.ordinal ? 'true' : undefined}
            data-passage-id={value().id}
            data-ordinal={value().ordinal}
            style={{ '--level': Math.max(0, value().level ?? 0) }}
          >
            <Show
              when={value().kind === 'image' && value().resource}
              fallback={
                <PassageText
                  passage={value()}
                  citations={props.view.citations()}
                  notes={props.view.highlightNotes()}
                  ordinals={(() => {
                    props.view.version();
                    return props.view.ordinals;
                  })()}
                  flashId={props.view.flashId()}
                  inkId={props.view.inkId()}
                  onLocate={props.view.onJumpTo}
                  onNote={props.view.onNote}
                  onCitation={props.view.onCitation}
                  onHighlightNote={props.view.onHighlightNote}
                />
              }
            >
              <ResourceImage
                api={props.view.api}
                snapshotId={props.view.snapshot()}
                href={value().resource!}
                alt={value().text}
                onLoad={props.onImageLoad}
              />
            </Show>
          </Dynamic>
        )}
      </Show>
    </>
  );
}

function PassageRow(props: {
  view: ReaderPassageView;
  ordinal: number;
  item: () => VirtualItem;
  measure(element: HTMLDivElement): void;
}) {
  let element!: HTMLDivElement;
  onMount(() => props.measure(element));
  return (
    <div
      ref={element}
      class="reader-row"
      classList={{
        'reader-row-absorbed':
          props.view.absorbed().hidden.has(props.ordinal) && !props.view.openings().has(props.ordinal),
      }}
      data-index={props.ordinal}
      style={{ transform: `translateY(${props.item().start}px)` }}
    >
      <ReaderPassageContent view={props.view} ordinal={props.ordinal} onImageLoad={() => props.measure(element)} />
    </div>
  );
}

function TitleBlock(props: { view: ReaderPassageView; setTitleHeight: Setter<number> }) {
  let element!: HTMLDivElement;
  onMount(() => {
    const measure = () => props.setTitleHeight(element.getBoundingClientRect().height);
    const later = deferred(measure);
    const observer = new ResizeObserver(later);
    measure();
    observer.observe(element);
    onCleanup(() => {
      observer.disconnect();
      later.cancel();
      props.setTitleHeight(0);
    });
  });
  return (
    <div ref={element} class="reader-title-block">
      <ReaderTitlePage view={props.view} />
    </div>
  );
}

export function ScrolledPassages(props: {
  view: ReaderPassageView;
  totalSize: number;
  items: Accessor<Map<number, VirtualItem>>;
  setTitleHeight: Setter<number>;
  measure(element: HTMLDivElement): void;
}) {
  return (
    <div class="reader-list" style={{ height: `${props.totalSize}px` }}>
      <Show when={props.view.title()}>
        <TitleBlock view={props.view} setTitleHeight={props.setTitleHeight} />
      </Show>
      <For each={[...props.items().keys()]}>
        {ordinal => (
          <PassageRow
            view={props.view}
            ordinal={ordinal}
            item={() => props.items().get(ordinal)!}
            measure={props.measure}
          />
        )}
      </For>
    </div>
  );
}
