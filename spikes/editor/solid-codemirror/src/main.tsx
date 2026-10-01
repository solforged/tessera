import { batch, For, onMount } from 'solid-js';
import { createMemo, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { render } from 'solid-js/web';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { defaultKeymap, insertNewline } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
import { getCM, vim, Vim } from '@replit/codemirror-vim';
import { generateOutline, readOptions, REFERENCE, selectionText } from '@spike/shared';
import type { OutlineRow, Selection, SpikeApi, VimMode } from '@spike/shared';
import type { SetStoreFunction } from 'solid-js/store';
import type { Change, Operation } from './commands';
import { collapsed, deleteSelection, indent, inverse, merge, move, split } from './commands';
import { OutlineIndex } from '../../react-codemirror/src/outline-index';
import './style.css';

interface RowStore extends OutlineRow {
  active: boolean;
  selected: boolean;
  alive: boolean;
}
interface Entry {
  row: RowStore;
  set: SetStoreFunction<RowStore>;
}

function App() {
  const options = readOptions();
  const initial = generateOutline(options.rows);
  const outline = new OutlineIndex(initial);
  const entries = new Map<string, Entry>();
  const hosts = new Map<string, HTMLDivElement>();
  const [orderRevision, setOrderRevision] = createSignal(0);
  const order = createMemo(renderOrder);
  for (const row of initial) ensure(row);
  let focused = initial[0]!.id;
  let current = collapsed({ id: focused, offset: 0 });
  let view: EditorView;
  let synchronizing = false;
  let composing = false;
  let compositionStart: { text: string; selection: Selection } | null = null;
  let vimChangeStart: { id: string; text: string; selection: Selection } | null = null;
  let painted = new Set<string>();
  let fresh = 0;
  const undoStack: Change[] = [];
  const redoStack: Change[] = [];

  function ensure(row: OutlineRow): Entry {
    const existing = entries.get(row.id);
    if (existing) return existing;
    const [value, set] = createStore<RowStore>({ ...row, active: false, selected: false, alive: true });
    const entry = { row: value, set };
    entries.set(row.id, entry);
    return entry;
  }

  function renderOrder(): string[] {
    orderRevision();
    return outline.ids();
  }

  function model(): OutlineRow[] {
    return outline.toArray();
  }

  function paintSelection() {
    const next = new Set<string>();
    if (current.anchor.id !== current.head.id) {
      const a = outline.indexOf(current.anchor.id);
      const b = outline.indexOf(current.head.id);
      for (const row of outline.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(row.id);
    }
    batch(() => {
      for (const id of painted) if (!next.has(id)) entries.get(id)!.set('selected', false);
      for (const id of next) if (!painted.has(id)) entries.get(id)!.set('selected', true);
    });
    painted = next;
  }

  function mode(): VimMode | null {
    if (!options.vim || !view) return null;
    const state = getCM(view)?.state.vim;
    return state?.insertMode ? 'insert' : state?.visualMode ? 'visual' : 'normal';
  }

  function focusSelection(selection: Selection, preserveMode = true) {
    finishVimChange();
    const wasInsert = preserveMode && mode() === 'insert';
    const id = selection.head.id;
    const row = entries.get(id)!.row;
    synchronizing = true;
    batch(() => {
      entries.get(focused)!.set('active', false);
      entries.get(id)!.set('active', true);
    });
    focused = id;
    current = selection;
    hosts.get(id)!.append(view.dom);
    view.setState(makeState(row.text, selection.head.offset));
    if (wasInsert && options.vim) Vim.handleKey(getCM(view)!, 'i', 'user');
    view.focus();
    synchronizing = false;
    paintSelection();
    view.dispatch({ effects: EditorView.scrollIntoView(selection.head.offset, { y: 'nearest' }) });
  }

  function apply(operations: Operation[]) {
    batch(() => {
      let orderChanged = false;
      for (const operation of operations) {
        if (operation.kind === 'text') {
          outline.setText(operation.id, operation.after);
          entries.get(operation.id)!.set('text', operation.after);
        } else if (operation.kind === 'depth') {
          for (const row of outline.shiftDepth(operation.index, operation.count, operation.delta)) entries.get(row.id)!.set('depth', row.depth);
        } else if (operation.kind === 'move') {
          outline.move(operation.from, operation.count, operation.to);
          orderChanged ||= operation.from !== operation.to;
        } else {
          const retained = new Set(operation.after.map(row => row.id));
          for (const row of operation.before) if (!retained.has(row.id)) entries.get(row.id)!.set('alive', false);
          outline.splice(operation.index, operation.before.length, operation.after);
          for (const row of operation.after) ensure(row).set({ ...row, alive: true });
          orderChanged = true;
        }
      }
      if (orderChanged) setOrderRevision(value => value + 1);
    });
  }

  function perform(change: Change | null) {
    if (!change) return;
    finishVimChange();
    apply(change.operations);
    undoStack.push(change);
    redoStack.length = 0;
    focusSelection(change.after);
  }

  function undo() {
    finishVimChange();
    const change = undoStack.pop();
    if (!change) return;
    apply([...change.operations].reverse().map(inverse));
    redoStack.push(change);
    focusSelection(change.before);
  }

  function redo() {
    finishVimChange();
    const change = redoStack.pop();
    if (!change) return;
    apply(change.operations);
    undoStack.push(change);
    focusSelection(change.after);
  }

  function textChanged(text: string, selection: Selection) {
    const entry = entries.get(focused)!;
    const before = entry.row.text;
    const previous = current;
    entry.set('text', text);
    outline.setText(focused, text);
    current = selection;
    if (before !== text && !composing && !vimChangeStart) {
      undoStack.push({ operations: [{ kind: 'text', id: focused, before, after: text }], before: previous, after: selection });
      redoStack.length = 0;
    }
    paintSelection();
  }

  function finishComposition() {
    if (!compositionStart) return;
    const start = compositionStart;
    compositionStart = null;
    composing = false;
    const text = entries.get(focused)!.row.text;
    if (start.text !== text && !vimChangeStart) {
      undoStack.push({ operations: [{ kind: 'text', id: focused, before: start.text, after: text }], before: start.selection, after: current });
      redoStack.length = 0;
    }
  }

  function finishVimChange() {
    if (!vimChangeStart) return;
    const start = vimChangeStart;
    vimChangeStart = null;
    const text = entries.get(start.id)!.row.text;
    if (start.text !== text) {
      undoStack.push({ operations: [{ kind: 'text', id: start.id, before: start.text, after: text }], before: start.selection, after: current });
      redoStack.length = 0;
    }
  }

  function atEdge(direction: -1 | 1): boolean {
    const head = view.state.selection.main.head;
    const position = view.coordsAtPos(head);
    const boundary = view.coordsAtPos(direction === -1 ? 0 : view.state.doc.length);
    return position !== null && boundary !== null && Math.abs(position.top - boundary.top) < 3;
  }

  function navigate(direction: -1 | 1, extend: boolean): boolean {
    if (!atEdge(direction)) return false;
    const index = outline.indexOf(focused) + direction;
    if (index < 0 || index >= outline.length) return false;
    const id = outline.at(index).id;
    const previous = current;
    const target = entries.get(id)!.row.text;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const column = view.state.selection.main.head - line.from;
    const lineStart = direction === -1 ? target.lastIndexOf('\n') + 1 : 0;
    const lineEnd = direction === -1 ? target.length : (target.indexOf('\n') < 0 ? target.length : target.indexOf('\n'));
    const offset = extend ? (direction === -1 ? 0 : target.length) : Math.min(lineStart + column, lineEnd);
    const head = { id, offset };
    focusSelection(extend ? { anchor: previous.anchor, head } : collapsed(head));
    return true;
  }

  function copy(): string {
    const a = outline.indexOf(current.anchor.id);
    const b = outline.indexOf(current.head.id);
    return selectionText(outline.slice(Math.min(a, b), Math.max(a, b) + 1), current);
  }

  function keydown(event: KeyboardEvent): boolean {
    if (composing || view.composing || event.isComposing || event.keyCode === 229) {
      // The IME owns Enter. Do not let CodeMirror turn its commit key into a newline.
      if (event.key === 'Enter') {
        event.preventDefault();
        return true;
      }
      return false;
    }
    const mod = event.metaKey || event.ctrlKey;
    const cross = current.anchor.id !== current.head.id;
    const normal = options.vim && mode() === 'normal';
    if (options.vim && event.key === 'Escape') queueMicrotask(finishVimChange);
    if (normal && !mod && ['i', 'a', 'I', 'A', 'o', 'O', 'c', 'C', 's', 'S'].includes(event.key) && !vimChangeStart) {
      vimChangeStart = { id: focused, text: entries.get(focused)!.row.text, selection: current };
    }
    let handled = true;
    if (mod && event.key.toLowerCase() === 'z') event.shiftKey ? redo() : undo();
    else if (normal && event.key === 'u' && !mod) undo();
    else if (normal && event.ctrlKey && event.key === 'r') redo();
    else if (mod && event.key.toLowerCase() === 'c' && cross) {
      void navigator.clipboard.writeText(copy());
    } else if (event.key === 'Backspace' && cross) perform(deleteSelection(outline, current));
    else if (event.key === 'Enter') {
      if (event.shiftKey) insertNewline(view);
      else {
        if (cross) perform(deleteSelection(outline, current));
        perform(split(outline, current, `s${(++fresh).toString(36)}`));
      }
    } else if (event.key === 'Backspace' && view.state.selection.main.empty && view.state.selection.main.head === 0) {
      perform(merge(outline, current));
    } else if (event.key === 'Tab') perform(indent(outline, current, event.shiftKey));
    else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) perform(move(outline, current, event.key === 'ArrowUp' ? -1 : 1));
    else if (event.key === 'ArrowUp' || (normal && event.key === 'k')) handled = navigate(-1, event.shiftKey);
    else if (event.key === 'ArrowDown' || (normal && event.key === 'j')) handled = navigate(1, event.shiftKey);
    else if (cross && !mod && event.key.length === 1) {
      perform(deleteSelection(outline, current));
      handled = false;
    } else handled = false;
    if (handled) event.preventDefault();
    return handled;
  }

  function makeState(text: string, offset: number): EditorState {
    return EditorState.create({
      doc: text,
      selection: EditorSelection.cursor(Math.min(offset, text.length)),
      extensions: [
        Prec.highest(EditorView.domEventHandlers({
          keydown,
          compositionstart() {
            composing = true;
            compositionStart = { text: entries.get(focused)!.row.text, selection: current };
            return false;
          },
          compositionend() {
            // CodeMirror's final composition mutation arrives after this event.
            setTimeout(finishComposition, 30);
            return false;
          },
          copy(event) {
            if (current.anchor.id === current.head.id) return false;
            event.clipboardData?.setData('text/plain', copy());
            event.preventDefault();
            return true;
          },
        })),
        ...(options.vim ? [vim()] : []),
        keymap.of(defaultKeymap),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': { color: '#d7dce5', backgroundColor: 'transparent', fontSize: '15px' },
          '.cm-content': { fontFamily: 'system-ui', padding: '0', lineHeight: '24px', minHeight: '24px' },
          '.cm-line': { padding: '0' },
          '.cm-scroller': { fontFamily: 'system-ui', overflow: 'visible' },
          '.cm-cursor': { borderLeftColor: '#91b9ff' },
          '&.cm-focused': { outline: 'none' },
          '.cm-selectionBackground': { background: '#33466a !important' },
        }, { dark: true }),
        EditorView.updateListener.of(update => {
          if (synchronizing) return;
          if (update.docChanged) {
            const main = update.state.selection.main;
            textChanged(update.state.doc.toString(), { anchor: { id: focused, offset: main.anchor }, head: { id: focused, offset: main.head } });
          } else if (update.selectionSet) {
            const main = update.state.selection.main;
            current = { anchor: { id: focused, offset: main.anchor }, head: { id: focused, offset: main.head } };
            paintSelection();
          }
        }),
      ],
    });
  }

  function ReferenceText(props: { row: RowStore }) {
    return <>{(() => {
      const text = props.row.text;
      const parts = [];
      let start = 0;
      for (const match of text.matchAll(REFERENCE)) {
        parts.push(text.slice(start, match.index));
        const target = entries.get(match[1]!);
        parts.push(<span class="reference">{target?.row.alive ? target.row.text : match[0]}</span>);
        start = match.index! + match[0].length;
      }
      parts.push(text.slice(start));
      return parts;
    })()}</>;
  }

  onMount(() => {
    entries.get(focused)!.set('active', true);
    view = new EditorView({ state: makeState(initial[0]!.text, 0), parent: hosts.get(focused)! });
    // CodeMirror skips its DOM handlers during composition, before our extension
    // can consume Enter. Capture the native commit key before that skip.
    view.contentDOM.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (composing || view.composing || event.isComposing)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    view.focus();
    const api: SpikeApi = {
      name: 'solid-codemirror',
      focus(index, offset) {
        const id = index >= 0 && index < outline.length ? outline.at(index).id : undefined;
        if (id) focusSelection(collapsed({ id, offset: Math.max(0, Math.min(offset, entries.get(id)!.row.text.length)) }), false);
      },
      model,
      selection: () => ({ anchor: { ...current.anchor }, head: { ...current.head } }),
      vimMode: mode,
      copyText: copy,
    };
    window.spike = api;
  });

  return <main class="pane">
    <header><h1>Editor foundations</h1><p>Solid + CodeMirror · {options.rows.toLocaleString()} fully mounted blocks{options.vim ? ' · Vim' : ''}</p></header>
    <section class="outline" aria-label="Outline">
      <For each={order()}>{id => {
        const row = entries.get(id)!.row;
        return <div class="row" data-id={id} data-depth={row.depth} classList={{ focused: row.active, selected: row.selected }} style={{ 'padding-left': `${8 + row.depth * 24}px` }}>
          <span class="bullet" aria-hidden="true">•</span>
          <div class="row-body" onMouseDown={event => {
            if (!row.active) {
              event.preventDefault();
              focusSelection(collapsed({ id, offset: row.text.length }));
            }
          }}>
            <div class="static-text" style={{ display: row.active ? 'none' : 'block' }}><ReferenceText row={row} /></div>
            <div class="editor-host" ref={element => hosts.set(id, element)} />
          </div>
        </div>;
      }}</For>
    </section>
  </main>;
}

render(() => <App />, document.getElementById('root')!);
