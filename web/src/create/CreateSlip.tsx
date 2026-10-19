import { For, Match, Show, Switch, createMemo, createResource, createSignal, onMount } from 'solid-js';
import type { NotebookClient, CaptureReceipt } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { shortDay } from '../shell/desk-counts';
import { noteIndex, noteKindIcon } from '../notes/kinds';
import { completeNames } from '../outline/names';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup, type PopupAnchor } from '../ui/Popup';
import { CaptureField } from '../capture/CaptureField';
import { CardComposerBody } from '../review/CardComposer';
import { AddSourceBody } from '../library/AddSheet';
import { PageDraft } from './PageDraft';
import { inferKind, type CreateInto, type CreateKind, type CreateRequest } from './request';
import { kindNoun } from './kinds';
import './create.css';

export interface CreateNotice {
  message: string;
  actions?: { label: string; run(): void | Promise<void> }[];
}
export interface CreateSlipProps {
  notebook: NotebookClient;
  request: CreateRequest;
  anchor?: PopupAnchor;
  onDismiss(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onCreated?(pageId: string): void;
  onNotice?(notice: CreateNotice): void;
  defaultBeside?: boolean;
}
const cover = () => window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches;
const primaryKinds: { kind: CreateKind; label: string }[] = [
  { kind: 'task', label: '#task' }, { kind: 'question', label: '#question' }, { kind: 'note', label: 'atom' }, { kind: 'card', label: 'card' }, { kind: 'source', label: '#source' },
];
const defaultInto = (kind: CreateKind): CreateInto => ({ kind: kind === 'question' || kind === 'project' || kind.startsWith('type:') ? 'page' : 'journal' });

export function CreateSlip(props: CreateSlipProps) {
  return <Popup anchor={props.anchor ?? document.body} placement={cover() ? 'sheet' : props.anchor ? 'anchor' : 'top'} width={560} fitContent class="create-slip" label="Create" onDismiss={props.onDismiss} autofocus={props.request.focus === 'kind' && !props.request.lockKind ? false : undefined}>
    <CreateSlipBody {...props} onOpen={(target, beside) => { props.onDismiss(); props.onOpen(target, beside); }} sheet={cover()} />
  </Popup>;
}

/** The native capture panel supplies its own window instead of a Popup. Remount to replace its draft. */
export function CreateSlipBody(props: CreateSlipProps & { sheet?: boolean }) {
  const [kind, setKind] = createSignal<CreateKind>(props.request.kind);
  const [text, setText] = createSignal(props.request.text);
  const [gist, setGist] = createSignal('');
  const [into, setInto] = createSignal<CreateInto>(props.request.into ?? defaultInto(props.request.kind));
  let chosen = !!props.request.lockKind;
  let destinationChosen = !!props.request.into;
  const [more, setMore] = createSignal<HTMLElement>();
  const [picker, setPicker] = createSignal<HTMLElement>();
  const [query, setQuery] = createSignal('');
  const [added, setAdded] = createSignal(0);
  const index = noteIndex(props.notebook);
  const noteKind = createMemo(() => index()?.kinds.find(value => value.key === (kind().startsWith('type:') ? kind().slice(5) : kind())));
  const moreKinds = createMemo(() => (index()?.kinds ?? []).filter(value => value.tag && !primaryKinds.some(primary => primary.kind === value.key)));
  const [recipes] = createResource(() => kind().startsWith('type:') && noteKind()?.type_id || false, async id => (await props.notebook.api.cardTemplates(id)).filter(recipe => recipe.applied));
  const under = () => { const destination = into(); return destination.kind === 'under' ? destination.pageId : undefined; };
  const destinationTitle = () => under() ? props.notebook.lookup(under()!)()?.text ?? props.notebook.roots().find(page => page.id === under())?.text ?? 'Atom' : '';
  const pageDraft = () => kind() === 'project' || kind().startsWith('type:') || (kind() === 'note' || kind() === 'question') && into().kind === 'page';
  const moreSelected = () => !primaryKinds.some(value => value.kind === kind());
  const action = () => recipes()?.length ? `Add ${noteKind() ? kindNoun(noteKind()!) : 'an atom'}` : kind() === 'source' ? 'Add to library' : kind() === 'task' ? 'New task' : kind() === 'card' ? 'New card' : kind() === 'project' ? 'New project' : kind().startsWith('type:') ? `New ${noteKind() ? kindNoun(noteKind()!) : 'atom'}` : pageDraft() ? kind() === 'question' ? 'New question' : 'New atom' : 'Add to today';
  const where = () => recipes()?.length ? 'Into today' : kind() === 'source' ? 'Library inbox' : pageDraft() ? '' : under() ? `End of ${destinationTitle()}` : `${shortDay(props.notebook.todayDate())} · end of journal`;
  const status = () => added() ? `${added()} added` : '';
  const [pages] = createResource(() => picker() ? [query(), props.notebook.roots()] as const : false, ([value, roots]) => completeNames(props.notebook, value, roots));
  let body!: HTMLDivElement;
  function changeKind(next: CreateKind, explicit: boolean) {
    if (explicit) chosen = true;
    if (kind() === next) return;
    setKind(next);
    if (!destinationChosen) setInto(defaultInto(next));
    if ((next === 'task' || next === 'card') && into().kind === 'page') setInto({ kind: 'journal' });
    queueMicrotask(() => {
      const field = body.querySelector<HTMLInputElement | HTMLTextAreaElement>(next === 'card' && !explicit ? '.card-composer-back textarea' : 'textarea,input:not([type="file"])');
      field?.focus();
      if (field && (field instanceof HTMLTextAreaElement || ['text', 'search', 'url'].includes(field.type))) field.setSelectionRange(field.value.length, field.value.length);
    });
  }
  function changeText(value: string) {
    setText(value);
    if (!chosen) changeKind(inferKind(value) ?? props.request.kind, false);
  }
  onMount(() => {
    if (text() && !chosen) changeText(text());
    if (props.request.focus === 'kind' && !props.request.lockKind) queueMicrotask(() => {
      if (body.isConnected) body.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus();
    });
  });
  function chooseInto(value: CreateInto) { destinationChosen = true; setInto(value); }
  function radios(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = [...primaryKinds.map(value => value.kind), moreSelected() ? kind() : 'project'] as CreateKind[];
    const current = moreSelected() ? options.length - 1 : options.indexOf(kind());
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
    changeKind(options[next]!, true);
    queueMicrotask(() => body.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus());
  }
  function announce(receipt: CaptureReceipt, message: string) {
    // The slip may close after durable acceptance. Delivery still owns the shell acknowledgement.
    void receipt.delivered.then(result => {
      if (!result) return;
      props.onNotice?.({ message, actions: [
        { label: 'Open', run: () => props.onOpen({ kind: 'page', pageId: result.pageId, blockId: result.blockId }, false) },
        { label: 'Undo', run: result.undo },
      ] });
    }, reason => props.onNotice?.({ message: reason instanceof Error ? reason.message : String(reason) }));
  }
  function saved(again: boolean, receipt: CaptureReceipt) {
    announce(receipt, under() ? `Added to ${destinationTitle()}` : 'Added to today');
    setText(''); setAdded(value => value + 1);
    if (!again) props.onDismiss();
  }
  async function saveCard(value: string) {
    const receipt = await props.notebook.appendCapture(value, null, [], { targetPageId: under() });
    await receipt.delivered;
    announce(receipt, 'Card added');
    setText(''); setAdded(value => value + 1);
  }
  return <div ref={body} class="create-body" onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); props.onDismiss(); } }}>
    <header class="capture-head"><span class="capture-title">{action()}</span><span class="capture-where">{where()}</span></header>
    <Show when={!props.request.lockKind}>
      <div class="create-kinds mode-tabs" role="radiogroup" aria-label="Create" onKeyDown={radios}>
        <For each={primaryKinds}>{value => <Button role="radio" aria-checked={kind() === value.kind} tabIndex={kind() === value.kind ? 0 : -1} onClick={() => changeKind(value.kind, true)}>{value.label}</Button>}</For>
        <Button role="radio" aria-checked={moreSelected()} tabIndex={moreSelected() ? 0 : -1} aria-haspopup="menu" onClick={event => setMore(event.currentTarget)}>{moreSelected() ? `#${noteKind()?.name ?? 'project'}` : 'More'}<Icon name="down" /></Button>
      </div>
      <Show when={kind() === 'note' || kind() === 'question' || kind() === 'task' || kind() === 'card'}><div class="create-into" role="group" aria-label="Into"><span>Into</span>
        <Button aria-pressed={into().kind === 'journal'} onClick={() => chooseInto({ kind: 'journal' })}>Today</Button>
        <Show when={kind() === 'note' || kind() === 'question'}><Button aria-pressed={into().kind === 'page'} onClick={() => chooseInto({ kind: 'page' })}>New atom</Button></Show>
        <Button aria-pressed={into().kind === 'under'} aria-haspopup="listbox" onClick={event => { setQuery(''); setPicker(event.currentTarget); }}>{under() ? destinationTitle() : 'Atom…'}</Button>
        <Show when={under()}><Button label="Remove destination" onClick={() => chooseInto(defaultInto(kind()))}>×</Button></Show>
      </div></Show>
    </Show>
    <Switch>
      <Match when={pageDraft()}><PageDraft notebook={props.notebook} kind={kind()} noteKind={noteKind()} text={text()} gist={gist()} sheet={!!props.sheet} onTextChange={changeText} onGistChange={setGist} onDismiss={props.onDismiss} onOpen={props.onOpen} onCreated={props.onCreated} onAdded={() => { chosen = true; setAdded(value => value + 1); }} status={status()} defaultBeside={props.defaultBeside} /></Match>
      <Match when={kind() === 'card'}><CardComposerBody initialText={text()} onTextChange={changeText} sheet={props.sheet} status={status()} onSave={saveCard} onDismiss={props.onDismiss} /></Match>
      <Match when={kind() === 'source'}><AddSourceBody notebook={props.notebook} initialText={text()} onTextChange={changeText} onDismiss={again => { if (again) { chosen = true; setText(''); setAdded(value => value + 1); } else props.onDismiss(); }} onJob={job => props.onNotice?.({ message: 'Added to library', actions: [{ label: 'Open', run: async () => {
        const current = (await props.notebook.api.ingestJobs()).find(value => value.id === job.id);
        props.onOpen(current?.source_id ? { kind: 'page', pageId: current.source_id } : { kind: 'library', tab: 'inbox' }, false);
      } }] })} onAdded={sourceId => props.onNotice?.({ message: 'Added to library', actions: [{ label: 'Open', run: () => props.onOpen({ kind: 'page', pageId: sourceId }, false) }] })} /><Show when={status()}><p class="create-keys" role="status">{status()}</p></Show></Match>
      <Match when={!pageDraft()}><CaptureField notebook={props.notebook} contextDate={() => props.notebook.todayDate()} initialText={text()} fixedKind taskOnly={kind() === 'task'} question={kind() === 'question'} targetPageId={under()} onTextChange={changeText} label={action()} placeholder="Write a line" onSaved={saved} onCancel={props.onDismiss} inputRef={input => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }}>
        {state => <footer class="create-foot"><span class="create-keys"><Show when={status()} fallback={<Show when={!props.sheet}><kbd>↵</kbd> Add <kbd>⇧↵</kbd> Add another <kbd>esc</kbd> Close</Show>}>{value => <span role="status">{value()}</span>}</Show></span><Show when={!props.sheet}><Button onClick={props.onDismiss}>Cancel</Button></Show><Button class="bordered" disabled={state.busy() || !text().trim()} onClick={() => state.submit(false)}>Add</Button></footer>}
      </CaptureField></Match>
    </Switch>
    <Show when={more()}>{anchor => <Menu anchor={anchor()} label="More tags" onDismiss={() => setMore(undefined)} items={moreKinds().map(value => ({ label: `#${value.name}`, icon: noteKindIcon(value), action: () => changeKind(value.key === 'project' ? 'project' : `type:${value.key}`, true) }))} />}</Show>
    <Show when={picker()}>{anchor => <Picker anchor={anchor()} label="Atom" query={query()} onQuery={setQuery} placeholder="Find an atom" items={pages()?.rows ?? []} key={value => value.page.id} onDismiss={() => setPicker(undefined)} onPick={value => { chooseInto({ kind: 'under', pageId: value.page.id }); setPicker(undefined); }} row={value => <><Icon name="page" /><span class="picker-text">{value.page.text}</span></>} empty="No matching atoms." error={pages.error ? String(pages.error) : undefined} />}</Show>
  </div>;
}
