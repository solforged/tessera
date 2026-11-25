import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { FieldDefinition, FieldValue, QueryAttributeValue } from '../api/types';
import { opensBeside } from '../core/beside';
import type { OpenTarget } from '../core/contract';
import { fieldEntryId } from '../core/field-entry';
import type { WorkshopClient } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { fieldLabel } from '../fields/kinds';
import { BlockText } from '../outline/BlockText';
import { plainText, targetLabel } from '../outline/names';
import { proseDate } from '../tasks/relative-date';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { sourceText } from './sources';
import type { TableSource } from './sources';

/** A relation reads as its target's name, never its stored text: titles carry their tag syntax and a citing block is a whole paragraph. */
export function TableAttributeValue(props: {
  field?: FieldDefinition;
  /** Today's date, when dates read in prose (a phone card) rather than as stored. */
  today?: string;
  values: QueryAttributeValue[];
  workshop: WorkshopClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}) {
  const choice = () => props.field?.kind === 'choice';
  return (
    <TableCellText>
      {expanded => (
        <For each={props.values}>
          {(value, index) => (
            <>
              {index() > 0 && !choice() && !(value.reading.ok && value.reading.target) ? ', ' : ''}
              <Show
                when={value.reading.ok && value.reading.target}
                fallback={
                  <span
                    classList={{
                      'table-reading-problem': !value.reading.ok,
                      'table-choice-pill': choice() && value.reading.ok && !!value.text.trim(),
                    }}
                  >
                    <BlockText
                      text={
                        props.today && props.field?.kind === 'date' && /^\d{4}-\d{2}-\d{2}/.test(value.text)
                          ? (proseDate(value.text.slice(0, 10), props.today) ?? value.text)
                          : preview(value.text, expanded)
                      }
                      workshop={props.workshop}
                      interactive={false}
                    />
                  </span>
                }
              >
                <Button
                  class="table-value-pill"
                  title={targetLabel(value.text, id => props.workshop.lookup(id)) || value.text}
                  onClick={async event => {
                    const beside = opensBeside(event);
                    const id = value.reading.ok ? value.reading.target! : '';
                    const target = props.workshop.lookup(id)() ?? (await props.workshop.api.block(id));
                    props.onOpen(
                      {
                        kind: 'page',
                        pageId: target.page_id,
                        ...(target.kind === 'block' ? { blockId: target.id } : {}),
                      },
                      beside,
                    );
                  }}
                >
                  {targetLabel(value.text, id => props.workshop.lookup(id)) || value.text}
                </Button>
              </Show>
            </>
          )}
        </For>
      )}
    </TableCellText>
  );
}

/** A drawn box, as the field bed and task rows draw one; the cell it sits in toggles it on click or Space. */
export function TableCheckbox(props: { field: FieldDefinition; checked: boolean }) {
  return (
    <span
      class="field-checkbox table-checkbox"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={fieldLabel(props.field)}
    >
      <Show when={props.checked}>
        <Icon name="check" />
      </Show>
    </span>
  );
}

