import { cursorCharLeft, cursorCharRight, selectCharLeft, selectCharRight, standardKeymap } from '@codemirror/commands';
import { Compartment, EditorSelection, EditorState, Facet, Prec, StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, drawSelection, EditorView, keymap, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type * as VimModule from '@replit/codemirror-vim';
import type { Caret } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { fieldEntryId } from '../table/query';
import { Icon } from '../ui/Icon';

type FieldResolver = (id: string) => string | undefined;
const fieldName = Facet.define<FieldResolver, FieldResolver>({ combine: values => values.at(-1) ?? (() => undefined) });

class FieldNameWidget extends WidgetType {
  constructor(private readonly name: string) { super(); }
  eq(other: FieldNameWidget): boolean { return this.name === other.name; }
  toDOM(): HTMLElement {
    const label = document.createElement('span');
    label.className = 'field-entry-widget';
    label.append(Icon({ name: 'field' }) as SVGElement, document.createTextNode(this.name));
    return label;
  }
}

function fieldDecoration(state: EditorState): DecorationSet {
  const id = fieldEntryId(state.doc.toString());
  const name = id ? state.facet(fieldName)(id) : undefined;
  return name === undefined ? Decoration.none
    : Decoration.set([Decoration.replace({ widget: new FieldNameWidget(name) }).range(0, state.doc.length)]);
}
const fieldDecorations = StateField.define<DecorationSet>({
  create: fieldDecoration,
  update: (value, transaction) => transaction.docChanged || transaction.startState.facet(fieldName) !== transaction.state.facet(fieldName)
    ? fieldDecoration(transaction.state) : value,
  provide: field => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of(view => view.state.field(field)),
  ],
});

/** Whole field entries retain their raw text but expose only atomic name widgets. */
export function fieldEntryExtension(resolve: FieldResolver): Extension {
  return [
    fieldName.of(resolve),
    fieldDecorations,
    EditorView.domEventHandlers({
      keydown: (event, view) => {
        if (event.altKey || event.ctrlKey || event.metaKey || !view.state.field(fieldDecorations).size) return false;
        if (event.key === 'ArrowLeft') return (event.shiftKey ? selectCharLeft : cursorCharLeft)(view);
        if (event.key === 'ArrowRight') return (event.shiftKey ? selectCharRight : cursorCharRight)(view);
        return false;
      },
    }),
    EditorState.transactionFilter.of(transaction => {
      const state = transaction.state;
      const id = fieldEntryId(state.doc.toString());
      if (!id || state.facet(fieldName)(id) === undefined) return transaction;
      const end = state.doc.length;
      const boundary = (offset: number) => offset > 0 && offset < end ? offset < end / 2 ? 0 : end : offset;
      const ranges = state.selection.ranges.map(range => EditorSelection.range(boundary(range.anchor), boundary(range.head)));
      const selection = EditorSelection.create(ranges, state.selection.mainIndex);
      return selection.eq(state.selection) ? transaction : [transaction, { selection, sequential: true }];
    }),
  ];
}
const refreshLabels = StateEffect.define<null>();

class ReferenceWidget extends WidgetType {
  constructor(readonly label: string) { super(); }
  eq(other: ReferenceWidget): boolean { return this.label === other.label; }
  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('span');
    dom.className = 'outline-reference';
    dom.textContent = this.label;
    dom.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    dom.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      view.dispatch({ selection: { anchor: view.posAtDOM(dom) + 2 } });
      view.focus();
    });
    return dom;
  }
}

/** Endpoints remain atomic; placing the caret inside a token exposes its source. A whole field entry is the field widget's job. */
export function referenceDecorations(text: string, head: number, label: EditorHooks['label']): DecorationSet {
  if (fieldEntryId(text) !== null) return Decoration.none;
  return Decoration.set(textTokens(text).flatMap(token => {
    if (token.kind !== 'reference' || /[\r\n]/.test(token.value) || head > token.start && head < token.end) return [];
    return [Decoration.replace({ inclusive: false, widget: new ReferenceWidget(token.alias || label(token.id!) || token.id!) }).range(token.start, token.end)];
  }));
}

function references(label: EditorHooks['label']) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = referenceDecorations(view.state.doc.toString(), view.state.selection.main.head, label); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshLabels)))) {
        this.decorations = referenceDecorations(update.state.doc.toString(), update.state.selection.main.head, label);
      }
    }
  }, {
    decorations: plugin => plugin.decorations,
    provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.decorations ?? Decoration.none),
  });
}

