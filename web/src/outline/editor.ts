import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView } from '@codemirror/view';
import { getCM, Vim, vim } from '@replit/codemirror-vim';
import type { Caret } from '../document/contract';

export interface EditorHooks {
  text(text: string, caret: Caret): void;
  selection(caret: Caret): void;
  key(event: KeyboardEvent, view: EditorView): boolean;
  blur(): void;
  composition(active: boolean, committed?: string): void;
  mode(mode: 'insert' | 'normal' | 'visual'): void;
}

/** A single retained CM instance moves between row hosts; composition never moves it. */
export class PaneEditor {
  readonly view: EditorView;
  private readonly vimConfig = new Compartment();
  private replacing = false;
  id = '';
  composing = false;
  private useVim = false;

  constructor(private readonly hooks: EditorHooks) {
    this.view = new EditorView({ state: EditorState.create({ extensions: [
      EditorView.lineWrapping,
      drawSelection(),
      EditorView.theme({
        '&': { background: 'transparent', color: 'inherit', font: 'inherit' },
        '.cm-content': { padding: '0', minHeight: '24px', fontFamily: 'inherit', caretColor: 'var(--accent)' },
        '.cm-line': { padding: '0' },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': { font: 'inherit', overflow: 'visible', lineHeight: 'inherit' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'var(--selection)' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
        '&.cm-focused .cm-fat-cursor': { background: 'var(--accent)', color: 'var(--canvas)', outline: 'none' },
        '&:not(.cm-focused) .cm-fat-cursor': { outline: '1px solid var(--accent)' },
      }),
      this.vimConfig.of([]),
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
    if (enabled === this.useVim) return;
    this.useVim = enabled;
    this.view.dispatch({ effects: this.vimConfig.reconfigure(enabled ? vim() : []) });
    this.reportMode();
  }

  mode(): 'insert' | 'normal' | 'visual' {
    const state = getCM(this.view)?.state.vim;
    return !this.useVim || state?.insertMode ? 'insert' : state?.visualMode ? 'visual' : 'normal';
  }

  reportMode(): void { this.hooks.mode(this.mode()); }
  forwardVim(event: KeyboardEvent): boolean {
    if (!this.useVim || this.mode() === 'insert' || event.metaKey || event.altKey) return false;
    const keys: Record<string, string> = { Backspace: '<BS>', Delete: '<Del>', Enter: '<CR>', Escape: '<Esc>', ArrowLeft: '<Left>', ArrowRight: '<Right>', ArrowUp: '<Up>', ArrowDown: '<Down>', Tab: '<Tab>' };
    const key = keys[event.key] ?? (event.key.length === 1 ? event.ctrlKey ? `<C-${event.key}>` : event.key : null);
    const cm = getCM(this.view);
    if (!key || !cm) return false;
    Vim.handleKey(cm, key, 'outline');
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
    if (this.useVim && insert) {
      const cm = getCM(this.view);
      if (cm && !cm.state.vim?.insertMode) Vim.handleKey(cm, 'i', 'outline');
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

  destroy(): void { this.view.destroy(); }
}
