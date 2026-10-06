import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on } from 'solid-js';
import type { TaskQuery } from '../api/types';
import { Button } from '../ui/Button';
import { formatTaskQueryLine, parseTaskQueryLine, taskQueryLineTerms } from './task-query-line';
import type { TaskQueryLineContext } from './task-query-line';

export interface TaskQueryLineProps {
  query: TaskQuery;
  context: TaskQueryLineContext;
  disabled?: boolean;
  onChange(query: TaskQuery): void;
  onDraftState(dirty: boolean, error: string): void;
}

export function TaskQueryLine(props: TaskQueryLineProps) {
  const formatted = createMemo(() => formatTaskQueryLine(props.query, props.context));
  const [draft, setDraft] = createSignal(formatted());
  const [focused, setFocused] = createSignal(false);
  const result = createMemo(() => parseTaskQueryLine(draft(), props.context));
  const terms = createMemo(() => taskQueryLineTerms(draft()));
  const errorId = createUniqueId();
  let input: HTMLInputElement | undefined;
  let highlight: HTMLDivElement | undefined;
  let previousFormatted = formatted();
  createEffect(on(() => props.query, () => setDraft(formatted()), { defer: true }));
  createEffect(on(formatted, next => {
    // Titles can hydrate after history; rewrite only an untouched spelling.
    if (draft() === previousFormatted) setDraft(next);
    previousFormatted = next;
  }, { defer: true }));
  createEffect(() => props.onDraftState(draft() !== formatted(), result().errors[0]?.message ?? ''));
  const edit = () => {
    if (props.disabled) return;
    setFocused(true);
    queueMicrotask(() => { input?.focus(); });
  };
  const apply = (text = draft()) => {
    const next = parseTaskQueryLine(text, props.context);
    setDraft(text);
    if (next.errors.length || props.disabled) return false;
    props.onChange(next.query);
    setDraft(formatTaskQueryLine(next.query, props.context));
    return true;
  };
  const remove = (start: number, end: number) => {
    const text = `${draft().slice(0, start).trimEnd()} ${draft().slice(end).trimStart()}`.trim();
    apply(text);
  };
  return <div class="task-query-line">
    <Show when={focused()} fallback={<div class="task-query-chips" role="group" aria-label="Task query" tabIndex={props.disabled ? -1 : 0} onFocus={event => { if (event.target === event.currentTarget) edit(); }} onClick={edit}>
      <For each={terms()}>{term => <span class="task-query-chip" classList={{ 'task-query-invalid': result().errors.some(error => error.start === term.start) }}>
        <span>{term.term}</span><Button disabled={props.disabled} label={`Remove ${term.term}`} onClick={event => { event.stopPropagation(); remove(term.start, term.end); }}>×</Button>
      </span>}</For>
      <Show when={!terms().length}><span class="task-query-placeholder">Filter tasks · is:todo @..fri #Book</span></Show>
    </div>}>
      <div class="task-query-editor">
        <div ref={highlight} class="task-query-highlight" aria-hidden="true"><For each={terms()}>{(term, index) => <>{draft().slice(index() ? terms()[index() - 1]!.end : 0, term.start)}<span classList={{ 'task-query-invalid': result().errors.some(error => error.start === term.start) }}>{term.term}</span></>}</For>{draft().slice(terms().at(-1)?.end ?? 0)}</div>
        <input ref={input} class="input task-query-input" aria-label="Task query" aria-invalid={result().errors.length > 0} aria-describedby={result().errors.length ? errorId : undefined} placeholder="Filter tasks · is:todo @..fri #Book" value={draft()} disabled={props.disabled} onInput={event => setDraft(event.currentTarget.value)} onScroll={event => { if (highlight) highlight.scrollLeft = event.currentTarget.scrollLeft; }} onBlur={() => { apply(); setFocused(false); }} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); if (apply()) event.currentTarget.blur(); }
        }} />
      </div>
    </Show>
    <Show when={result().errors.length}><div id={errorId} class="task-query-errors" role="alert"><For each={result().errors}>{error => <p>{error.term}: {error.message}</p>}</For></div></Show>
  </div>;
}
