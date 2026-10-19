import { createEffect, createMemo, createResource, createSignal, For, Show, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Query } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { foldName } from '../outline/names';
import { Button } from '../ui/Button';
import { notePredicates, parseNoteFind } from './finding-aid';
import type { NotePredicate } from './finding-aid';
import '../table/table.css';
import './notes.css';


/** Both layouts edit the same query; resolved predicates store stable page IDs. */
export function NoteFind(props: { query: Query; plural: string; notebook: NotebookClient; onChange(query: Query): void; children?: JSX.Element }) {
  const [draft, setDraft] = createSignal(props.query.text ?? '');
  const [focused, setFocused] = createSignal(false);
  const [problem, setProblem] = createSignal('');
  let generation = 0;
  createEffect(() => { const text = props.query.text ?? ''; if (!untrack(focused)) setDraft(text); });
  const pending = createMemo(() => /\b(links|from|cites):"?([^"\n]*)$/.exec(draft()));
  const [sources] = createResource(() => pending()?.[1] === 'cites', enabled => enabled ? props.notebook.api.kindNotes('source') : undefined);
  const [completion] = createResource(() => pending()?.[2] ?? false, async text => {
    return props.notebook.api.complete(text, 8);
  });
  const options = createMemo(() => {
    const result = (completion() ?? []).map(page => ({ id: page.id, title: page.text, alias: page.alias }));
    if (pending()?.[1] === 'cites') {
      const source = sources(); const key = foldName(pending()?.[2] ?? '');
      for (const note of source?.notes ?? []) {
        const detail = source?.summaries[note.id]?.source;
        if (detail && [detail.siglum, detail.citation_key ?? ''].some(value => foldName(value).includes(key)) && !result.some(item => item.id === note.id)) result.push({ id: note.id, title: note.title, alias: detail.siglum });
      }
      return result.filter(item => source?.summaries[item.id]?.source).slice(0, 8);
    }
    return result;
  });
  const commit = async (text: string) => {
    const token = ++generation;
    const parsed = parseNoteFind(text);
    let next = { ...props.query, text: parsed.text || null, offset: 0, filters: [...props.query.filters, ...parsed.filters.map(term => term.filter).filter(filter => !props.query.filters.some(existing => existing.field === filter.field && existing.op === filter.op && existing.value === filter.value))] };
    let remaining = text;
    for (const term of parsed.filters) remaining = remaining.replace(term.raw, '').trim();
    let missing = '';
    for (const term of parsed.terms) {
      const matches = await props.notebook.api.resolveName(term.value);
      const ids = new Set(matches.map(match => match.page.id));
      if (term.key === 'cites') {
        const source = sources() ?? await props.notebook.api.kindNotes('source');
        for (const note of source.notes) {
          const detail = source.summaries[note.id]?.source;
          if (detail && [detail.siglum, detail.citation_key ?? ''].some(value => foldName(value) === foldName(term.value))) ids.add(note.id);
        }
        for (const id of ids) if (!source.summaries[id]?.source) ids.delete(id);
      }
      if (token !== generation) return;
      if (ids.size !== 1) { missing = `No atom named “${term.value}”`; continue; }
      const id = [...ids][0]!;
      next = { ...next, [term.key]: [...new Set([...(next[term.key] ?? []), id])] };
      remaining = remaining.replace(term.raw, '').trim();
    }
    if (token !== generation) return;
    setProblem(missing); setDraft(remaining); props.onChange(next);
  };
  const choose = (id: string) => {
    const match = pending(); if (!match) return;
    generation++;
    const key = match[1] as NotePredicate;
    const rest = draft().slice(0, match.index).trim();
    setDraft(rest); setProblem(''); setFocused(false);
    props.onChange({ ...props.query, text: rest || null, offset: 0, [key]: [...new Set([...(props.query[key] ?? []), id])] });
  };
  const input = (text: string) => {
    generation++; setDraft(text); setProblem('');
    // Plain words filter immediately; colon terms resolve when completed or submitted.
    if (!/\b(links|from|cites|is|revisit):/.test(text)) props.onChange({ ...props.query, text: text.trim() || null, offset: 0 });
    else if ((parseNoteFind(text).terms.length || parseNoteFind(text).filters.length) && (/"\s*$/.test(text) || /\s$/.test(text))) void commit(text).catch(reason => setProblem(String(reason)));
  };
  return <div class="note-find">
    <div class="note-find-line"><div class="note-find-input">
      <input class="input" aria-label={`Find in ${props.plural}`} placeholder={`Find in ${props.plural}…`} value={draft()} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); if (/\b(links|from|cites|is|revisit):/.test(draft())) void commit(draft()).catch(reason => setProblem(String(reason))); }} onInput={event => input(event.currentTarget.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); void commit(draft()).catch(reason => setProblem(String(reason))); }
        if (event.key === 'Escape') setFocused(false);
      }} />
      <Show when={focused() && pending() && options().length}><div class="note-find-completion" role="listbox" aria-label="Atom names"><For each={options()}>{item => <Button role="option" onMouseDown={event => event.preventDefault()} onClick={() => choose(item.id)}>{item.title}<Show when={item.alias}><span class="faint"> · {item.alias}</span></Show></Button>}</For></div></Show>
    </div>{props.children}</div>
    <Show when={problem()}><p class="note-find-problem" role="status">{problem()}</p></Show>
    <Show when={notePredicates.some(key => props.query[key]?.length)}><div class="table-query-chips"><For each={notePredicates}>{key => <For each={props.query[key] ?? []}>{id => <span class="table-chip">{key}: {props.notebook.lookup(id)()?.text ?? id}<Button label={`Remove ${key}: ${props.notebook.lookup(id)()?.text ?? id}`} onClick={() => props.onChange({ ...props.query, [key]: props.query[key]?.filter(value => value !== id), offset: 0 })}>×</Button></span>}</For>}</For></div></Show>
  </div>;
}
