import { For, Show, createMemo, createResource, createSignal, createUniqueId, onMount } from 'solid-js';
import { ulid } from 'ulid';
import type { NoteKind, Operation } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { documentReady } from '../outline/source-fields';
import { filingOperations } from '../notes/finding-aid';
import { pendingCaretInput } from '../shell/pending-caret';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import type { CreateKind } from './request';

const gistPrompt: Record<string, (noun: string) => string> = {
  note: () => 'First line, optional',
  type: noun => noun === 'person' ? 'Who they are, in a line' : noun === 'group' ? 'What the group is, in a line' : noun === 'thesis' ? 'The claim, in a sentence' : `What the ${noun} is, in a sentence`,
  question: () => 'Why it matters, in a sentence',
  project: () => 'The outcome, in a sentence',
};

export function PageDraft(props: {
  notebook: NotebookClient; kind: CreateKind; noteKind?: NoteKind; text: string; gist: string; sheet: boolean;
  onTextChange(text: string): void; onGistChange(text: string): void; onDismiss(): void;
  onCreated?(pageId: string): void; onOpen(target: OpenTarget, beside: boolean): void;
  onAdded(): void; status: string; defaultBeside?: boolean;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const id = createUniqueId();
  let title!: HTMLTextAreaElement;
  const mode = () => props.kind.startsWith('type:') ? 'type' : props.kind;
  const noun = () => props.noteKind?.name.toLocaleLowerCase() ?? (props.kind === 'note' ? 'page' : props.kind);
  const query = () => props.text.trim();
  const [existing] = createResource(() => query() || false, async text => ({ title: text, id: await props.notebook.pageByTitle(text, false) }));
  // Find's Pages scope combines completion (aliases) and text search (infix titles).
  const [similar] = createResource(() => query() || false, async text => {
    const [names, hits] = await Promise.all([props.notebook.api.complete(text, 40), props.notebook.api.search(text)]);
    const rows = new Map(names.filter(row => row.kind === 'page').map(row => [row.id, { id: row.id, text: row.text, alias: row.alias }]));
    for (const hit of hits) if (hit.block.kind === 'page' && !rows.has(hit.block.id)) rows.set(hit.block.id, { id: hit.block.id, text: hit.block.text, alias: null });
    return [...rows.values()];
  });
  const [type] = createResource(() => props.noteKind?.type_id || false, key => props.notebook.api.type(key));
  const template = () => (type.latest?.fields ?? []).map(key => props.notebook.lookup(key)()?.text).filter(Boolean);
  const found = () => existing.latest?.title === query() ? existing.latest.id ?? undefined : undefined;
  const [kinds] = createResource(() => found() || false, key => props.notebook.api.noteKinds(key));
  const member = () => !!found() && (props.kind === 'note' || kinds()?.some(kind => kind.key === (props.noteKind?.key ?? props.kind)));
  const typePage = () => mode() === 'type' && query().toLocaleLowerCase() === props.noteKind?.name.toLocaleLowerCase();
  const matches = createMemo(() => query() ? (similar() ?? []).filter(row => row.id !== found()).slice(0, 4) : []);
  const fit = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
  onMount(() => { fit(); title.focus(); title.setSelectionRange(title.value.length, title.value.length); });

  async function submit(beside: boolean, again = false) {
    const text = query();
    if (!text || busy() || typePage()) return;
    setBusy(true); setError('');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const pending = pendingCaretInput.prepare();
    let doc: PageDocument | undefined;
    try {
      const existingId = await props.notebook.pageByTitle(text, false);
      const filed = existingId && (props.kind === 'note' || (await props.notebook.api.noteKinds(existingId)).some(kind => kind.key === (props.noteKind?.key ?? props.kind)));
      const pageId = existingId ?? ulid(), caretId = existingId ? undefined : ulid();
      const line = props.gist.trim();
      if (!filed) {
        let revision = 1;
        if (existingId) { doc = props.notebook.open(existingId); await documentReady(doc); await doc.flush(); revision = (await props.notebook.api.block(pageId)).revision; }
        const kindPage = mode() === 'type' ? await props.notebook.pageByTitle(props.noteKind!.name, false) : null;
        const operations: Operation[] = [
          ...existingId ? [] : [{ op: 'create_page' as const, id: pageId, title: text }],
          ...caretId ? [{ op: 'insert' as const, id: caretId, parent_id: pageId, after: null, text: line, heading: null }] : [],
          ...mode() === 'type' ? filingOperations(pageId, revision, props.noteKind!.name, kindPage ? undefined : ulid())
            : props.kind === 'question' ? [{ op: 'set_question' as const, id: pageId, base_revision: revision, question: { unsettled: false, parked: false, accepted: null, review_on: null } }]
              : props.kind === 'project' ? [{ op: 'set_project' as const, id: pageId, base_revision: revision, project: { status: 'active' as const, outcome: '', deadline: null } }] : [],
        ];
        await props.notebook.commit(operations, `New ${noun()}`);
        if (!existingId) props.onCreated?.(pageId);
      }
      if (again) {
        pending(); props.onAdded(); props.onTextChange(''); props.onGistChange('');
        queueMicrotask(() => { fit(); title.focus(); });
      } else {
        if (!caretId) pending();
        props.onOpen({ kind: 'page', pageId, ...(caretId ? { caretId, caretOffset: line.length } : {}) }, beside || !!props.defaultBeside);
      }
    } catch (reason) { pending(); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { doc?.release(); setBusy(false); }
  }
  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault(); event.stopPropagation();
    void submit(event.shiftKey && !event.metaKey && !event.ctrlKey, event.shiftKey && (event.metaKey || event.ctrlKey));
  }
  return <form class="create-page" onSubmit={event => { event.preventDefault(); void submit(false); }} onKeyDown={keydown}>
    <label class="visually-hidden" for={`${id}-title`}>Title</label>
    <textarea ref={title} id={`${id}-title`} class="create-page-title" rows={1} value={props.text} disabled={busy()} autocomplete="off" placeholder={`Name the ${noun()}`} onInput={event => { props.onTextChange(event.currentTarget.value.replace(/[\r\n]+/g, ' ')); fit(); setError(''); }} />
    <Show when={!typePage() && found()} fallback={<Show when={!typePage()}>
      <label class="visually-hidden" for={`${id}-gist`}>Gist</label>
      <input id={`${id}-gist`} class="new-kind-gist" value={props.gist} disabled={busy()} autocomplete="off" placeholder={gistPrompt[mode()]?.(noun())} onInput={event => props.onGistChange(event.currentTarget.value)} />
    </Show>}><p class="new-kind-note">“{query()}” {member() ? `is already a ${noun()}.` : `already exists; it will be ${mode() === 'type' ? `filed under ${props.noteKind!.name}` : `made a ${noun()}`}.`}</p></Show>
    <Show when={typePage()}><p class="new-kind-note">“{props.noteKind!.name}” names the type itself.</p></Show>
    <Show when={template().length}><p class="new-kind-template"><span>Template</span>{template().join(' · ')}</p></Show>
    <Show when={matches().length}><div class="create-matches" role="group" aria-label="Similar pages"><p class="new-kind-matches-label">Similar pages</p>
      <For each={matches()}>{row => <div class="create-match"><span>{row.text}<Show when={row.alias}>{alias => <span class="reference-via"> via {alias()}</span>}</Show></span><Button onClick={() => props.onGistChange(`${props.gist} [[${row.text}]]`)}>Link</Button><Button onClick={() => props.onOpen({ kind: 'page', pageId: row.id }, false)}>Open</Button></div>}</For>
    </div></Show>
    <Show when={error() || existing.error || similar.error}><p class="error" role="alert">{error() || String(existing.error ?? similar.error)}</p></Show>
    <footer class="create-foot"><span class="create-keys"><Show when={props.status} fallback={<Show when={!props.sheet}><kbd>↵</kbd> Create <kbd>⇧↵</kbd> Beside <kbd>⇧⌘↵</kbd> Another <kbd>esc</kbd> Close</Show>}>{text => <span role="status">{text()}</span>}</Show></span>
      <Show when={!props.sheet}><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button></Show><Button type="submit" class="bordered" disabled={!query() || busy() || typePage() || mode() === 'type' && !props.noteKind}>{busy() ? 'Saving…' : member() ? `Open ${noun()}` : found() ? `File as ${noun()}` : `Create ${noun()}`}</Button>
    </footer>
  </form>;
}
