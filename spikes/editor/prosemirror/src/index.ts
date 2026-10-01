import { generateOutline, readOptions, selectionText } from '@spike/shared';
import { history, redo, undo } from 'prosemirror-history';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { backspace, deleteCrossSelection, indent, move, outline, rowAt, rowBlock, schema, selection, split, vertical } from './outline';
import { references } from './references';
import './style.css';

const options = readOptions();
const status = document.querySelector<HTMLElement>('#status')!;
status.textContent = `${options.rows.toLocaleString()} mounted blocks${options.vim ? ' · Vim unavailable (see spike comparison)' : ''}`;
let composing = false;

const view = new EditorView(document.querySelector<HTMLElement>('#editor')!, {
  state: EditorState.create({
    schema,
    doc: schema.nodes.doc!.create(undefined, generateOutline(options.rows).map(rowBlock)),
    plugins: [history(), references()],
  }),
  attributes: { role: 'textbox', 'aria-label': 'Outline editor', 'aria-multiline': 'true', spellcheck: 'false' },
  handleDOMEvents: {
    compositionstart: () => { composing = true; return false; },
    compositionend: () => { composing = false; return false; },
    keydown: (editor, event) => {
      if (event.key === 'Enter' && (composing || editor.composing || event.isComposing || event.keyCode === 229)) {
        event.preventDefault();
        return true;
      }
      return false;
    },
    copy: (editor, event) => {
      const selected = selection(editor.state);
      if (selected.anchor.id === selected.head.id) return false;
      event.clipboardData?.setData('text/plain', selectionText(outline(editor.state.doc), selected));
      event.preventDefault();
      return true;
    },
  },
  handleKeyDown: (editor, event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'c') {
      const selected = selection(editor.state);
      if (selected.anchor.id !== selected.head.id) {
        void navigator.clipboard.writeText(selectionText(outline(editor.state.doc), selected));
        return true;
      }
    }
    if (mod && event.key.toLowerCase() === 'z') return (event.shiftKey ? redo : undo)(editor.state, editor.dispatch, editor);
    if (event.altKey && event.key === 'ArrowUp') return move(editor, -1);
    if (event.altKey && event.key === 'ArrowDown') return move(editor, 1);
    if (event.key === 'Tab') return indent(editor, event.shiftKey ? -1 : 1);
    if (event.key === 'Enter') {
      if (event.shiftKey) {
        const cross = deleteCrossSelection(editor.state);
        const tr = cross ?? editor.state.tr;
        editor.dispatch(tr.insertText('\n').scrollIntoView());
        return true;
      }
      return split(editor);
    }
    if (event.key === 'Backspace') return backspace(editor);
    if (!mod && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return vertical(editor, event.key === 'ArrowUp' ? 'up' : 'down', event.shiftKey);
    return false;
  },
  handleTextInput: (editor, _from, _to, text) => {
    const tr = deleteCrossSelection(editor.state);
    if (!tr) return false;
    editor.dispatch(tr.insertText(text).scrollIntoView());
    return true;
  },
});

window.spike = {
  name: 'prosemirror',
  focus: (index, offset) => {
    const row = rowAt(view.state.doc, Math.min(Math.max(0, index), view.state.doc.childCount - 1));
    const position = row.before + 1 + Math.min(Math.max(0, offset), row.block.content.size);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)).scrollIntoView());
    view.focus();
  },
  model: () => outline(view.state.doc),
  selection: () => view.hasFocus() ? selection(view.state) : null,
  // No mature ProseMirror Vim engine satisfies the spike. The minimal published
  // prose-motions lacks required motions/text objects; vim-prosemirror 0.2.1
  // ships no exported dist files. Ordinary editing remains available and Vim
  // is deliberately reported unavailable, rather than simulating modal editing.
  vimMode: () => null,
  copyText: () => selectionText(outline(view.state.doc), selection(view.state)),
};
