import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useSyncExternalStore } from 'react';
import { generateOutline, readOptions, REFERENCE, selectionText } from '@spike/shared';
import type { Caret, Selection } from '@spike/shared';
import { DocumentStore } from './store';
import { TextEditor } from './text-editor';
import './style.css';

const options = readOptions();
const store = new DocumentStore(generateOutline(options.rows));
let editor: TextEditor;
function focus(caret: Caret, selection: Selection = { anchor: caret, head: caret }) {
  flushSync(() => store.setSelection(selection));
  const host = document.querySelector<HTMLElement>(`[data-row-id="${caret.id}"] .content`);
  if (host) editor.focus(host, caret);
}
function Reference({ id, alias }: { id: string; alias?: string }) {
  const row = useSyncExternalStore(callback => store.subscribeRow(id, callback), () => store.getRow(id));
  return <span className="reference">{alias ?? row?.text ?? `[[${id}]]`}</span>;
}
function Text({ text }: { text: string }) {
  const parts = [];
  let offset = 0;
  for (const match of text.matchAll(REFERENCE)) {
    parts.push(text.slice(offset, match.index));
    parts.push(<Reference key={`${match.index}-${match[1]}`} id={match[1]} alias={match[2]} />);
    offset = match.index! + match[0].length;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}
function Row({ id }: { id: string }) {
  const { row, active, selected } = useSyncExternalStore(callback => store.subscribeRow(id, callback), () => store.getSnapshot(id));
  return <div className={`row${active ? ' active' : ''}${selected ? ' selected' : ''}`} data-row-id={id} style={{ paddingLeft: 8 + row.depth * 24 }}>
    <span className="bullet" aria-hidden="true">•</span>
    <div className="content" tabIndex={active ? -1 : 0} role={active ? undefined : 'textbox'} aria-label={`Block ${id}`} onFocus={() => { if (!active) focus({ id, offset: 0 }); }} onMouseDown={event => { if (!active) { event.preventDefault(); focus({ id, offset: row.text.length }); } }}>
      {!active && <Text text={row.text} />}
    </div>
  </div>;
}
// The projection stays in rendering; commands never materialize a page array.
function renderOrder(_revision: number) { return store.outline.ids(); }
function App() {
  const revision = useSyncExternalStore(store.subscribeOrder, store.getRevision);
  const order = renderOrder(revision);
  return <main><header><h1>React + CodeMirror</h1><span>{options.rows.toLocaleString()} mixed-height blocks · {options.vim ? 'Vim' : 'standard input'}</span></header><section aria-label="Outline">{order.map(id => <Row key={id} id={id} />)}</section></main>;
}

createRoot(document.getElementById('root')!).render(<App />);
editor = new TextEditor(store, options.vim, focus);
window.spike = {
  name: 'react-codemirror',
  focus(index, offset) {
    const row = index >= 0 && index < store.outline.length ? store.outline.at(index) : null;
    if (row) focus({ id: row.id, offset: Math.max(0, Math.min(offset, row.text.length)) });
  },
  model: store.model,
  selection: () => store.selection,
  vimMode: () => editor.vimMode(),
  copyText: () => store.selection ? selectionText(store.model(), store.selection) : '',
};