const pairs: Record<string, { open: string; close: string }> = { '[': { open: '[[', close: ']]' }, '(': { open: '((', close: '))' } };
const closers: Record<string, { open: string; close: string }> = { ']': pairs['[']!, ')': pairs['(']! };
/**
 * As in Roam and Logseq, a second `[` or `(` closes its pair, and typing a closer inside an open pair steps
 * over the one already there. Returns the text to insert at `at` and the caret after it, or null for plain input.
 */
export function pairInput(doc: string, at: number, text: string): { insert: string; caret: number } | null {
  const pair = pairs[text];
  if (pair) {
    const before = doc.slice(Math.max(0, at - 2), at);
    if (before.at(-1) !== text || before === pair.open || doc[at] === pair.close[0]) return null;
    return { insert: text + pair.close, caret: at + 1 };
  }
  const closer = closers[text];
  if (!closer || doc[at] !== text) return null;
  const prefix = doc.slice(0, at);
  return prefix.lastIndexOf(closer.open) > prefix.lastIndexOf(closer.close) ? { insert: '', caret: at + 1 } : null;
}
const bracketPairs = EditorView.inputHandler.of((view, from, to, text) => {
  const range = view.state.selection.main;
  if (from !== to || view.state.selection.ranges.length > 1 || range.from !== from) return false;
  const result = pairInput(view.state.doc.toString(), from, text);
  if (!result) return false;
  view.dispatch(result.insert
    ? { changes: { from, insert: result.insert }, selection: { anchor: result.caret }, userEvent: 'input.type' }
    : { selection: { anchor: result.caret }, userEvent: 'select' });
  return true;
});

const setDraft = StateEffect.define<{ from: number; to: number } | null>();
const draftMark = Decoration.mark({ class: 'outline-reference-draft' });
/** The `[[query]]` a picker is completing, tinted until a choice replaces it. */
const draftReference = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setDraft)) {
      const range = effect.value;
      const to = range ? Math.min(range.to, transaction.state.doc.length) : 0;
      return range && to > range.from ? Decoration.set([draftMark.range(range.from, to)]) : Decoration.none;
    }
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

export interface EditorHooks {
  text(text: string, caret: Caret): void;
  label(id: string): string | undefined;
  selection(caret: Caret): void;
  key(event: KeyboardEvent, view: EditorView): boolean;
  blur(): void;
  composition(active: boolean, committed?: string): void;
  mode(mode: 'insert' | 'normal' | 'visual'): void;
}

/** Vim loads on first use; most sessions never turn it on. */
let vimModule: Promise<typeof VimModule> | undefined;
/** A single retained CM instance moves between row hosts; composition never moves it. */
export class PaneEditor {
  readonly view: EditorView;
  private readonly vimConfig = new Compartment();
  private readonly fieldConfig = new Compartment();
  private replacing = false;
  id = '';
  composing = false;
  private useVim = false;
  private wantVim = false;
  private vimApi: typeof VimModule | null = null;

