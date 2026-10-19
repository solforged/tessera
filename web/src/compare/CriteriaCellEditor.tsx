import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { history, undo, redo } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import type { NotebookClient } from '../document/contract';
import type { QuoteState } from '../api/types';
import { quoteTarget } from '../document/text-tokens';
import { PaneEditor } from '../outline/editor';
import { captureQuoteCompletion, completionPickKey, isQuoteCompletion, openReferenceRange, referenceCompletionAt } from '../outline/completion';
import { BlockBreadcrumb, BlockText } from '../outline/BlockText';
import type { ReferenceCompletion } from '../outline/completion';
import { plainText } from '../outline/names';
import { Popup } from '../ui/Popup';

/** The outline editor's text, references and composition rules, with a cell-sized commit boundary. */
export function CriteriaCellEditor(props: {
  id: string; text: string; label: string; notebook: NotebookClient;
  onCommit(text: string, restoreFocus: boolean, quote?: QuoteState): void; onCancel(): void;
  onTab?(text: string, direction: -1 | 1, quote?: QuoteState): void;
  onChange?(text: string): void;
}) {
  let host!: HTMLDivElement;
  let editor: PaneEditor;
  const [completion, setCompletion] = createSignal<ReferenceCompletion | null>(null);
  const [index, setIndex] = createSignal(0);
  const captures = new Map<string, QuoteState>();
  const [quoteBusy, setQuoteBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let disposed = false;
  const quoteCompletion = createMemo(() => { const state = completion(); return !!state?.blocks && isQuoteCompletion(editor.view.state.doc.toString(), state.from, state.to); });
  const key = createMemo(() => { const state = completion(); return state ? `${state.blocks ? 'blocks' : 'pages'}:${state.query}` : false; });
  const [matches] = createResource(key, async key => {
    const query = key.slice(key.indexOf(':') + 1);
    return key.startsWith('blocks:') ? (await props.notebook.api.search(query, 20)).map(hit => hit.block).filter(block => block.kind === 'block') : props.notebook.api.complete(query);
  });
  const rows = createMemo(() => (matches.error ? [] : matches() ?? []).filter(block => block.id !== props.id));
  const updateCompletion = (text: string, at: number) => {
    const next = referenceCompletionAt(text, at);
    if (next?.query !== completion()?.query) setIndex(0);
    setCompletion(next);
  };
  async function choose(at = index()) {
    const state = completion(), block = rows()[at];
    if (!state || !block || quoteBusy()) return;
    const text = editor.view.state.doc.toString();
    if (quoteCompletion()) {
      setQuoteBusy(true); setCompletion(null); setError('');
      try {
        const captured = await captureQuoteCompletion(props.notebook, block.id);
        if (disposed) return;
        if (editor.view.state.doc.toString() !== text) { setError('The quote text changed before its snapshot arrived.'); return; }
        captures.set(captured.quote.target_id, captured.quote);
        editor.view.dispatch({ changes: { from: 0, to: text.length, insert: captured.text }, selection: { anchor: captured.text.length }, userEvent: 'input.complete' });
        editor.view.focus();
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { if (!disposed) setQuoteBusy(false); }
      return;
    }
    const range = openReferenceRange(text, state.from, editor.view.state.selection.main.head, state.blocks);
    const label = 'alias' in block && typeof block.alias === 'string' ? block.alias : block.text;
    const inserted = block.kind === 'block' || /[[\]\r\n]/.test(label) ? `[[${block.id}]]` : `[[${block.id}|${label}]]`;
    setCompletion(null);
    editor.view.dispatch({ changes: { from: range.from, to: range.to, insert: inserted }, selection: { anchor: range.from + inserted.length }, userEvent: 'input.complete' });
    editor.view.focus();
  }
  onMount(() => {
    editor = new PaneEditor({
      text: (text, caret) => { props.onChange?.(text); updateCompletion(text, caret.offset); },
      input: () => false,
      label: id => { const target = props.notebook.lookup(id)(); return target ? plainText(target.text, reference => props.notebook.lookup(reference)) : undefined; },
      selection: caret => updateCompletion(editor.view.state.doc.toString(), caret.offset),
      key: (event, view) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault(); event.stopPropagation(); event.shiftKey ? redo(view) : undo(view); return true;
        }
        if (completion() && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          setIndex(value => Math.max(0, Math.min(rows().length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))));
          event.preventDefault(); event.stopPropagation(); return true;
        }
        if (completion() && completionPickKey(event)) {
          if (!matches.loading) void choose();
          event.preventDefault(); event.stopPropagation(); return true;
        }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onCancel(); return true; }
        if (event.key === 'Tab' && props.onTab) {
          event.preventDefault(); event.stopPropagation();
          const text = view.state.doc.toString();
          if (!quoteBusy()) props.onTab(text, event.shiftKey ? -1 : 1, captures.get(quoteTarget(text) ?? ''));
          return true;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault(); event.stopPropagation();
          const text = view.state.doc.toString();
          if (!quoteBusy()) props.onCommit(text, true, captures.get(quoteTarget(text) ?? ''));
          return true;
        }
        return false;
      },
      blur: () => {
        queueMicrotask(() => {
          const text = editor.view.state.doc.toString();
          if (!quoteBusy() && host.isConnected && !host.contains(document.activeElement) && !document.activeElement?.closest('.picker')) props.onCommit(text, false, captures.get(quoteTarget(text) ?? ''));
        });
      },
      composition: () => {}, mode: () => {},
    });
    editor.mount(host, props.id, props.text, props.text.length, true);
    editor.view.dispatch({ effects: StateEffect.appendConfig.of(history()), selection: { anchor: 0, head: props.text.length } });
    editor.view.contentDOM.setAttribute('aria-label', props.label);
  });
  createEffect(() => {
    const state = completion();
    if (editor) editor.markDraft(state ? openReferenceRange(editor.view.state.doc.toString(), state.from, state.to, state.blocks) : null);
  });
  onCleanup(() => { disposed = true; editor?.destroy(); });
  return <><div ref={host} class="criteria-input" aria-busy={quoteBusy()} />
    <Show when={quoteBusy()}><span class="criteria-hint" role="status">Capturing quote…</span></Show>
    <Show when={error()}><p class="pane-error" role="alert">{error()}</p></Show>
    <Show when={completion()}><Popup anchor={() => {
      const position = editor?.view.coordsAtPos(completion()?.from ?? 0);
      return position ? new DOMRect(position.left, position.top, 1, position.bottom - position.top) : host.getBoundingClientRect();
    }} width={480} class="picker" label={quoteCompletion() ? 'Quote' : completion()?.blocks ? 'Atom reference' : 'Reference completion'} role="listbox" autofocus={false} onDismiss={() => setCompletion(null)}>
      <div class="picker-list" onMouseDown={event => event.preventDefault()}>
        <Show when={matches.loading}><p class="empty-state" role="status">Searching…</p></Show>
        <Show when={matches.error}><p class="error" role="alert">Couldn’t load completion.</p></Show>
        <For each={rows()}>{(block, at) => <div class="picker-row" role="option" aria-selected={index() === at()} classList={{ selected: index() === at() }} onClick={() => void choose(at())}>
          <span class="picker-text"><BlockText text={block.text} notebook={props.notebook} interactive={false} /></span>
          <Show when={'alias' in block && block.alias}>{alias => <span class="reference-via">via {String(alias())}</span>}</Show>
          <Show when={block.kind === 'block'}><span class="picker-meta"><BlockBreadcrumb block={block} notebook={props.notebook} /></span></Show>
        </div>}</For>
        <Show when={!matches.loading && !matches.error && !rows().length}><p class="empty-state">No matching atoms.</p></Show>
      </div>
    </Popup></Show>
  </>;
}