export function TableFieldValue(props: {
  field: FieldDefinition | undefined;
  values: FieldValue[];
  workshop: WorkshopClient;
  hideCount?: boolean;
  /** Today's date, when dates read in prose (a phone card) rather than as typed. */
  today?: string;
  onPill(value: FieldValue, anchor: HTMLElement, beside: boolean): void;
  onSources(anchor: HTMLElement, sources: TableSource[]): void;
}) {
  const parsed = createMemo(() =>
    props.field?.kind === 'url' || props.field?.kind === 'text'
      ? props.values.map(value => ({ value, ...sourceText(value.text) }))
      : [],
  );
  const sources = createMemo(() => parsed().flatMap(value => value.sources));
  const problems = createMemo(() =>
    props.values.flatMap(value => (value.reading.ok ? [] : [value.reading.problem])).join('; '),
  );
  const checkbox = () => props.field?.kind === 'checkbox' && props.values.every(value => value.reading.ok);
  const pillValue = (value: FieldValue) =>
    (props.field?.kind === 'choice' || props.field?.kind === 'instance') && !!fieldEntryId(value.text);
  return (
    <Show
      when={!checkbox()}
      fallback={
        <TableCheckbox
          field={props.field!}
          checked={props.values.some(value => value.reading.ok && !!value.reading.value)}
        />
      }
    >
      <Show
        when={sources().length}
        fallback={
          <TableCellText>
            {expanded => (
              <For each={props.values}>
                {(value, index) => (
                  <>
                    {index() > 0 && !pillValue(value) && props.field?.kind !== 'choice' ? ', ' : ''}
                    <Show
                      when={value.reading.ok}
                      fallback={
                        <span
                          class="table-reading-problem"
                          title={!value.reading.ok ? value.reading.problem : undefined}
                        >
                          <BlockText
                            text={props.field?.kind === 'instance' ? value.text : preview(value.text, expanded)}
                            blockId={value.id}
                            workshop={props.workshop}
                            interactive={false}
                          />
                        </span>
                      }
                    >
                      <Show
                        when={pillValue(value)}
                        fallback={
                          <span
                            classList={{ 'table-choice-pill': props.field?.kind === 'choice' && !!value.text.trim() }}
                          >
                            <BlockText
                              text={
                                value.reading.ok
                                  ? props.field?.kind === 'text' || typeof value.reading.value === 'object'
                                    ? preview(value.text, expanded)
                                    : props.today &&
                                        props.field?.kind === 'date' &&
                                        typeof value.reading.value === 'string'
                                      ? (proseDate(value.reading.value, props.today) ?? value.reading.value)
                                      : String(value.reading.value)
                                  : ''
                              }
                              blockId={value.id}
                              workshop={props.workshop}
                              interactive={false}
                            />
                          </span>
                        }
                      >
                        <Button
                          class="table-value-pill"
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                          }}
                          onDblClick={event => event.stopPropagation()}
                          onClick={event => {
                            event.stopPropagation();
                            props.onPill(value, event.currentTarget, opensBeside(event));
                          }}
                        >
                          <BlockText
                            text={
                              props.field?.kind === 'instance'
                                ? value.text
                                : value.reading.ok
                                  ? String(value.reading.value)
                                  : value.text
                            }
                            blockId={value.id}
                            workshop={props.workshop}
                            interactive={false}
                          />
                        </Button>
                      </Show>
                    </Show>
                  </>
                )}
              </For>
            )}
          </TableCellText>
        }
      >
        <div class="table-source-cell">
          <Show keyed when={sources()[0]}>
            {source => (
              <div class="table-source-summary">
                <div
                  class="table-source-label"
                  classList={{ 'table-reading-problem': !!problems() }}
                  title={problems() || plainText(source.label, id => props.workshop.lookup(id))}
                >
                  <BlockText text={source.label} workshop={props.workshop} interactive={false} />
                </div>
                <Show when={source.hostname}>
                  <div class="table-source-host">{source.hostname}</div>
                </Show>
              </div>
            )}
          </Show>
          <Show when={!props.hideCount}>
            <Button
              class="table-source-count"
              label={`${props.field ? fieldLabel(props.field) : 'Sources'}: ${sources().length} ${sources().length === 1 ? 'ref' : 'refs'}`}
              aria-haspopup="dialog"
              onKeyDown={event => event.stopPropagation()}
              onDblClick={event => event.stopPropagation()}
              onClick={event => {
                event.stopPropagation();
                props.onSources(event.currentTarget, sources());
              }}
            >
              {sources().length} {sources().length === 1 ? 'ref' : 'refs'}
            </Button>
          </Show>
        </div>
        <Show when={parsed().some(value => value.remainder)}>
          <div class="table-source-remainder">
            <TableCellText>
              {expanded => (
                <For each={parsed().filter(value => value.remainder)}>
                  {(entry, index) => (
                    <>
                      {index() > 0 ? ', ' : ''}
                      <span
                        classList={{ 'table-reading-problem': !entry.value.reading.ok }}
                        title={!entry.value.reading.ok ? entry.value.reading.problem : undefined}
                      >
                        <BlockText
                          text={preview(entry.remainder, expanded)}
                          workshop={props.workshop}
                          interactive={false}
                        />
                      </span>
                    </>
                  )}
                </For>
              )}
            </TableCellText>
          </div>
        </Show>
      </Show>
    </Show>
  );
}

