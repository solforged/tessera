import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, createUniqueId, onCleanup, onMount, type Accessor } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { NotebookClient, CaptureReceipt } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { shortDay } from '../shell/desk-counts';
import { noteIndex, noteKindIcon } from '../notes/kinds';
import { completeNames } from '../outline/names';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Seg } from '../ui/Seg';
import { Picker } from '../ui/Picker';
import { InlinePopups, Popup, type PopupAnchor } from '../ui/Popup';
import { CaptureField } from '../capture/CaptureField';
import { CardComposerBody } from '../review/CardComposer';
import { AddSourceBody } from '../library/AddSheet';
import { PageDraft } from './PageDraft';
import { inferKind, type CreateInto, type CreateKind, type CreateRequest } from './request';
import { kindNoun } from './kinds';
import { CapturedToday, LinkPreview, ReadingUnder, shortTitle, underText } from './SlipParts';
import { titledLink } from './today-journal';
import { linkWhenImported } from './link-import';
import type { UnderChoice } from './SlipParts';
import { SlipLoadingContext } from './slip-loading';
import { captureSection, isWritten, section, sectionTarget } from '../tasks/today-template';
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
  /** Whether the slip holds typed text, so the shell can keep it over a blank capture request. */
  onDraft?(dirty: boolean): void;
}
const cover = () => window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches;
/** The line's kinds, each with its Inbox glyph; More offers Project and the workshop's page kinds. */
const lineKinds: { kind: CreateKind; label: string; icon: IconName }[] = [
  { kind: 'note', label: 'Note', icon: 'bullet' }, { kind: 'question', label: 'Question', icon: 'question-open' }, { kind: 'task', label: 'Task', icon: 'select' },
  { kind: 'card', label: 'Card', icon: 'card' }, { kind: 'link', label: 'Link', icon: 'link' }, { kind: 'source', label: 'Source', icon: 'library' },
];
const webAddress = (text: string) => /^https?:\/\/\S+$/i.test(text.trim()) ? text.trim() : null;

/** Lines a slip lost to Escape, Cancel or Close, offered back when the same kind of slip opens empty again. */
const abandoned = new Map<string, string>();
/** Find's "as…" slip starts from its own text and kind chooser, so it neither takes nor leaves a draft. */
const draftKey = (request: CreateRequest) => request.focus ? null : JSON.stringify([request.kind, request.into ?? null, !!request.lockKind, request.scheduledDate ?? null]);

export function CreateSlip(props: CreateSlipProps) {
  const key = props.request.text ? null : draftKey(props.request);
  const earlier = key ? abandoned.get(key) : undefined;
  if (key) abandoned.delete(key);
  const request = earlier ? { ...props.request, text: earlier } : props.request;
  let draft = request.text;
  let closeEditor: (() => boolean) | undefined;
  const [dirty, setDirty] = createSignal(false);
  // Hold the first frame until the slip has its fields and recent captures, so it never grows while fading in.
  const [settled, setSettled] = createSignal(false);
  // Escape on a phone sheet first closes an open Kind or Atom editor; only then does it close the slip.
  const cancel = () => {
    if (closeEditor?.()) return;
    const slot = draftKey(props.request);
    if (slot && draft.trim()) abandoned.set(slot, draft);
    props.onDismiss();
  };
  return <Popup anchor={props.anchor ?? document.body} placement={cover() ? 'sheet' : props.anchor ? 'anchor' : 'top'} title={cover() ? 'New' : undefined} width={560} fitContent modal ready={settled()} dirty={dirty} class="create-slip" label="Create" onDismiss={cancel} autofocus={props.request.focus === 'kind' && !props.request.lockKind ? false : undefined}>
    <CreateSlipBody {...props} request={request} onOpen={(target, beside) => { props.onDismiss(); props.onOpen(target, beside); }} onCancel={cancel} onEditors={close => { closeEditor = close; }} onText={value => { draft = value; }} onDraft={value => { setDirty(value); props.onDraft?.(value); }} onSettled={() => setSettled(true)} sheet={cover()} />
  </Popup>;
}

