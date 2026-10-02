import { EditorSelection, Facet, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { render } from 'solid-js/web';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { BlockText, isStableReference, referenceLabel, textTokens } from './BlockText';
import type { Token } from './BlockText';

export interface ReferenceConfig {
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
  onReferenceMenu(id: string, anchor: HTMLElement): void;
}

interface References {
  tokens: readonly Token[];
  decorations: DecorationSet;
}

const configuration = Facet.define<ReferenceConfig>();
const refresh = StateEffect.define<null>();
const owners = new WeakMap<HTMLElement, () => void>();

class ReferenceWidget extends WidgetType {
  constructor(
    private readonly config: ReferenceConfig,
    private readonly token: Token,
    private readonly label: string,
    private readonly status: 'loading' | 'missing' | 'resolved',
    private readonly selected: boolean,
  ) { super(); }

  eq(other: ReferenceWidget): boolean {
    return this.config === other.config && this.token.value === other.token.value
      && this.label === other.label && this.status === other.status && this.selected === other.selected;
  }

  get lineBreaks(): number {
    let count = 0;
    for (let index = 0; index < this.label.length; index++) if (this.label[index] === '\n') count++;
    return count;
  }

  toDOM(): HTMLElement {
    const dom = document.createElement('span');
    dom.contentEditable = 'false';
    // Reference controls own this gesture; neither CM nor the outline should
    // move the source selection before opening a target or its menu.
    const holdCaret = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
    dom.addEventListener('pointerdown', holdCaret);
    dom.addEventListener('mousedown', holdCaret);
    owners.set(dom, render(() => <BlockText
      text={this.token.value}
      notebook={this.config.notebook}
      onOpen={this.config.onOpen}
      onReferenceMenu={this.config.onReferenceMenu}
      selection={this.selected ? [0, this.token.value.length] : null}
    />, dom));
    return dom;
  }

  destroy(dom: HTMLElement): void {
    owners.get(dom)?.();
    owners.delete(dom);
  }
}

function decorate(state: EditorState, references: readonly Token[]): References {
  const config = state.facet(configuration)[0]!;
  const ranges: Range<Decoration>[] = [];
  for (const token of references) {
    if (state.selection.ranges.some(range =>
      range.anchor > token.start && range.anchor < token.end
      || range.head > token.start && range.head < token.end)) continue;
    const target = config.notebook.lookup(token.id!)();
    const selected = state.selection.ranges.some(range => range.from <= token.start && range.to >= token.end);
    ranges.push(Decoration.replace({
      inclusive: false,
      widget: new ReferenceWidget(config, token, referenceLabel(token, target),
        target === undefined ? 'loading' : target === null ? 'missing' : 'resolved', selected),
    }).range(token.start, token.end));
  }
  return { tokens: references, decorations: Decoration.set(ranges) };
}

const references = StateField.define<References>({
  // A retained editor contains one block, never the page's outline.
  create: state => decorate(state, textTokens(state.doc.toString()).filter(isStableReference)),
  update: (value, transaction) => {
    if (!transaction.docChanged && !transaction.selection && !transaction.effects.some(effect => effect.is(refresh))) return value;
    return decorate(transaction.state, transaction.docChanged
      ? textTokens(transaction.state.doc.toString()).filter(isStableReference) : value.tokens);
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

/** Install once in the retained editor, with the pane's existing callbacks. */
export function referenceExtension(config: ReferenceConfig): Extension {
  return [configuration.of(config), references,
    EditorView.atomicRanges.of(view => view.state.field(references).decorations)];
}

/** Refresh labels/layout after the pane's reactive reference-cache reads change. */
export function refreshReferences(view: EditorView): void {
  if (!view.state.field(references, false)) return;
  view.dispatch({ effects: refresh.of(null) });
  view.requestMeasure();
}

/** Expose literal source before an unmodified horizontal arrow enters a label. */
export function enterReference(view: EditorView, key: 'ArrowLeft' | 'ArrowRight', extend: boolean): boolean {
  const value = view.state.field(references, false);
  const selection = view.state.selection;
  if (!value || !extend && selection.ranges.some(range => !range.empty)) return false;
  let entered = false;
  const ranges = selection.ranges.map(range => {
    let inside: number | undefined;
    value.decorations.between(range.head, range.head, (from, to) => {
      if (key === 'ArrowRight' && from === range.head) inside = from + 1;
      else if (key === 'ArrowLeft' && to === range.head) inside = to - 1;
    });
    if (inside === undefined) return range;
    entered = true;
    return extend ? EditorSelection.range(range.anchor, inside) : EditorSelection.cursor(inside);
  });
  if (!entered) return false;
  view.dispatch({ selection: EditorSelection.create(ranges, selection.mainIndex), scrollIntoView: true });
  return true;
}