export function SourcesPopup(props: {
  anchor: HTMLElement;
  label: string;
  sources: TableSource[];
  workshop: WorkshopClient;
  onDismiss(): void;
}) {
  return (
    <Popup
      anchor={props.anchor}
      label={`Sources · ${props.label}`}
      class="table-sources-popup"
      onDismiss={props.onDismiss}
      width={400}
    >
      <div
        onKeyDown={event => {
          event.stopPropagation();
          if (event.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const links = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>('a[href]'));
          const index = links.indexOf(document.activeElement as HTMLAnchorElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? links.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
          links[next]?.focus();
          event.preventDefault();
        }}
      >
        <div class="table-popup-heading">
          <span>{props.label}</span>
          <span class="table-popup-count">
            {props.sources.length} {props.sources.length === 1 ? 'ref' : 'refs'}
          </span>
        </div>
        <ol class="table-source-list">
          <For each={props.sources}>
            {source => (
              <li>
                <a class="table-source-link" href={source.href} target="_blank" rel="noopener noreferrer" tabIndex={0}>
                  {plainText(source.label, id => props.workshop.lookup(id))} <span aria-hidden="true">↗</span>
                </a>
                <Show when={source.hostname}>
                  <span class="table-source-host">{source.hostname}</span>
                </Show>
                <span class="table-source-href">{source.href}</span>
              </li>
            )}
          </For>
        </ol>
      </div>
    </Popup>
  );
}

/** Clamped cells measure in batches, all reads before any write, so mounting a table lays out once. */
interface CellMeasure {
  read(): boolean;
  write(clipped: boolean): void;
}
const cellMeasures = new WeakMap<Element, CellMeasure>();
const pendingCells = new Set<CellMeasure>();
// biome-ignore lint/correctness/noUnusedVariables: `||=` below reads it to schedule one frame at a time.
let cellFrame = 0;
let cellResize: ResizeObserver | undefined;
function measureCells(cells: CellMeasure[]) {
  const clipped = cells.map(cell => cell.read());
  cells.forEach((cell, index) => cell.write(clipped[index]!));
}
function flushCells() {
  cellFrame = 0;
  const cells = [...pendingCells];
  pendingCells.clear();
  measureCells(cells);
}
function observeCell(element: Element, measure: CellMeasure): { schedule(): void; dispose(): void } {
  cellResize ??= new ResizeObserver(entries =>
    measureCells(entries.flatMap(entry => cellMeasures.get(entry.target) ?? [])),
  );
  cellMeasures.set(element, measure);
  cellResize.observe(element);
  return {
    schedule() {
      pendingCells.add(measure);
      cellFrame ||= requestAnimationFrame(flushCells);
    },
    dispose() {
      cellResize?.unobserve(element);
      cellMeasures.delete(element);
      pendingCells.delete(measure);
    },
  };
}

/** Clamped cells show three lines, so they shape only a prefix; long values otherwise dominate a large table's layout. */
const PREVIEW_CHARACTERS = 400;
export function preview(text: string, expanded: boolean): string {
  if (expanded || text.length <= PREVIEW_CHARACTERS) return text;
  let end = 0;
  for (const token of textTokens(text)) {
    if (token.start >= PREVIEW_CHARACTERS) break;
    end = token.kind === 'text' ? Math.min(token.end, PREVIEW_CHARACTERS) : token.end;
  }
  return `${text.slice(0, end)}…`;
}

export function TableCellText(props: { children: (expanded: boolean) => JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  const [clipped, setClipped] = createSignal(false);
  let content!: HTMLDivElement;
  onMount(() => {
    const cell = observeCell(content, {
      read: () => !open() && content.scrollHeight > content.clientHeight,
      write: value => {
        if (!open()) setClipped(value);
      },
    });
    const mutation = new MutationObserver(() => cell.schedule());
    mutation.observe(content, { subtree: true, childList: true, characterData: true });
    onCleanup(() => {
      cell.dispose();
      mutation.disconnect();
    });
  });
  return (
    <>
      <div ref={content} class="table-cell-clamp" classList={{ 'table-cell-open': open() }}>
        {props.children(open())}
      </div>
      <Show when={clipped()}>
        <Button
          class="table-cell-more"
          aria-expanded={open()}
          onMouseDown={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onDblClick={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            setOpen(value => !value);
          }}
        >
          {open() ? 'Less' : 'More'}
        </Button>
      </Show>
    </>
  );
}
