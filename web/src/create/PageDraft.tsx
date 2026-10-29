import { For, Show, createMemo, createResource, createSignal, createUniqueId, onMount } from 'solid-js';
import type { NoteKind } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { pendingCaretInput } from '../shell/pending-caret';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import type { CreateKind } from './request';
import { DraftFields } from './DraftFields';
import { blankDraftFields, createPageDraft } from './draft';
import { foldName } from '../outline/names';
import { titleKey } from '../document/title-key';
import { kindNoun } from './kinds';
import { trackSlipLoading } from './slip-loading';

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
  const [fields, setFields] = createSignal(blankDraftFields());
  const id = createUniqueId();
  let title!: HTMLTextAreaElement;
  const mode = () => props.kind.startsWith('type:') ? 'type' : props.kind;
  const noun = () => props.noteKind ? kindNoun(props.noteKind) : props.kind === 'note' ? 'atom' : props.kind;
  const query = () => props.text.trim();
  const [existing] = createResource(() => query() || false, async text => ({ title: text, id: await props.notebook.pageByTitle(text, false) }));
  // Find's Pages scope combines completion (aliases) and text search (infix titles); titles named inside a longer draft,
  // such as Kitchen renovation in “Is the kitchen renovation worth it?”, come first.
  const [similar] = createResource(() => query() || false, async text => {
    const [names, hits] = await Promise.all([props.notebook.api.complete(text, 40), props.notebook.api.search(text)]);
    const folded = ` ${foldName(text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    const rows = new Map<string, { id: string; text: string; alias: string | null }>();
    for (const page of props.notebook.roots()) {
      if (page.kind !== 'page' || page.archived) continue;
      const name = foldName(page.text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (name.length >= 4 && folded.includes(` ${name} `) && name !== folded.trim()) rows.set(page.id, { id: page.id, text: page.text, alias: null });
    }
    for (const row of names) if (row.kind === 'page' && !rows.has(row.id)) rows.set(row.id, { id: row.id, text: row.text, alias: row.alias });
    for (const hit of hits) if (hit.block.kind === 'page' && !rows.has(hit.block.id)) rows.set(hit.block.id, { id: hit.block.id, text: hit.block.text, alias: null });
    return [...rows.values()];
  });
  const [type] = createResource(() => props.noteKind?.type_id || false, key => props.notebook.api.type(key));
  const [recipes] = createResource(() => props.noteKind?.type_id || false, async id => (await props.notebook.api.cardTemplates(id)).filter(recipe => recipe.applied));
  const found = () => existing.latest?.title === query() ? existing.latest.id ?? undefined : undefined;
  const [kinds] = createResource(() => found() || false, key => props.notebook.api.noteKinds(key));
  const member = () => !!found() && (props.kind === 'note' || kinds()?.some(kind => kind.key === (props.noteKind?.key ?? props.kind)));
  const typePage = () => mode() === 'type' && !!props.noteKind && titleKey(query()) === titleKey(props.noteKind.name);
  trackSlipLoading(() => type.loading || recipes.loading || existing.loading || similar.loading);
  const matches = createMemo(() => query() ? (similar() ?? []).filter(row => row.id !== found()).slice(0, 4) : []);
  const fit = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
  onMount(() => { fit(); title.focus(); title.setSelectionRange(title.value.length, title.value.length); });

  async function submit(beside: boolean, again = false) {
    const text = query();
    if (!text || busy() || typePage()) return;
    setBusy(true); setError('');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const pending = pendingCaretInput.prepare();
    try {
      const { pageId, caretId, caretOffset, created } = await createPageDraft(props.notebook, { kind: props.kind, noteKind: props.noteKind, text, gist: props.gist, fields: fields() });
      if (created) props.onCreated?.(pageId);
      if (again) {
        pending(); props.onAdded(); props.onTextChange(''); props.onGistChange(''); setFields(blankDraftFields());
        queueMicrotask(() => { fit(); title.focus(); });
      } else {
        if (!caretId) pending();
        props.onOpen({ kind: 'page', pageId, ...(caretId ? { caretId, caretOffset } : {}) }, beside || !!props.defaultBeside);
      }
    } catch (reason) { pending(); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.isComposing) return;
    if (!event.metaKey && !event.ctrlKey && event.target instanceof HTMLElement && !event.target.matches('.create-page-title, .new-kind-gist')) return;
    event.preventDefault(); event.stopPropagation();
    void submit(event.shiftKey && !event.metaKey && !event.ctrlKey, event.shiftKey && (event.metaKey || event.ctrlKey));
  }
  return <form class="create-page" classList={{ 'create-recipe': !!recipes()?.length }} onSubmit={event => { event.preventDefault(); void submit(false); }} onKeyDown={keydown}>
    <Show when={recipes()?.length}><div class="create-recipe-tag"><span class="outline-tag">#{props.noteKind?.name}</span><span>{type()?.fields.length ?? 0} template fields</span></div></Show>
    <label class={recipes()?.length ? 'create-field-label' : 'visually-hidden'} for={`${id}-title`}>{recipes()?.length ? 'Atom text' : 'Title'}</label>
    <textarea ref={title} id={`${id}-title`} class="create-page-title" rows={1} value={props.text} disabled={busy()} autocomplete="off" placeholder={`Name the ${noun()}`} onInput={event => { props.onTextChange(event.currentTarget.value.replace(/[\r\n]+/g, ' ')); fit(); setError(''); }} />
    <Show when={!typePage() && found()} fallback={<Show when={!typePage() && !recipes()?.length}>
      <label class="visually-hidden" for={`${id}-gist`}>Gist</label>
      <input id={`${id}-gist`} class="new-kind-gist" value={props.gist} disabled={busy()} autocomplete="off" placeholder={gistPrompt[mode()]?.(noun())} onInput={event => props.onGistChange(event.currentTarget.value)} />
    </Show>}><p class="new-kind-note">“{query()}” {member() ? `is already ${noun() === 'atom' ? 'an' : 'a'} ${noun()}.` : `already exists; it will be ${mode() === 'type' ? `filed under ${props.noteKind!.name}` : `made ${noun() === 'atom' ? 'an' : 'a'} ${noun()}`}.`}</p></Show>
    <Show when={typePage()}><p class="new-kind-note">“{props.noteKind!.name}” names the tag itself.</p></Show>
    <Show when={!typePage()}><DraftFields notebook={props.notebook} kind={props.kind} fieldIds={type()?.fields ?? []} existingId={found()} disabled={busy()} value={fields()} onChange={setFields} recipes={recipes()} atomText={props.text} /></Show>
    <Show when={error() || existing.error || similar.error}><p class="error" role="alert">{error() || String(existing.error ?? similar.error)}</p></Show>
    <footer class="create-foot"><span class="create-keys"><Show when={props.status} fallback={<Show when={recipes()?.length} fallback={<Show when={!props.sheet}><kbd>↵</kbd> Create <kbd>⇧↵</kbd> Beside <kbd>⇧⌘↵</kbd> Another <kbd>esc</kbd> Close</Show>}>Atom and cards saved together</Show>}>{text => <span role="status">{text()}</span>}</Show></span>
      <Button type="submit" class="bordered" disabled={!query() || busy() || typePage() || mode() === 'type' && (!props.noteKind || recipes.loading)}>{busy() ? 'Saving…' : member() ? `Open ${noun()}` : found() ? `File as ${noun()}` : recipes()?.length ? `Add ${noun()}` : `Create ${noun()}`}</Button><Show when={!props.sheet}><Button class="create-cancel" disabled={busy()} onClick={props.onDismiss}>Cancel</Button></Show>
    </footer>
    <Show when={matches().length}><div class="create-matches" role="group" aria-label="Similar atoms"><p class="new-kind-matches-label">Similar atoms</p>
      <For each={matches()}>{row => <div class="create-match"><span>{row.text}<Show when={row.alias}>{alias => <span class="reference-via"> via {alias()}</span>}</Show></span><Button onClick={() => props.onGistChange(`${props.gist} [[${row.text}]]`)}>Link</Button><Button onClick={() => props.onOpen({ kind: 'page', pageId: row.id }, false)}>Open</Button></div>}</For>
    </div></Show>
  </form>;
}
