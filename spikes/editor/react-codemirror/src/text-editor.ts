import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { getCM, vim, Vim } from '@replit/codemirror-vim';
import { selectionText } from '@spike/shared';
import type { Caret, Selection, VimMode } from '@spike/shared';
import { caretSelection, deleteSelection, indent, merge, move, split } from './commands';
import type { Command } from './commands';
import type { DocumentStore } from './store';

export class TextEditor {
  private view: EditorView;
  private id: string | null = null;
  private composing = false;
  private compositionGroup = false;
  private counter = 0;
  private syncing = false;
  constructor(private store: DocumentStore, private enabledVim: boolean, private activate: (caret: Caret, selection?: Selection) => void) {
    this.view = new EditorView({ state: this.state('', 0) });
    this.view.contentDOM.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.isComposing || this.composing || this.view.composing)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }
  private state(text: string, offset: number) {
    return EditorState.create({
      doc: text, selection: EditorSelection.cursor(offset),
      extensions: [
        EditorView.lineWrapping,
        Prec.highest(EditorView.domEventHandlers({
          keydown: event => this.key(event),
          compositionstart: () => {
            this.composing = true;
            this.compositionGroup = true;
            this.store.beginTextGroup();
            return false;
          },
          compositionend: () => { this.composing = false; return false; },
          copy: event => {
            const selection = this.store.selection;
            if (!selection || selection.anchor.id === selection.head.id) return false;
            event.clipboardData?.setData('text/plain', selectionText(this.store.model(), selection));
            event.preventDefault();
            return true;
          },
        })),
        ...(this.enabledVim ? [vim()] : []),
        keymap.of(defaultKeymap),
        EditorView.updateListener.of(update => {
          if (this.syncing || !this.id) return;
          const range = update.state.selection.main;
          const next: Selection = { anchor: { id: this.id, offset: range.anchor }, head: { id: this.id, offset: range.head } };
          if (update.docChanged) {
            const before = update.startState.selection.main;
            this.store.text(this.id, update.state.doc.toString(), { anchor: { id: this.id, offset: before.anchor }, head: { id: this.id, offset: before.head } }, next);
          } else if (update.selectionSet && this.store.selection?.anchor.id === this.store.selection?.head.id) this.store.setSelection(next);
        }),
        EditorView.theme({ '&': { color: '#d7dce5' }, '.cm-content': { fontFamily: 'inherit' } }, { dark: true }),
      ],
    });
  }
  focus(host: HTMLElement, caret: Caret) {
    const mode = this.vimMode();
    const text = this.store.getRow(caret.id).text;
    this.syncing = true;
    if (this.id !== caret.id || this.view.state.doc.toString() !== text) {
      this.id = caret.id;
      this.view.setState(this.state(text, Math.min(caret.offset, text.length)));
      if (this.enabledVim && mode === 'insert') {
        const cm = getCM(this.view);
        if (cm) Vim.handleKey(cm, 'i', 'api');
      }
    } else this.view.dispatch({ selection: EditorSelection.cursor(caret.offset) });
    host.append(this.view.dom);
    this.syncing = false;
    this.view.focus();
    this.view.dispatch({ effects: EditorView.scrollIntoView(caret.offset, { y: 'nearest' }) });
  }
  vimMode(): VimMode | null {
    if (!this.enabledVim) return null;
    const state = getCM(this.view)?.state.vim;
    return state?.insertMode ? 'insert' : state?.visualMode ? 'visual' : 'normal';
  }
  private execute(command: Command | null) {
    this.store.endTextGroup();
    let selection: Selection | null = null;
    // Structural list updates must land before the active editor is moved.
    selection = this.store.execute(command);
    if (selection) this.activate(selection.head, selection);
  }
  private history(redo: boolean) {
    this.store.endTextGroup();
    const selection = redo ? this.store.redo() : this.store.undo();
    if (selection) this.activate(selection.head, selection);
  }
  private adjacent(down: boolean, extend: boolean): boolean {
    if (!this.id) return false;
    const range = this.view.state.selection.main;
    const current = this.view.coordsAtPos(range.head);
    const edge = this.view.coordsAtPos(down ? this.view.state.doc.length : 0);
    if (current && edge && Math.abs(current.top - edge.top) > 1) return false;
    const nextIndex = this.store.outline.indexOf(this.id) + (down ? 1 : -1);
    if (nextIndex < 0 || nextIndex >= this.store.outline.length) return false;
    const nextId = this.store.outline.at(nextIndex).id;
    const text = this.store.getRow(nextId).text;
    const caret = { id: nextId, offset: extend ? (down ? text.length : 0) : Math.min(range.head, text.length) };
    const anchor = extend ? (this.store.selection?.anchor ?? { id: this.id, offset: range.anchor }) : caret;
    this.activate(caret, { anchor, head: caret });
    return true;
  }
  private key(event: KeyboardEvent): boolean {
    if (!this.id) return false;
    const mod = event.metaKey || event.ctrlKey;
    const selection = this.store.selection ?? caretSelection({ id: this.id, offset: this.view.state.selection.main.head });
    const consume = (action: () => void) => { event.preventDefault(); action(); return true; };
    if (mod && event.key.toLowerCase() === 'z') return consume(() => this.history(event.shiftKey));
    if (event.isComposing || this.composing || this.view.composing) {
      if (event.key === 'Enter') return consume(() => {});
      return false;
    }
    if (this.compositionGroup) {
      this.compositionGroup = false;
      this.store.endTextGroup();
    }
    if (event.key === 'Escape') this.store.endTextGroup();
    if (this.vimMode() === 'normal' && ['i', 'a', 'c', 'I', 'A', 'C'].includes(event.key)) {
      const pending = getCM(this.view)?.state.vim?.inputState.keyBuffer.length;
      if (!pending) this.store.beginTextGroup();
    }
    if (selection.anchor.id !== selection.head.id && (event.key === 'Backspace' || event.key === 'Delete')) return consume(() => this.execute(deleteSelection(this.store.outline, selection)));
    if (event.key === 'Tab') return consume(() => this.execute(indent(this.store.outline, selection, event.shiftKey)));
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return consume(() => this.execute(move(this.store.outline, selection, event.key === 'ArrowDown')));
    if (event.key === 'Enter' && !event.shiftKey) return consume(() => this.execute(split(this.store.outline, selection, `new-${++this.counter}`)));
    if (event.key === 'Enter' && event.shiftKey) return consume(() => {
      const range = this.view.state.selection.main;
      this.view.dispatch({ changes: { from: range.from, to: range.to, insert: '\n' }, selection: EditorSelection.cursor(range.from + 1) });
    });
    if (event.key === 'Backspace' && this.view.state.selection.main.empty && this.view.state.selection.main.head === 0) return consume(() => this.execute(merge(this.store.outline, selection)));
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (this.adjacent(event.key === 'ArrowDown', event.shiftKey)) { event.preventDefault(); return true; }
    }
    if (this.vimMode() === 'normal' && !mod && !event.altKey) {
      const pending = getCM(this.view)?.state.vim?.inputState.keyBuffer.length;
      if (!pending && event.key === 'u') return consume(() => this.history(false));
      if (!pending && (event.key === 'j' || event.key === 'k') && this.adjacent(event.key === 'j', false)) { event.preventDefault(); return true; }
    }
    return false;
  }
}
