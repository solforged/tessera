import { For, Show } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { LibraryFacets, LibraryFilters } from '../api/types';
import { formatSourceValue } from '../outline/source';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';

export type BrowseField = keyof LibraryFilters;

export interface BrowseEntry {
  field: BrowseField;
  value: string | number;
  label: string;
  count: number;
}

export const browseFields: { field: BrowseField; label: string }[] = [
  { field: 'people', label: 'People' },
  { field: 'decades', label: 'Decades' },
  { field: 'years', label: 'Years' },
  { field: 'publishers', label: 'Publishers' },
  { field: 'languages', label: 'Languages' },
];

// Small libraries do not need a rail beside their sources.
export const browseRailMinimum = 20;
const browseLimit = 6;
export const railFields = browseFields.filter(section => section.field !== 'years');

const browsePlaceholders: Record<BrowseField | 'all', string> = {
  all: 'Find a person, decade, publisher or language',
  people: 'Find a person',
  decades: 'Find a decade',
  years: 'Find a year',
  publishers: 'Find a publisher',
  languages: 'Find a language',
};

export const clearedFilters = (): LibraryFilters => ({
  people: [],
  decades: [],
  years: [],
  publishers: [],
  languages: [],
});

export function computeBrowseEntries(facets: LibraryFacets | undefined): BrowseEntry[] {
  if (!facets) return [];
  // People without a page cannot be filtered by id, so Browse leaves them out.
  return [
    ...facets.people.flatMap(person =>
      person.id ? [{ field: 'people' as const, value: person.id, label: person.name, count: person.count }] : [],
    ),
    ...facets.decades.map(decade => ({
      field: 'decades' as const,
      value: decade.decade,
      label: `${decade.decade}s`,
      count: decade.count,
    })),
    ...(facets.years ?? []).map(year => ({
      field: 'years' as const,
      value: year.year,
      label: String(year.year),
      count: year.count,
    })),
    ...facets.publishers.map(publisher => ({
      field: 'publishers' as const,
      value: publisher.value,
      label: publisher.value,
      count: publisher.count,
    })),
    ...facets.languages.map(language => ({
      field: 'languages' as const,
      value: language.value,
      label: formatSourceValue('language', language.value),
      count: language.count,
    })),
  ];
}

export function LibraryChosenFilters(props: {
  filters: { field: BrowseField; value: string | number; label: string }[];
  onToggle(field: BrowseField, value: string | number): void;
  onClear(): void;
}) {
  return (
    <div class="library-filter library-chosen" role="group" aria-label="Browse filters">
      <For each={props.filters}>
        {item => (
          <Button
            class="bordered library-chip"
            aria-label={`Remove filter ${item.label}`}
            onClick={() => props.onToggle(item.field, item.value)}
          >
            {item.label}
            <Icon name="close" />
          </Button>
        )}
      </For>
      <Button onClick={props.onClear}>Clear filters</Button>
    </div>
  );
}

export function LibraryBrowseRail(props: {
  entries: Accessor<BrowseEntry[]>;
  chosen(field: BrowseField, value: string | number): boolean;
  onToggle(field: BrowseField, value: string | number): void;
  onOpenField(field: BrowseField, anchor: HTMLElement): void;
}) {
  return (
    <nav class="library-browse" aria-label="Browse library" aria-hidden={props.entries().length ? undefined : 'true'}>
      <For each={railFields}>
        {section => {
          const entries = () => props.entries().filter(entry => entry.field === section.field);
          // The commonest values, plus any chosen value further down.
          const shown = () =>
            entries().filter((entry, at) => at < browseLimit || props.chosen(entry.field, entry.value));
          return (
            <Show when={entries().length}>
              <section class="library-browse-section" aria-label={section.label}>
                <h3 class="library-browse-heading">{section.label}</h3>
                <For each={shown()}>
                  {entry => (
                    <Button
                      class="library-browse-item"
                      aria-pressed={props.chosen(entry.field, entry.value)}
                      onClick={() => props.onToggle(entry.field, entry.value)}
                    >
                      <span class="library-browse-label">{entry.label}</span>
                      <span class="library-browse-count">{entry.count}</span>
                    </Button>
                  )}
                </For>
                <Show when={entries().length > shown().length}>
                  <Button
                    class="library-browse-more"
                    aria-haspopup="dialog"
                    onClick={event => props.onOpenField(section.field, event.currentTarget)}
                  >
                    All {entries().length}
                  </Button>
                </Show>
              </section>
            </Show>
          );
        }}
      </For>
    </nav>
  );
}

export function LibraryBrowsePicker(props: {
  anchor: HTMLElement;
  field: BrowseField | null;
  query: string;
  onQuery: Setter<string>;
  entries: BrowseEntry[];
  chosen(field: BrowseField, value: string | number): boolean;
  onToggle(field: BrowseField, value: string | number): void;
  onDismiss(): void;
}) {
  const items = () =>
    props.entries.filter(
      entry =>
        railFields.some(section => section.field === entry.field) &&
        (!props.field || entry.field === props.field) &&
        entry.label.toLocaleLowerCase().includes(props.query.trim().toLocaleLowerCase()),
    );
  return (
    <Picker
      anchor={props.anchor}
      label={
        props.field
          ? `Browse ${browseFields.find(item => item.field === props.field)!.label.toLowerCase()}`
          : 'Browse library'
      }
      class="library-browse-picker"
      width={360}
      placeholder={browsePlaceholders[props.field ?? 'all']}
      query={props.query}
      onQuery={props.onQuery}
      items={items()}
      key={entry => `${entry.field}:${entry.value}`}
      section={props.field ? undefined : entry => railFields.find(item => item.field === entry.field)!.label}
      row={entry => (
        <>
          <span class="library-browse-check">
            <Show when={props.chosen(entry.field, entry.value)}>
              <Icon name="check" />
            </Show>
          </span>
          <span class="library-browse-label">{entry.label}</span>
          <span class="library-browse-count">{entry.count}</span>
        </>
      )}
      onPick={entry => {
        props.onToggle(entry.field, entry.value);
        props.onDismiss();
      }}
      empty="Nothing matches"
      onDismiss={props.onDismiss}
    />
  );
}