  constructor(private readonly hooks: EditorHooks) {
    this.view = new EditorView({ state: EditorState.create({ extensions: [
      EditorView.lineWrapping,
      drawSelection(),
      references(hooks.label),
      bracketPairs,
      draftReference,
      keymap.of(standardKeymap),
      EditorView.theme({
        '&': { background: 'transparent', color: 'inherit', font: 'inherit' },
        '.cm-content': { padding: '0', minHeight: '24px', fontFamily: 'inherit', caretColor: 'var(--accent)' },
        '.cm-line': { padding: '0' },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': { font: 'inherit', overflow: 'visible', lineHeight: 'inherit' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'var(--text-selection)' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'currentColor', borderLeftWidth: '2px' },
        '&.cm-focused .cm-fat-cursor': { background: 'currentColor', color: 'var(--canvas)', outline: 'none' },
        '&:not(.cm-focused) .cm-fat-cursor': { outline: '1px solid currentColor' },
      }),
      this.vimConfig.of([]),
      this.fieldConfig.of(fieldEntryExtension(() => undefined)),
      Prec.highest(EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (event.isComposing || this.composing || view.composing || event.keyCode === 229) return false;
          return this.hooks.key(event, view);
        },
        blur: () => { if (!this.replacing && !this.composing) this.hooks.blur(); return false; },
        compositionstart: () => { this.composing = true; this.hooks.composition(true); return false; },
        compositionend: event => { this.composing = false; this.hooks.composition(false, event.data); return false; },
      })),
      EditorView.updateListener.of(update => {
        const caret = { id: this.id, offset: update.state.selection.main.head };
        if (!this.replacing && this.id && update.docChanged) this.hooks.text(update.state.doc.toString(), caret);
        if (!this.replacing && this.id && (update.selectionSet || update.docChanged)) this.hooks.selection(caret);
        this.reportMode();
      }),
    ] }) });
    this.view.contentDOM.setAttribute('aria-label', 'Block text');
    // CM skips extension key handlers during composition. The native commit
    // key belongs to the IME, not contenteditable's default newline insertion.
    this.view.contentDOM.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (this.composing || this.view.composing || event.isComposing || event.keyCode === 229)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  configure(enabled: boolean): void {
    this.wantVim = enabled;
    if (!enabled) {
      if (!this.useVim) return;
      this.useVim = false;
      this.view.dispatch({ effects: this.vimConfig.reconfigure([]) });
      this.reportMode();
      return;
    }
    if (this.useVim) return;
    void (vimModule ??= import('@replit/codemirror-vim')).then(api => {
      if (!this.wantVim || this.useVim) return;
      this.vimApi = api;
      this.useVim = true;
      this.view.dispatch({ effects: this.vimConfig.reconfigure(api.vim()) });
      this.reportMode();
    });
  }

  configureFields(resolve: FieldResolver): void {
    this.view.dispatch({ effects: this.fieldConfig.reconfigure(fieldEntryExtension(resolve)) });
  }

  mode(): 'insert' | 'normal' | 'visual' {
    const state = this.useVim ? this.vimApi?.getCM(this.view)?.state.vim : undefined;
    return !this.useVim || state?.insertMode ? 'insert' : state?.visualMode ? 'visual' : 'normal';
  }

  reportMode(): void { this.hooks.mode(this.mode()); }
  forwardVim(event: KeyboardEvent): boolean {
    if (!this.useVim || !this.vimApi || this.mode() === 'insert' || event.metaKey || event.altKey) return false;
    const keys: Record<string, string> = { Backspace: '<BS>', Delete: '<Del>', Enter: '<CR>', Escape: '<Esc>', ArrowLeft: '<Left>', ArrowRight: '<Right>', ArrowUp: '<Up>', ArrowDown: '<Down>', Tab: '<Tab>' };
    const key = keys[event.key] ?? (event.key.length === 1 ? event.ctrlKey ? `<C-${event.key}>` : event.key : null);
    const cm = this.vimApi.getCM(this.view);
    if (!key || !cm) return false;
    this.vimApi.Vim.handleKey(cm, key, 'outline');
    this.reportMode();
    return true;
  }

  mount(host: HTMLElement, id: string, text: string, offset: number, insert: boolean, focus = true): void {
    if (this.composing && id !== this.id) return;
    this.replacing = true;
    const changed = id !== this.id || text !== this.view.state.doc.toString();
    this.id = id;
    if (changed) this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: EditorSelection.cursor(Math.min(offset, text.length)),
    });
    else this.view.dispatch({ selection: EditorSelection.cursor(Math.min(offset, text.length)) });
    host.append(this.view.dom);
    this.replacing = false;
    if (this.useVim && this.vimApi && insert) {
      const cm = this.vimApi.getCM(this.view);
      if (cm && !cm.state.vim?.insertMode) this.vimApi.Vim.handleKey(cm, 'i', 'outline');
    }
    if (focus) this.view.focus();
    this.view.requestMeasure();
    this.reportMode();
  }

  sync(text: string): void {
    if (this.composing || text === this.view.state.doc.toString()) return;
    this.replacing = true;
    const offset = Math.min(this.view.state.selection.main.head, text.length);
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, selection: { anchor: offset } });
    this.replacing = false;
  }

  refreshLabels(): void { this.view.dispatch({ effects: refreshLabels.of(null) }); }
  /** Completion state changes inside editor updates, so the mark follows in a microtask. */
  markDraft(range: { from: number; to: number } | null): void {
    queueMicrotask(() => { if (this.view.dom.isConnected) this.view.dispatch({ effects: setDraft.of(range) }); });
  }

  destroy(): void { this.view.destroy(); }
}