/** The native capture panel supplies its own window instead of a Popup. Remount to replace its draft. */
export function CreateSlipBody(props: CreateSlipProps & { sheet?: boolean; onCancel?(): void; onEditors?(close: () => boolean): void; onText?(text: string): void; onSettled?(): void }) {
  const [kind, setKind] = createSignal<CreateKind>(props.request.kind);
  const [text, setText] = createSignal(props.request.text);
  const [gist, setGist] = createSignal('');
  const template = () => props.notebook.todayTemplate();
  // A journal destination resolves to the capture section, Inbox unless Settings › Today changes it.
  const resolve = (value: CreateInto): CreateInto => value.kind === 'journal' && !value.section ? { kind: 'journal', section: captureSection(template()).id } : value;
  // A phone's four kinds are one segment, so a question goes where a note does until the writer picks an atom to make instead.
  const defaultInto = (kind: CreateKind): CreateInto => resolve({ kind: kind === 'question' && !props.sheet || kind === 'project' || kind.startsWith('type:') ? 'page' : 'journal' });
  const [into, setInto] = createSignal<CreateInto>(resolve(props.request.into ?? defaultInto(props.request.kind)));
  /** Written sections that are on, and Notes, in template order. */
  const sections = createMemo(() => template().sections.filter(value => value.on && (isWritten(value) || value.id === 'notes')));
  const sectionId = () => { const destination = into(); return destination.kind === 'journal' ? destination.section : undefined; };
  const reading = () => sectionId() === 'reading' && kind() !== 'card' ? under() : undefined;
  const target = () => {
    const id = sectionId(), choice = reading();
    const value = id && id !== 'notes' ? sectionTarget(template(), id) : undefined;
    return value && choice ? { ...value, under: { id: choice.id, text: underText(choice) } } : value;
  };
  const sectionName = () => { const id = sectionId(); return id ? section(template(), id)?.name ?? 'Notes' : undefined; };
  /** Where a line lands, as the button and notice name it: the section, or the source under Reading. */
  const landing = () => reading() ? `under ${shortTitle(reading()!.title)}` : `to ${sectionName() ?? 'today'}`;
  let chosen = !!props.request.lockKind;
  let destinationChosen = !!props.request.into;
  const [picker, setPicker] = createSignal<HTMLElement>();
  const [query, setQuery] = createSignal('');
  const [added, setAdded] = createSignal(0);
  const index = noteIndex(props.notebook);
  const noteKind = createMemo(() => index()?.kinds.find(value => value.key === (kind().startsWith('type:') ? kind().slice(5) : kind())));
  const moreKinds = createMemo(() => (index()?.kinds ?? []).filter(value => value.tag && !lineKinds.some(line => line.kind === value.key)));
  const [kindMenu, setKindMenu] = createSignal<HTMLElement>();
  const [under, setUnder] = createSignal<UnderChoice>();
  // The phone sheet's head carries the Add stamp, which belongs to the line or card below, so it is drawn into the head from here.
  const [head, setHead] = createSignal<HTMLElement>();
  const [cardReady, setCardReady] = createSignal(false);
  const cardForm = createUniqueId();
  const [linkTitle, setLinkTitle] = createSignal<string | null>(null);
  const [linkLibrary, setLinkLibrary] = createSignal(false);
  // A card's back is not the slip's text, so the card form reports its own typed content.
  const [cardDirty, setCardDirty] = createSignal(false);
  const [recipes] = createResource(() => kind().startsWith('type:') && noteKind()?.type_id || false, async id => (await props.notebook.api.cardTemplates(id)).filter(recipe => recipe.applied));
  const [loaders, setLoaders] = createSignal<Accessor<boolean>[]>([]);
  const track = (loading: Accessor<boolean>) => { setLoaders(list => [...list, loading]); onCleanup(() => setLoaders(list => list.filter(value => value !== loading))); };
  track(() => recipes.loading);
  track(() => kind().startsWith('type:') && !index());
  /** On the phone sheet the Kind menu and Atom picker live inside the slip: close the open one, returning focus to its trigger. */
  const closeEditor = () => {
    const trigger = kindMenu() ?? picker();
    if (!props.sheet || !trigger) return false;
    setKindMenu(undefined); setPicker(undefined);
    queueMicrotask(() => { if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
    return true;
  };
  /** The phone's Kind and Into segments stand in for the chip and the Into chips whenever the kind is one of the four and the destination is a line. */
  const segKinds: { value: CreateKind; label: string }[] = [{ value: 'note', label: 'Note' }, { value: 'task', label: 'Task' }, { value: 'question', label: 'Question' }, { value: 'card', label: 'Card' }];
  const phoneControls = () => !!props.sheet && !props.request.lockKind && showsInto() && !pageDraft();
  const intoSegment = () => sections().length <= 3;
  const intoOptions = () => [...sections().map(value => ({ value: value.id, label: value.name })), { value: 'atom', label: atom() ? destinationTitle() : 'An atom' }];
  const chooseSegment = (value: string) => {
    if (value !== 'atom') { chooseInto({ kind: 'journal', section: value }); return; }
    setQuery('');
    setPicker(body.querySelector<HTMLElement>('.create-into-seg [role="radio"]:last-child') ?? undefined);
  };
  props.onEditors?.(closeEditor);
  /** Escape, Cancel and Close abandon the draft; saving and creating dismiss without it. */
  const cancel = () => { if (!closeEditor()) (props.onCancel ?? props.onDismiss)(); };
  const atom = () => { const destination = into(); return destination.kind === 'under' ? destination.pageId : undefined; };
  const destinationTitle = () => atom() ? props.notebook.lookup(atom()!)()?.text ?? props.notebook.roots().find(page => page.id === atom())?.text ?? 'Atom' : '';
  const pageDraft = () => kind() === 'project' || kind().startsWith('type:') || (kind() === 'note' || kind() === 'question') && into().kind === 'page';
  const lineKind = () => lineKinds.find(value => value.kind === kind());
  const lineBody = () => !pageDraft() && kind() !== 'card' && kind() !== 'source';
  const showsInto = () => ['note', 'question', 'task', 'card', 'link'].includes(kind());
  const action = () => recipes()?.length ? `Add ${noteKind() ? kindNoun(noteKind()!) : 'an atom'}` : kind() === 'source' ? 'Add to library' : kind() === 'task' ? 'New task' : kind() === 'card' ? 'New card' : kind() === 'project' ? 'New project' : kind().startsWith('type:') ? `New ${noteKind() ? kindNoun(noteKind()!) : 'atom'}` : pageDraft() ? kind() === 'question' ? 'New question' : 'New atom' : 'Capture';
  const where = () => recipes()?.length ? 'Into today' : kind() === 'source' ? 'Library inbox' : pageDraft() ? '' : atom() ? `→ End of ${destinationTitle()}` : `→ Today › ${sectionName() ?? 'Notes'}${reading() ? ` › ${shortTitle(reading()!.title)}` : ''}`;
  const status = () => added() ? `${added()} added` : '';
  const [pages] = createResource(() => picker() ? [query(), props.notebook.roots()] as const : false, ([value, roots]) => completeNames(props.notebook, value, roots));
  let body!: HTMLDivElement;
  function changeKind(next: CreateKind, explicit: boolean) {
    if (explicit) chosen = true;
    if (kind() === next) return;
    setKind(next);
    if (!destinationChosen) setInto(defaultInto(next));
    if ((next === 'task' || next === 'card') && into().kind === 'page') setInto(resolve({ kind: 'journal' }));
    queueMicrotask(() => {
      const field = body.querySelector<HTMLInputElement | HTMLTextAreaElement>(next === 'card' && !explicit ? '.card-composer-back textarea' : 'textarea,input:not([type="file"])');
      field?.focus();
      if (field && (field instanceof HTMLTextAreaElement || ['text', 'search', 'url'].includes(field.type))) field.setSelectionRange(field.value.length, field.value.length);
    });
  }
  function changeText(value: string) {
    setText(value);
    if (!chosen) {
      // Settings › Today decides whether a pasted web address infers Link or Source.
      const inferred = inferKind(value);
      changeKind((inferred === 'source' && webAddress(value) && template().links === 'link' ? 'link' : inferred) ?? props.request.kind, false);
    }
  }
  createEffect(() => props.onDraft?.(text().trim().length > 0 || gist().trim().length > 0 || kind() === 'card' && cardDirty()));
  createEffect(() => props.onText?.(text()));
  createEffect(() => { if (!loaders().some(loading => loading())) props.onSettled?.(); });
  onMount(() => {
    // A slow service must not keep the slip hidden; whatever arrives later still fits.
    const timer = setTimeout(() => props.onSettled?.(), 250);
    onCleanup(() => clearTimeout(timer));
    if (text() && !chosen) changeText(text());
    if (props.sheet) setHead(body.closest<HTMLElement>('.popup')?.querySelector<HTMLElement>('.popup-sheet-tools') ?? undefined);
    if (props.request.focus === 'kind' && !props.request.lockKind) {
      // The popup appears once its content settles, and a hidden chip cannot take focus.
      const focusChip = (attempt: number) => {
        const chip = body.querySelector<HTMLButtonElement>('.create-chip');
        if (!chip?.isConnected) return;
        chip.focus({ preventScroll: true });
        // A modal popup holds focus on its own panel until the page behind it is inert and its content has appeared.
        const held = document.activeElement === document.body || document.activeElement === chip.closest('.popup');
        if (held && attempt < 15) requestAnimationFrame(() => focusChip(attempt + 1));
      };
      queueMicrotask(() => focusChip(0));
    }
  });
  function chooseInto(value: CreateInto) { destinationChosen = true; setInto(value); }
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
    const url = kind() === 'link' ? webAddress(text()) : null;
    if (url && linkLibrary()) {
      // The line is linked to its source once the import finishes; the text it was saved with tells an edit apart.
      const title = linkTitle(), saved = titledLink(url, title);
      void Promise.all([props.notebook.api.queueUrl(url), receipt.delivered]).then(([job, result]) => {
        if (result) linkWhenImported(props.notebook, { job: job.id, pageId: result.pageId, blockId: result.blockId, text: saved, title });
      }).catch(reason => props.onNotice?.({ message: reason instanceof Error ? reason.message : String(reason) }));
    }
    announce(receipt, atom() ? `Added to ${destinationTitle()}` : `Added ${landing()}`);
    setText(''); setAdded(value => value + 1);
    if (!again) props.onDismiss();
  }
  async function saveCard(value: string) {
    const receipt = await props.notebook.appendCapture(value, null, [], { targetPageId: atom(), section: atom() ? undefined : target() });
    await receipt.delivered;
    announce(receipt, 'Card added');
    setText(''); setAdded(value => value + 1);
  }
  /** The kind chip leading the line; Shift+Tab from the line reaches it, and Enter or a click opens the kind menu. */
  const chip = () => <Button class="create-chip" aria-haspopup="menu" aria-expanded={!!kindMenu()} label={`Kind: ${lineKind()?.label ?? noteKind()?.name ?? 'Project'}`} onClick={event => setKindMenu(event.currentTarget)}>
    <Icon name={lineKind()?.icon ?? (kind() === 'project' ? 'flag' : 'page')} /><span>{lineKind()?.label ?? (kind() === 'project' ? 'Project' : noteKind()?.name ?? 'Atom')}</span><Icon name="down" />
  </Button>;
  /** Into, and Reading's Under row when Reading is chosen. */
  const destination = () => <Show when={showsInto() && !props.request.lockKind}>
    <div class="create-into" role="group" aria-label="Into"><span>Into</span>
      <For each={sections()}>{value => <Button aria-pressed={sectionId() === value.id} onClick={() => chooseInto({ kind: 'journal', section: value.id })}>{value.name}</Button>}</For>
      <Show when={kind() === 'note' || kind() === 'question'}><Button aria-pressed={into().kind === 'page'} onClick={() => chooseInto({ kind: 'page' })}>New atom</Button></Show>
      <Button aria-pressed={into().kind === 'under'} aria-haspopup="listbox" onClick={event => { setQuery(''); setPicker(event.currentTarget); }}>{atom() ? destinationTitle() : 'Atom…'}</Button>
      <Show when={atom()}><Button label="Remove destination" onClick={() => chooseInto(defaultInto(kind()))}>×</Button></Show>
    </div>
    <Show when={sectionId() === 'reading' && kind() !== 'card'}><ReadingUnder notebook={props.notebook} value={under()} onChange={setUnder} /></Show>
  </Show>;
  /** On the phone sheet these render inside the sheet, beside their trigger, rather than as siblings floating over it. */
  const editors = () => <>
    <Show when={kindMenu()}>{anchor => <Menu anchor={anchor()} label="Kind" onDismiss={() => setKindMenu(undefined)} items={[
      ...lineKinds.map(value => ({ label: value.label, icon: value.icon, checked: kind() === value.kind, action: () => changeKind(value.kind, true) })),
      { label: 'Project', section: 'More', icon: 'flag' as const, checked: kind() === 'project', action: () => changeKind('project', true) },
      ...moreKinds().filter(value => value.key !== 'project').map(value => ({ label: value.name, section: 'More', icon: noteKindIcon(value), checked: kind() === `type:${value.key}`, action: () => changeKind(`type:${value.key}`, true) })),
    ]} />}</Show>
    <Show when={picker()}>{anchor => <Picker anchor={anchor()} label="Atom" query={query()} onQuery={setQuery} placeholder="Find an atom" items={pages()?.rows ?? []} key={value => value.page.id} onDismiss={() => setPicker(undefined)} onPick={value => { chooseInto({ kind: 'under', pageId: value.page.id }); setPicker(undefined); }} row={value => <><Icon name="page" /><span class="picker-text">{value.page.text}</span></>} empty="No matching atoms." error={pages.error ? String(pages.error) : undefined} />}</Show>
  </>;
  return <SlipLoadingContext.Provider value={track}><div ref={body} class="create-body" onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
    <Show when={!props.sheet}><header class="capture-head"><span><span class="capture-title">{action()}</span> <span class="capture-where">{where()}</span></span><span class="capture-where">{shortDay(props.notebook.todayDate())}</span></header></Show>
    <Show when={!lineBody() && !phoneControls()}>
      <Show when={!props.request.lockKind}><div class="create-kind-line">{chip()}</div></Show>
      {destination()}
    </Show>
    <Switch>
      <Match when={pageDraft()}><PageDraft notebook={props.notebook} kind={kind()} noteKind={noteKind()} text={text()} gist={gist()} sheet={!!props.sheet} onTextChange={changeText} onGistChange={setGist} onDismiss={cancel} onOpen={props.onOpen} onCreated={props.onCreated} onAdded={() => { chosen = true; setAdded(value => value + 1); }} status={status()} defaultBeside={props.defaultBeside} /></Match>
      <Match when={kind() === 'card'}><CardComposerBody initialText={text()} onTextChange={changeText} sheet={props.sheet} status={status()} onSave={saveCard} onDismiss={props.onDismiss} onDirtyChange={setCardDirty} formId={cardForm} onReady={setCardReady} />
        <Show when={props.sheet ? head() : undefined}>{mount => <Portal mount={mount()}><Button kind="stamp" type="submit" form={cardForm} disabled={!cardReady()}>Add</Button></Portal>}</Show></Match>
      <Match when={kind() === 'source'}><AddSourceBody notebook={props.notebook} initialText={text()} onTextChange={changeText} onDismiss={again => { if (again) { chosen = true; setText(''); setAdded(value => value + 1); } else props.onDismiss(); }} onJob={job => props.onNotice?.({ message: 'Added to library', actions: [{ label: 'Open', run: async () => {
        const current = (await props.notebook.api.ingestJobs()).find(value => value.id === job.id);
        props.onOpen(current?.source_id ? { kind: 'page', pageId: current.source_id } : { kind: 'library', tab: 'inbox' }, false);
      } }] })} onAdded={sourceId => props.onNotice?.({ message: 'Added to library', actions: [{ label: 'Open', run: () => props.onOpen({ kind: 'page', pageId: sourceId }, false) }] })} /><Show when={status()}><p class="create-keys" role="status">{status()}</p></Show></Match>
      <Match when={lineBody()}><CaptureField notebook={props.notebook} contextDate={() => props.request.scheduledDate ?? props.notebook.todayDate()} schedule={kind() === 'task' && !!props.request.scheduledDate} initialText={text()} fixedKind taskOnly={kind() === 'task'} question={kind() === 'question'} targetPageId={atom()} section={target()} onTextChange={changeText} label={action()} placeholder={kind() === 'link' ? 'Paste a link' : 'Write a line'} onSaved={saved} onCancel={cancel}
        leading={props.request.lockKind || phoneControls() ? undefined : chip()} prepare={kind() === 'link' ? value => webAddress(value) ? titledLink(value, linkTitle()) : value : undefined}
        inputRef={input => { if (props.request.focus === 'kind' && !props.request.lockKind) return; input.focus(); input.setSelectionRange(input.value.length, input.value.length); }}>
        {state => <>
          <Show when={kind() === 'link' && webAddress(text())}>{url => <LinkPreview notebook={props.notebook} url={url()} library={linkLibrary()} onLibrary={setLinkLibrary} onTitle={setLinkTitle} />}</Show>
          <Show when={!phoneControls()}>{destination()}</Show>
          <Show when={!atom() && !props.sheet}><CapturedToday notebook={props.notebook} refresh={added()} onOpen={(pageId, blockId) => props.onOpen({ kind: 'page', pageId, blockId }, false)} /></Show>
          <Show when={!props.sheet} fallback={<Show when={head()}>{mount => <Portal mount={mount()}><Button kind="stamp" disabled={state.busy() || !text().trim()} onClick={() => state.submit(false)}>Add</Button></Portal>}</Show>}>
            <footer class="create-foot"><span class="create-keys"><Show when={status()} fallback={<><kbd>↵</kbd> Add <kbd>⇧↵</kbd> Add another <kbd>esc</kbd> Close</>}>{value => <span role="status">{value()}</span>}</Show></span><Button onClick={cancel}>Cancel</Button><Button class="bordered create-add" disabled={state.busy() || !text().trim()} onClick={() => state.submit(false)}>{atom() ? `Add to ${destinationTitle()}` : `Add ${landing()}`}</Button></footer>
          </Show>
        </>}
      </CaptureField></Match>
    </Switch>
    <Show when={phoneControls()}>
      <div class="create-controls" onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()}>
        <Seg<CreateKind> class="create-kind-seg" label="Kind" value={kind() === 'link' ? 'note' : kind()} options={segKinds} onChange={value => changeKind(value, true)} />
        <Show when={intoSegment()} fallback={destination()}>
          <p class="create-into-label">Into {atom() ? 'an atom' : 'today'}</p>
          <Seg<string> class="create-into-seg" label="Into" value={atom() ? 'atom' : sectionId() ?? ''} options={intoOptions()} onChange={chooseSegment} />
          <Show when={sectionId() === 'reading' && kind() !== 'card'}><ReadingUnder notebook={props.notebook} value={under()} onChange={setUnder} /></Show>
        </Show>
      </div>
    </Show>
    <Show when={props.sheet} fallback={editors()}><InlinePopups>{editors()}</InlinePopups></Show>
  </div></SlipLoadingContext.Provider>;
}
