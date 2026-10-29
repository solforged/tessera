import { For, Show, batch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import { ulid } from 'ulid';
import { ApiError } from '../api/client';
import type { CardKind, CardPreviews, CardQuery, CardQueryResult, CardRow, CardSelection, Deck, Grade, ReviewEvent, ReviewSession, ReviewStats, TagDeck } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { plainText } from '../outline/names';
import { opensBeside } from '../shell/beside';
import type { CommandRegistry, OpenTarget, PaneId, ReviewViewState } from '../shell/contract';
import { shortDay } from '../shell/desk-counts';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { localDate } from '../ui/MonthGrid';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { createSlowFlag } from '../ui/loading';
import { documentReady } from '../tasks/JournalAgenda';
import { civilDate, relativeDate } from '../tasks/relative-date';
import { CardComposer } from './CardComposer';
import type { CreateRequest } from '../create/request';
import type { PopupAnchor } from '../ui/Popup';
import { DeckEditor } from './DeckEditor';
import { cardKindLabel, cardSubject, groupLetter, occlusionSides, parseCardText } from './card-text';
import { CardBack, CardFront } from './CardSides';
import { ReviewCard } from './ReviewCard';
import { settleHeight } from './settle';
import { copyCardQuery, formatInterval, gradeLabels, gradeOperation, loadReviewCard, openReviewSession, sameCardSnapshot, selectionLabels, sessionQueue } from './query';
import { ReviewSourcePassage, reviewSource } from './ReviewSource';
import type { ReviewSource } from './ReviewSource';
import './review.css';

export interface ReviewPaneProps {
  pane: PaneId;
  view: ReviewViewState;
  notebook: NotebookClient;
  commands: CommandRegistry;
  active: boolean;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: ReviewViewState): void;
  onCreate(request: CreateRequest, anchor?: PopupAnchor): void;
}

type Presentation = { item: CardRow; previews: CardPreviews; context: ReviewSource | null };
/** `blockId` starts a review of that block's cards once the open review, if any, is closed. */
type Destination = { deckId: string | null; sessionId: string | null; selection?: CardSelection | null; blockId?: string };
type DeckChoice = { id: string | null; name: string; query: CardQuery };
type DeckCounts = { id: string | null; name: string; due: number; new: number; all: number };

const selections = Object.keys(selectionLabels) as CardSelection[];
/** A touch screen has no Enter key to aim, so the landing leaves focus alone instead of ringing its button. */
const touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)');
const coverLayout = window.matchMedia('(max-width: 599px) and (pointer: coarse)');
/** Holds a control shut without `disabled`, which would dim it and drop its focus for a write that takes milliseconds. */
const dis = (value: boolean) => value ? 'true' as const : undefined;

function deckRows(saved: readonly Deck[], tags: readonly TagDeck[]): DeckChoice[] {
  const superseded = new Set(saved.flatMap(deck => {
    const source = deck.query.source;
    return source?.type && !source.text && !source.filters.length && !source.links?.length && !source.from?.length
      && !source.cites?.length && !source.note_kind && !source.source ? [source.type] : [];
  }));
  const rows = [
    ...saved.map(deck => ({ id: deck.id, name: deck.name, query: deck.query })),
    ...tags.filter(deck => !superseded.has(deck.id)),
  ].sort((a, b) => a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()) || a.id.localeCompare(b.id));
  return [{ id: null, name: 'All cards', query: { source: null, selection: 'due', limit: null } }, ...rows];
}

export function ReviewPane(props: ReviewPaneProps) {
  return <CardReviewPane {...props} />;
}

function CardReviewPane(props: ReviewPaneProps) {
  const [deckId, setDeckId] = createSignal(props.view.deckId);
  const [sessionId, setSessionId] = createSignal(props.view.sessionId);
  const [decks, setDecks] = createSignal<Deck[]>([]);
  const [tagDecks, setTagDecks] = createSignal<TagDeck[]>([]);
  const [sessionTagDeck, setSessionTagDeck] = createSignal<TagDeck | null>(null);
  const [sessions, setSessions] = createSignal<ReviewSession[]>([]);
  const [session, setSession] = createSignal<ReviewSession | null>(null);
  const [selection, setSelection] = createSignal<CardSelection | null>(props.view.selection ?? null);
  const [query, setQuery] = createSignal<CardQuery>({ source: null, selection: 'due', limit: null });
  const [rows, setRows] = createSignal<CardRow[]>([]);
  const [total, setTotal] = createSignal(0);
  const [loadedCount, setLoadedCount] = createSignal(0);
  const [counts, setCounts] = createSignal<Partial<Record<CardSelection, number>>>({});
  const [ready, setReady] = createSignal(false);
  const slowReady = createSlowFlag(() => !ready());
  const [shown, setShown] = createSignal<Presentation | null>(null);
  // The card being replaced stays on screen, disabled, until the read that replaces it lands, so grading or undoing
  // never paints an empty frame.
  const [outgoing, setOutgoing] = createSignal<Presentation | null>(null);
  const [holding, setHolding] = createSignal(false);
  createEffect(() => { if (!loading() && !holdOutgoing() && !holding()) setOutgoing(null); });
  const [updated, setUpdated] = createSignal<Presentation | null>(null);
  const [stale, setStale] = createSignal('');
  const [needsReload, setNeedsReload] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [readError, setReadError] = createSignal('');
  const [commandError, setCommandError] = createSignal('');
  const [pending, setPending] = createSignal('');
  // A command's status line waits like a load notice; shown at once, it pushes the card down for a frame.
  const slowPending = createSlowFlag(() => !!pending());
  const [retry, setRetry] = createSignal(0);
  const [picker, setPicker] = createSignal<HTMLElement | null>(null);
  const [search, setSearch] = createSignal('');
  const [actions, setActions] = createSignal<HTMLElement | null>(null);
  const [sessionActions, setSessionActions] = createSignal<HTMLElement | null>(null);
  const [composer, setComposer] = createSignal<HTMLElement | null>(null);
  const [editor, setEditor] = createSignal<{ anchor: HTMLElement; deck: Deck | null } | null>(null);
  const [deletion, setDeletion] = createSignal<{ anchor: HTMLElement; deck: Deck } | null>(null);
  const [switching, setSwitching] = createSignal<{ anchor: HTMLElement; target: Destination } | null>(null);
  const [closing, setClosing] = createSignal<HTMLElement | null>(null);
  const [events, setEvents] = createSignal<ReviewEvent[]>([]);
  const [stats, setStats] = createSignal<ReviewStats | null>(null);
  const [nextDue, setNextDue] = createSignal<number | null>(null);
  const [inventory, setInventory] = createSignal<number | null>(null);
  const [ledger, setLedger] = createSignal<DeckCounts[]>([]);
  const [landingCards, setLandingCards] = createSignal<CardQueryResult | null>(null);
  const [answerRevealed, setAnswerRevealed] = createSignal(false);
  /** The summary stays up while an undo from it reloads the session. */
  const [leaving, setLeaving] = createSignal(false);
  // The summary stays up, here or in a peer pane on the same session, until what replaces it has loaded. It is held when `done` turns false, below.
  createEffect(() => {
    if (leaving() && (done() || !!shown() || !!readError() || !!stale() || !session() || openSession() && ready() && !loading() && !locked())) setLeaving(false);
  });
  const [restoredCardId, setRestoredCardId] = createSignal<string | null>(null);
  const [blockRequest, setBlockRequest] = createSignal(props.view.blockId ?? null);
  const [startRequest, setStartRequest] = createSignal(props.view.start);
  /** The block a session reviews, named by its subject; null for a deck session. */
  const [scope, setScope] = createSignal<string | null>(null);
  const latestGrade = createMemo(() => session()?.state !== 'abandoned' ? events().filter(event => event.kind === 'grade').at(-1) ?? null : null);
  const grades = createMemo(() => events().filter(event => event.kind === 'grade'));
  const gradedCount = () => grades().length;
  const missed = createMemo(() => grades().filter(event => event.grade === 'again'));
  const selectedDeck = createMemo(() => decks().find(deck => deck.id === deckId()));
  const openSession = createMemo(() => session()?.state === 'open' && session()?.id === sessionId() ? session() : null);
  const openSessions = createMemo(() => sessions().filter(value => value.state === 'open').sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id)));
  const otherSessions = createMemo(() => openSessions().filter(value => value.id !== sessionId()));
  // Queue bookkeeping must not refresh a shown card unless command state changes.
  const commandState = createMemo(() => props.notebook.commandState());
  const queued = createMemo(() => ['saving', 'queued', 'offline'].includes(commandState()));
  const locked = createMemo(() => !!pending() || queued());
  // A notice for a write that is already done by the next frame would only push the card down.
  const slowQueued = createSlowFlag(() => queued() && !pending());
  const done = createMemo(() => !!session() && session()!.state !== 'open' && ready() && !loading() && !readError() && !locked());
  // The last card's grade leaves the queue empty until the review finishes; its card and footer stay up, held shut, until the summary can replace them.
  const holdOutgoing = createMemo(() => !!outgoing() && !!session() && !shown() && (!rows().length || locked()) && !restoredCardId() && !readError() && !stale() && !commandError() && !done());
  // While the summary is held, or a finished review's last card is still up, the session chrome keeps the shape it had.
  const sessionActive = createMemo(() => !leaving() && !!openSession() || (loading() || holdOutgoing() || holding()) && !!outgoing() && !!session());
  // A graded card is held from the grade until the next card, the summary or a failure replaces it, whatever order the signals in between settle in.
  createEffect(() => { if (holding() && (shown() || done() || readError() || stale() || commandError() || restoredCardId() || !session())) setHolding(false); });
  createEffect(on(done, (now, was) => { if (was && !now) setLeaving(true); }));
  const undoDisabled = createMemo(() => locked() || loading() || !!readError() || !latestGrade());
  const sessionChoices = createMemo(() => {
    const needle = search().trim().toLocaleLowerCase();
    return otherSessions().filter(value => sessionLabel(value).toLocaleLowerCase().includes(needle));
  });
  let paneRoot!: HTMLDivElement;
  let scroll!: HTMLDivElement;
  const paneBounds = () => paneRoot.getBoundingClientRect();
  const reviewCard = () => scroll.querySelector<HTMLElement>('.review-card');
  let released: { height: number; at: number } | null = null;
  /** A card that replaces another eases from its height instead of snapping, so the page below it glides. */
  function settleLayout(element: HTMLDivElement) {
    const previous = released && performance.now() - released.at < 500 ? released.height : 0;
    released = null;
    // Only a card that replaces another fades in; the first one arrives with the pane's own entrance.
    if (previous) element.classList.add('review-session-swap');
    queueMicrotask(() => { if (element.isConnected) settleHeight(element, previous); });
    onCleanup(() => { released = { height: element.offsetHeight, at: performance.now() }; });
  }
  let heading!: HTMLDivElement;
  let startButton: HTMLButtonElement | undefined;
  let generation = 0;
  let disposed = false;
  let recover = true;
  let autoFinishAttempt = '';
  onCleanup(() => { disposed = true; generation++; });
  onMount(() => {
    scroll.scrollTop = props.view.scroll;
    // A control held shut while a write is in flight stays focusable, so its click is refused here, before any handler sees it.
    const refuse = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.button[aria-disabled="true"]')) { event.preventDefault(); event.stopPropagation(); }
    };
    paneRoot.addEventListener('click', refuse, true);
    onCleanup(() => paneRoot.removeEventListener('click', refuse, true));
  });

  function nameForDeck(id: string) {
    return decks().find(deck => deck.id === id)?.name ?? tagDecks().find(deck => deck.id === id)?.name
      ?? (sessionTagDeck()?.id === id ? sessionTagDeck()?.name : undefined);
  }

  function sessionLabel(value: ReviewSession) {
    const name = value.deck_id ? nameForDeck(value.deck_id) ?? 'Deleted deck' : 'All cards';
    return `${name} · ${new Date(value.started_at).toLocaleString()}`;
  }

  function publish() {
    if (!disposed) untrack(() => props.onViewChange({ ...props.view, blockId: blockRequest() ?? undefined, start: startRequest(), deckId: deckId(), sessionId: sessionId(), selection: selection(), scroll: scroll?.scrollTop ?? props.view.scroll }));
  }

  function moveTo(target: Destination) {
    recover = false;
    generation++;
    // A move between overviews keeps the landing on screen while the next read lands, so the page does not remount.
    const overview = ready() && !session() && !target.sessionId;
    batch(() => {
      setDeckId(target.deckId); setSessionId(target.sessionId); setSession(null); setSelection(target.selection ?? null);
      setShown(null); setUpdated(null); setStale(''); setNeedsReload(false); setCommandError('');
      setEvents([]); setRestoredCardId(null); setScope(null);
      setSessionTagDeck(null);
      if (!overview) { setStats(null); setLedger([]); setInventory(null); setLandingCards(null); setRows([]); setCounts({}); setReady(false); }
      setLoading(true); setSwitching(null); setRetry(value => value + 1);
    });
    publish();
  }

  function selectQueue(value: CardSelection) {
    if (value === query().selection) return;
    setShown(null); setUpdated(null); setStale(''); setNeedsReload(false); setSelection(value); publish();
  }

  createEffect(on(() => [props.view.deckId, props.view.sessionId, props.view.selection ?? null] as const, ([nextDeck, nextSession, nextSelection]) => {
    if (nextDeck === deckId() && nextSession === sessionId()) {
      if (nextSelection !== selection()) {
        setShown(null); setUpdated(null); setStale(''); setNeedsReload(false); setSelection(nextSelection);
      }
      return;
    }
    // A same-kind shell navigation must not bypass the open-session choice.
    publish();
    requestMove({ deckId: nextDeck, sessionId: nextSession, selection: nextSelection }, heading);
  }, { defer: true }));

  createEffect(on(() => [deckId(), sessionId(), selection(), props.notebook.changeSequence(), props.notebook.todayDate(), commandState(), retry()] as const, () => { void refresh(); }));
  createEffect(on(() => props.view.blockId, id => { if (id) setBlockRequest(id); }, { defer: true }));
  createEffect(on(() => props.view.start, requested => { if (requested) setStartRequest(true); }, { defer: true }));
  createEffect(on(() => [startRequest(), ready(), loading(), locked(), readError()] as const, ([requested, isReady, isLoading, isLocked, error]) => {
    if (!requested || !isReady || isLoading || isLocked || error) return;
    if (!openSession() && (deckId() || session() || query().selection !== 'due')) {
      moveTo({ deckId: null, sessionId: null, selection: 'due' });
      return;
    }
    setStartRequest(undefined);
    publish();
    if (!openSession()) void start();
  }));
  // Consume this navigation request before publishing: retaining blockId would enqueue it again on every view update.
  // Track only readiness here; reading and publishing shell state must not subscribe this effect to its own output.
  createEffect(on(() => [blockRequest(), ready(), loading(), locked()] as const, ([id, isReady, isLoading, isLocked]) => {
    if (!id || !isReady || isLoading || isLocked) return;
    setBlockRequest(null);
    publish();
    reviewBlock(id);
  }));
  createEffect(on(shown, value => {
    if (!value) return;
    setAnswerRevealed(false);
    queueMicrotask(() => {
      if (!disposed && props.active && shown() === value) scroll.querySelector<HTMLElement>('.review-card')?.focus({ preventScroll: true });
    });
  }));
  // The landing offers one action, so Enter or Space starts the review once the queue is known.
  createEffect(on(() => ready() && !openSession() && rows().length > 0, offer => {
    if (!offer || touchOnly.matches) return;
    queueMicrotask(() => {
      const focused = document.activeElement;
      if (!disposed && props.active && startButton && (!focused || focused === document.body || scroll.closest('.review-pane')?.contains(focused))) startButton.focus({ preventScroll: true });
    });
  }));

  createEffect(on(done, finished => {
    if (!finished) return;
    queueMicrotask(() => {
      if (!disposed && props.active && done() && document.activeElement === document.body) scroll.querySelector<HTMLElement>('[aria-label="Session summary"]')?.focus({ preventScroll: true });
    });
  }));

  createEffect(() => {
    const current = openSession();
    if (!current || !ready() || loading() || locked() || readError() || stale() || needsReload() || rows().length || shown() || restoredCardId()) return;
    const attempt = `${current.id}:${current.revision}`;
    if (autoFinishAttempt === attempt) return;
    autoFinishAttempt = attempt;
    void closeSession('finished');
  });

  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || !props.active || undoDisabled() || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') || target instanceof HTMLElement && target.isContentEditable) return;
    event.preventDefault(); event.stopPropagation();
    void undoGrade();
  }
  async function presentation(item: CardRow): Promise<Presentation> {
    const [previews, context] = await Promise.all([props.notebook.api.cardPreviews(item.card.id), reviewSource(props.notebook.api, item)]);
    const current = await props.notebook.api.card(item.card.id);
    if (!sameCardSnapshot(item.card, current)) throw new Error('The card changed while loading its intervals. Refresh to review its current text.');
    return { item, previews, context };
  }

  async function refresh() {
    const version = ++generation;
    const requestedDeck = deckId();
    const requestedSession = sessionId();
    const requestedSelection = selection();
    const restored = restoredCardId();
    // A read started around an unacknowledged command cannot establish exhaustion.
    if (pending() || queued()) { setLoading(false); return; }
    setLoading(true);
    try {
      const [savedDecks, currentTagDecks, savedSessions] = await Promise.all([props.notebook.api.decks(), props.notebook.api.tagDecks(), props.notebook.api.reviewSessions()]);
      if (disposed || version !== generation) return;
      let currentSession = requestedSession ? savedSessions.find(value => value.id === requestedSession) ?? await props.notebook.api.reviewSession(requestedSession) : null;
      if (disposed || version !== generation) return;
      if (!requestedSession && recover) {
        recover = false;
        // A phone tab opens the overview; saved sessions stay available through Open reviews.
        currentSession = coverLayout.matches ? null : openReviewSession(savedSessions, requestedDeck) ?? null;
        if (currentSession) {
          setSessionId(currentSession.id); publish();
          return;
        }
      }
      if (currentSession?.state === 'open' && currentSession.deck_id !== requestedDeck) {
        setDeckId(currentSession.deck_id); setSelection(null); publish();
        return;
      }
      let deck: Deck | TagDeck | undefined = savedDecks.find(value => value.id === requestedDeck) ?? currentTagDecks.find(value => value.id === requestedDeck);
      let nextSessionTagDeck: TagDeck | null = null;
      if (requestedDeck && !deck) {
        if (!currentSession) {
          moveTo({ deckId: null, sessionId: null });
          return;
        }
        const page = await props.notebook.api.block(requestedDeck).catch((reason: unknown) => { if (reason instanceof ApiError && reason.status === 404) return null; throw reason; });
        if (disposed || version !== generation) return;
        if (!page || page.kind !== 'page' || page.archived) throw new Error('This deck was deleted. End the open review, then choose another deck.');
        nextSessionTagDeck = {
          id: page.id, name: page.text,
          query: { source: { type: page.id, text: null, filters: [], sort: [], limit: null }, selection: 'due', limit: null },
        };
        deck = nextSessionTagDeck;
      }
      const nextQuery = copyCardQuery(deck?.query ?? { source: null, selection: 'due', limit: null });
      if (requestedSelection) nextQuery.selection = requestedSelection;
      const [result, history, nextStats, globalStats, nextLandingCards, ...totals] = await Promise.all([
        props.notebook.api.cardQuery({ ...nextQuery, limit: nextQuery.limit ?? 2000 }),
        currentSession ? props.notebook.api.reviewSessionEvents(currentSession.id) : Promise.resolve([] as ReviewEvent[]),
        props.notebook.api.reviewStats(requestedDeck, props.notebook.todayDate()),
        !currentSession && requestedDeck ? props.notebook.api.reviewStats(null, props.notebook.todayDate()) : Promise.resolve(null),
        !currentSession ? props.notebook.api.cardQuery({ source: nextQuery.source, selection: nextQuery.selection, limit: 50 }) : Promise.resolve(null),
        ...selections.map(value => props.notebook.api.cardQuery({ ...nextQuery, selection: value, limit: 0 }).then(found => found.total)),
      ]);
      // All is ordered by scheduled time before new cards; one row is enough
      // when the due-now queue is empty, without loading the whole inventory.
      const upcoming = !currentSession && totals[0] === 0
        ? (await props.notebook.api.cardQuery({ ...nextQuery, selection: 'all', limit: 1 })).rows[0]?.card.schedule.due_at
        : undefined;
      if (disposed || version !== generation) return;
      if (currentSession && currentSession.state !== 'open' && !history.some(event => event.kind === 'grade')) {
        moveTo({ deckId: currentSession.deck_id, sessionId: null, selection: requestedSelection });
        return;
      }
      let candidates = result.rows;
      let nextScope: string | null = null;
      const missedFrom = currentSession ? localStorage.getItem(`tessera.review-missed.${currentSession.id}`) : null;
      const blockFrom = currentSession ? localStorage.getItem(`tessera.review-block.${currentSession.id}`) : null;
      if (missedFrom) {
        const original = await props.notebook.api.reviewSessionEvents(missedFrom);
        const ids = [...new Set(original.filter(event => event.grade === 'again').map(event => event.card_id))];
        candidates = (await Promise.all(ids.map(id => loadReviewCard(props.notebook.api, id)))).filter(row => row.card.active && !row.card.held);
      } else if (blockFrom) {
        // A deleted block leaves nothing to review, so its session finishes instead of failing every read.
        const block = await props.notebook.api.block(blockFrom).catch((reason: unknown) => { if (reason instanceof ApiError && reason.status === 404) return null; throw reason; });
        const units = block ? await props.notebook.api.sourceCards(blockFrom) : [];
        candidates = await Promise.all(units.filter(card => card.active && !card.held).map(card => loadReviewCard(props.notebook.api, card.id)));
        nextScope = block ? cardSubject(block.text) || 'Untitled atom' : 'Deleted atom';
      }
      // Another pane on this session undid a grade: this pane's history lost that card, so it shows the card the undo restored.
      // That wins over an older restore this pane made itself, which a later undo elsewhere has superseded.
      const gone = currentSession?.state === 'open'
        ? events().filter(event => event.kind === 'grade' && !history.some(item => item.kind === 'grade' && item.card_id === event.card_id)).at(-1)?.card_id ?? null : null;
      const queue = currentSession?.state === 'open' ? await sessionQueue(props.notebook.api, candidates, history, gone ?? restored) : { rows: candidates, restoredUnavailable: false };
      const remaining = queue.rows;
      const nextLedger = !currentSession ? await Promise.all(deckRows(savedDecks, currentTagDecks).map(async deck => {
        const [due, fresh, all] = await Promise.all(selections.map(value => props.notebook.api.cardQuery({ source: deck.query.source, selection: value, limit: 0 }).then(found => found.total)));
        return { id: deck.id, name: deck.name, due: due!, new: fresh!, all: all! };
      })) : [];
      if (disposed || version !== generation) return;
      let nextShown = shown();
      const previousShown = nextShown;
      let nextUpdated: Presentation | null = null;
      let nextStale = '';
      if (currentSession?.state !== 'open') {
        nextShown = null;
      } else if (queue.restoredUnavailable) {
        nextShown = null;
        nextStale = 'The restored card is no longer available. Skip it to continue this review.';
      } else if (nextShown && !gone) {
        const candidate = remaining.find(row => row.card.id === nextShown!.item.card.id);
        if (!candidate) {
          // Graded in this session elsewhere, as another pane on it does: move on quietly instead of reporting a stale card.
          if (history.some(event => event.kind === 'grade' && event.card_id === nextShown!.item.card.id)) nextShown = remaining[0] ? await presentation(remaining[0]) : null;
          else nextStale = 'This card is no longer in this queue, or was already graded in this review.';
        } else if (!sameCardSnapshot(nextShown.item.card, candidate.card) || needsReload()) {
          nextUpdated = await presentation(candidate);
          nextStale = needsReload() ? 'Review the current card before continuing.' : 'This card changed after it was shown. Review its current text before grading.';
        }
      } else if (remaining[0]) {
        nextShown = await presentation(remaining[0]);
      }
      if (disposed || version !== generation) return;
      // Publish one complete snapshot. Empty rows from a superseded/failed read never finish a session.
      batch(() => {
        setDecks(savedDecks); setTagDecks(currentTagDecks); setSessionTagDeck(nextSessionTagDeck);
        setSessions(savedSessions); setSession(currentSession); setScope(nextScope);
        setQuery(nextQuery); setRows(remaining); setTotal(result.total); setLoadedCount(result.rows.length);
        setLandingCards(nextLandingCards);
        setEvents(history); setStats(nextStats); setLedger(nextLedger);
        setNextDue(upcoming && upcoming > Date.now() ? upcoming : null);
        if (!currentSession) setInventory((globalStats ?? nextStats).total_cards + (globalStats ?? nextStats).held_cards);
        setCounts(Object.fromEntries(selections.map((value, index) => [value, totals[index]!])));
        // A card that left the screen because another pane graded it stays up, held shut, until the summary or the next card can replace it.
        if (!nextShown && previousShown) { setOutgoing(previousShown); if (!gone && !nextStale) setRestoredCardId(null); }
        setShown(nextShown); setUpdated(nextUpdated); setStale(nextStale);
        if (gone) setRestoredCardId(gone);
        setReadError(''); setReady(true); setLoading(false);
      });
    } catch (reason) {
      if (!disposed && version === generation) setReadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed && version === generation) setLoading(false);
    }
  }

  function requestMove(target: Destination, anchor: HTMLElement) {
    if (target.deckId === deckId() && target.sessionId === sessionId()) return;
    if (locked() || loading() || sessionId() && !session()) {
      setCommandError('Wait for the current review to load or finish saving before switching.');
      return;
    }
    if (openSession()) setSwitching({ anchor, target });
    else moveTo(target);
  }

  async function start() {
    if (locked() || loading() || readError() || openSession() || !rows().length) return;
    const id = ulid();
    const targetDeck = deckId();
    generation++; recover = false; setPending('Starting review…'); setCommandError('');
    try {
      await props.notebook.commit([{ op: 'start_review_session', id, deck_id: targetDeck, started_at: Date.now() }], 'Start review');
      if (disposed) return;
      setShown(null); setUpdated(null); setStale(''); setNeedsReload(false);
      setSessionId(id); publish();
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) { setPending(''); setRetry(value => value + 1); }
    }
  }

  async function closeSession(state: 'finished' | 'abandoned', target?: Destination) {
    if (locked() || loading() || readError()) return;
    const value = session();
    if (!value) return;
    if (value.state !== 'open') {
      setClosing(null); setSwitching(null);
      if (target) await go(target);
      return;
    }
    generation++;
    setPending(state === 'finished' ? 'Finishing review…' : 'Abandoning review…'); setCommandError('');
    try {
      const receipt = await props.notebook.commit([{ op: 'finish_review_session', id: value.id, base_revision: value.revision, state, ended_at: Date.now() }], state === 'finished' ? 'Finish review' : 'Abandon review');
      if (disposed) return;
      recover = false;
      setClosing(null);
      setSession(receipt.review_sessions?.find(item => item.id === value.id) ?? null);
      // The card stays up, held shut, until the read that shows the summary lands.
      batch(() => { setOutgoing(shown() ?? outgoing()); setLoading(true); setShown(null); setUpdated(null); setStale(''); setNeedsReload(false); });
      if (target) await go(target);
      else if (!gradedCount()) moveTo({ deckId: value.deck_id, sessionId: null, selection: selection() });
      else { setSwitching(null); publish(); }
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) batch(() => { setLoading(true); setPending(''); setRetry(value => value + 1); });
    }
  }

  async function grade(value: Grade, reset: boolean, snapshot: Presentation) {
    const currentSession = openSession();
    if (locked() || loading() || readError() || stale() || needsReload() || !currentSession || shown() !== snapshot) return;
    const operation = gradeOperation(snapshot.item, currentSession.id, value, reset, ulid(), Date.now());
    generation++; setPending('Saving grade…'); setCommandError('');
    try {
      await props.notebook.commit([operation], 'Grade card');
    } catch (reason) {
      if (!disposed) {
        setNeedsReload(true);
        setLoading(true); setPending(''); await refresh();
      }
      throw reason;
    }
    if (disposed) return;
    // The acknowledgement, not the click or a speculative query, releases the shown snapshot.
    batch(() => { setLoading(true); setOutgoing(snapshot); setHolding(true); setShown(null); setUpdated(null); setStale(''); setRestoredCardId(null); setPending(''); });
    await refresh();
  }

  async function undoGrade() {
    const current = session();
    const event = latestGrade();
    if (!current || !event || undoDisabled()) return;
    // Undoing from the summary keeps it up until the card it restores has loaded, so the pane is never empty between them.
    generation++; batch(() => { setLeaving(done()); setPending('Undoing grade…'); }); setCommandError('');
    try {
      const card = await props.notebook.api.card(event.card_id);
      if (disposed) return;
      const receipt = await props.notebook.commit([{
        op: 'undo_grade', id: card.id, base_revision: card.revision, review_id: event.id,
        event_id: ulid(), session_revision: current.revision, undone_at: Date.now(),
      }], 'Undo last grade');
      if (disposed) return;
      batch(() => {
        setSession(receipt.review_sessions?.find(value => value.id === current.id) ?? current);
        setLoading(true); setOutgoing(shown()); setRestoredCardId(card.id); setShown(null); setUpdated(null); setStale(''); setNeedsReload(false);
      });
    } catch (reason) {
      if (!disposed) setCommandError(`Could not undo the grade: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (!disposed) batch(() => { setLoading(true); setPending(''); setRetry(value => value + 1); });
    }
  }

  async function reset(snapshot: Presentation) {
    const currentSession = openSession();
    if (locked() || loading() || readError() || stale() || needsReload() || !currentSession || shown() !== snapshot) return;
    generation++; setPending('Resetting progress…'); setCommandError('');
    try {
      await props.notebook.commit([{ op: 'reset_card', id: snapshot.item.card.id, base_revision: snapshot.item.card.revision, event_id: ulid(), session_id: currentSession.id, reviewed_at: Date.now() }], 'Reset card');
    } catch (reason) {
      if (!disposed) {
        setNeedsReload(true);
        setLoading(true); setPending(''); await refresh();
      }
      throw reason;
    }
    if (disposed) return;
    setNeedsReload(true); setLoading(true); setPending('');
    await refresh();
    if (disposed) return;
    const next = updated();
    if (next) { setShown(next); setUpdated(null); setStale(''); setNeedsReload(false); }
  }

  function acceptUpdated() {
    if (locked() || loading() || readError()) return;
    const next = updated();
    batch(() => {
      if (!next) { setLoading(true); setRestoredCardId(null); setRetry(value => value + 1); }
      setShown(next); setUpdated(null); setStale(''); setNeedsReload(false); setCommandError('');
    });
  }

  async function deleteDeck(deck: Deck) {
    if (locked() || openSession()) return;
    setPending('Deleting deck…'); setCommandError('');
    try {
      await props.notebook.commit([{ op: 'delete_deck', id: deck.id, base_revision: deck.revision }], 'Delete deck');
      if (disposed) return;
      setDeletion(null); moveTo({ deckId: null, sessionId: null });
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) { setPending(''); setRetry(value => value + 1); }
    }
  }

  async function reviewMissed() {
    if (!done() || !missed().length || locked() || loading()) return;
    const previous = session()!.id;
    const id = ulid();
    generation++; setPending('Starting missed cards…'); setCommandError(''); recover = false;
    try {
      // Store only the evidence session, never a copied card definition or schedule.
      localStorage.setItem(`tessera.review-missed.${id}`, previous);
      await props.notebook.commit([{ op: 'start_review_session', id, deck_id: deckId(), started_at: Date.now() }], 'Review missed cards');
      if (!disposed) moveTo({ deckId: deckId(), sessionId: id, selection: 'all' });
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) { setPending(''); setRetry(value => value + 1); }
    }
  }

  /** Leaves for `target`, starting a block review when it asks for one. */
  async function go(target: Destination) {
    if (target.blockId) await startBlockReview(target.blockId);
    else moveTo(target);
  }

  function reviewBlock(blockId: string) {
    if (openSession()) {
      if (localStorage.getItem(`tessera.review-block.${openSession()!.id}`) !== blockId) setSwitching({ anchor: heading, target: { deckId: null, sessionId: null, blockId } });
      return;
    }
    void startBlockReview(blockId);
  }

  async function startBlockReview(blockId: string) {
    const id = ulid();
    generation++; setPending('Starting review…'); setCommandError(''); recover = false;
    try {
      // Store only the block, never a copied card definition or schedule. Its cards are due or not.
      localStorage.setItem(`tessera.review-block.${id}`, blockId);
      await props.notebook.commit([{ op: 'start_review_session', id, deck_id: null, started_at: Date.now() }], 'Review atom cards');
      if (!disposed) moveTo({ deckId: null, sessionId: id, selection: 'all' });
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) { setPending(''); setRetry(value => value + 1); }
    }
  }

  async function backToToday() {
    if (!done() || locked() || loading() || disposed) return;
    const pageId = await props.notebook.today();
    props.onOpen({ kind: 'page', pageId }, false);
  }

  async function createCard(text: string, again: boolean) {
    const pageId = await props.notebook.today();
    const doc = props.notebook.open(pageId);
    try {
      await documentReady(doc);
      const id = ulid();
      await props.notebook.commit([{
        op: 'insert', id, parent_id: pageId, after: doc.outline.children(pageId).at(-1) ?? null, text, heading: null,
      }], 'Create card', [pageId]);
      if (!disposed && !again) {
        setComposer(null);
        props.onOpen({ kind: 'page', pageId, blockId: id, caretId: id }, false);
      }
    } finally { doc.release(); }
  }

  const deckName = createMemo(() => scope() ?? (deckId() ? nameForDeck(deckId()!) ?? 'Unavailable deck' : 'All cards'));
  const progressLabel = () => `${Math.min(gradedCount() + 1, gradedCount() + rows().length)} of ${gradedCount() + rows().length}`;
  const emptyWorkshop = () => !session() && ready() && inventory() === 0;
  return <div ref={paneRoot} class="review-pane" classList={{ 'review-session-active': sessionActive(), 'review-session-done': done() || leaving() }} data-pane={props.pane} role="region" aria-label="Review" tabIndex={0} onFocusIn={props.onActivate} onPointerDown={props.onActivate} onKeyDown={keydown}>
    <Show when={!emptyWorkshop()}><div class="review-head">
      <Show when={sessionActive()}><header class="review-glass-bar" aria-label="Review session">
        <Button class="review-session-close" aria-disabled={dis(locked() || loading() || !!readError())} onClick={() => void closeSession('finished', { deckId: deckId(), sessionId: null, selection: selection() })}>Close</Button>
        <div class="review-glass-title"><h1>{deckName()}</h1><span class="review-progress-label">{leaving() ? '\u00a0' : ready() ? progressLabel() : 'Loading cards…'}</span></div>
        <Button icon="more" label="Session actions" aria-haspopup="menu" aria-expanded={!!sessionActions()} aria-disabled={dis(locked() || loading())} onClick={event => setSessionActions(event.currentTarget)} />
      </header></Show>
      <header class="review-header">
        <div ref={heading} class="review-heading">
          <div class="review-register">Review</div>
          <h1>{deckName()}</h1>
        </div>
        <Show when={!sessionActive()}>
          <Show when={otherSessions().length}><Button class="review-open-sessions" aria-disabled={dis(locked() || loading())} aria-haspopup="dialog" onClick={event => { setSearch(''); setPicker(event.currentTarget); }}>Open reviews<span class="review-count">{otherSessions().length}</span></Button></Show>
          <Show when={selectedDeck()}><Button class="review-deck-actions" icon="more" label="Deck actions" aria-haspopup="menu" aria-disabled={dis(locked() || loading())} onClick={event => setActions(event.currentTarget)} /></Show>
        </Show>
      </header>
      <Show when={session()}><div class="review-toolbar">
        <Show when={sessionActive() && ready()}><div class="review-session-progress">
          <span class="review-progress-label">{leaving() ? '\u00a0' : progressLabel()}</span>
          <GradeStrip grades={grades()} remaining={rows().length} />
        </div></Show>
      </div></Show>
    </div></Show>
    <Show when={slowQueued() || commandState() === 'offline'}><div class="review-notice" role="status">
      {commandState() === 'offline' ? 'Offline · Review changes are kept for retry.' : 'Saving review changes…'}
      <Show when={commandState() === 'offline'}><Button onClick={() => props.notebook.retry()}>Retry delivery</Button></Show>
    </div></Show>
    <Show when={commandError()}><div class="pane-error" role="alert">{commandError()}</div></Show>
    <Show when={readError()}><div class="pane-error" role="alert">{readError()} <Button aria-disabled={dis(locked())} onClick={() => setRetry(value => value + 1)}>Refresh</Button></div></Show>
    <div ref={scroll} class="review-scroll" onScroll={publish}>
      <Show when={slowPending() || slowReady()}><p class="review-pending" role="status">{pending() || 'Loading cards…'}</p></Show>
      <Show when={total() > loadedCount() && !done()}><p class="review-pending">Showing {loadedCount()} of {total()} matching cards. Narrow the deck’s source filters to review the rest.</p></Show>
      <Show when={emptyWorkshop()}><section class="review-empty" aria-label="No cards yet">
        <h2>No cards yet.</h2>
        <p>Write a question and answer in an atom, or turn a source highlight into a card.</p>
        <Button class="bordered" icon="plus" aria-disabled={dis(locked() || loading())} onClick={event => setComposer(event.currentTarget)}>Create a card</Button>
      </section></Show>
      <Show when={!session() && ready() && inventory() !== 0 && stats()}>{value => <div class="review-landing">
        <div class="review-overview">
          <section class="review-today-load" aria-label="Selected review queue">
            <div role="group" aria-label="Review queue" class="review-queue-controls mode-tabs tab-strip" data-mode-panel=".review-queue-content"><For each={selections}>{value => <Button aria-pressed={query().selection === value} aria-disabled={dis(locked() || loading())} onClick={() => selectQueue(value)}>{selectionLabels[value]}<Show when={counts()[value] !== undefined}><span class="review-count">{counts()[value]}</span></Show></Button>}</For></div>
            <div class="review-queue-content">
            <Show when={rows().length} fallback={<>
              <div class="review-caught-up">{query().selection === 'new' ? 'Nothing new yet' : 'All caught up'}</div>
              <Show when={nextDue()}>{due => <p>Next card {nextCardTime(due(), props.notebook.todayDate(), props.notebook.settings()?.time_zone)}</p>}</Show>
            </>}>
              <div class="review-stat-value">{total()}<small>{query().selection === 'due' ? 'due now' : 'cards in this queue'}</small></div>
              <p>{[
                query().selection === 'due' ? '' : `${counts().due ?? 0} due now`,
                `${Math.max(0, value().due_review + value().due_new - (counts().due ?? 0))} later today`,
              ].filter(Boolean).join(' · ')}</p>
              <Button ref={startButton} class="review-start" aria-disabled={dis(locked() || loading() || !!readError())} onClick={() => void start()}><span class="review-cover-label">Start</span><span class="review-desktop-label">Review {rows().length} {rows().length === 1 ? 'card' : 'cards'} <kbd>Space</kbd></span></Button>
            </Show>
            <Show when={!rows().length && value().held_cards}><p class="review-held">{value().held_cards} {value().held_cards === 1 ? 'card is' : 'cards are'} paused or marked Not yet. Start or resume them from their source atoms.</p></Show>
            </div>
          </section>
          <ReviewForecast stats={value()} today={props.notebook.todayDate()} />
        </div>
        <dl class="review-stats">
          <div><dt>Retention</dt><dd title="Non-Again grades over the last 30 days">{value().retention === null ? '—' : Math.round(value().retention! * 100)}<Show when={value().retention !== null}><small>%</small></Show></dd></div>
          <div><dt>Last 7 days</dt><dd>{value().reviews_past_week}<small>{value().reviews_past_week === 1 ? 'review' : 'reviews'}</small></dd></div>
          <div><dt>Streak</dt><dd>{value().streak}<small>{value().streak === 1 ? 'day' : 'days'}</small></dd></div>
          <div><dt>Cards</dt><dd>{value().total_cards}</dd></div>
        </dl>
        <section class="review-decks" aria-label="Decks">
          <header><h2>Decks</h2><Button icon="plus" aria-disabled={dis(locked())} onClick={event => props.onCreate({ kind: 'card', text: '' }, event.currentTarget)}>New card</Button><Button icon="plus" aria-disabled={dis(locked())} onClick={event => setEditor({ anchor: event.currentTarget, deck: null })}>New deck</Button></header>
          <Show when={ledger().length === 1}><p class="review-decks-intro">Tag a card to make a deck. Save a deck for other filters.</p></Show>
          <table><thead><tr><th>Deck</th><th>Due</th><th>New</th><th>Cards</th></tr></thead><tbody><For each={ledger()}>{deck => <tr>
            <td><Button class="review-ledger-deck" classList={{ selected: deck.id === deckId() }} aria-disabled={dis(locked() || loading())} onClick={event => requestMove({ deckId: deck.id, sessionId: null }, event.currentTarget)}>{deck.name}</Button></td><td>{deck.due}</td><td>{deck.new}</td><td>{deck.all}</td>
          </tr>}</For></tbody></table>
        </section>
        <Show when={landingCards()}>{cards => <section class="review-cards" aria-label="Cards">
          <Show when={cards().total > 0} fallback={<p class="review-cards-empty">
            <span>{query().selection === 'due' ? 'No cards due' : query().selection === 'new' ? 'No new cards' : 'No cards in this deck'}</span>
            <Show when={query().selection !== 'all' && (counts().all ?? 0) > 0}><span aria-hidden="true">·</span><Button class="review-show-all" aria-disabled={dis(locked() || loading())} title={locked() || loading() ? 'Wait for cards to finish loading or saving.' : undefined} onClick={() => selectQueue('all')}>Show all <span class="review-count">{counts().all}</span> {counts().all === 1 ? 'card' : 'cards'}</Button></Show>
          </p>}>
            <h2><span>Cards</span><span class="section-rule" /><span class="review-count">{cards().total}</span></h2>
            <For each={cards().rows}>{row => <ReviewQueueRow row={row} notebook={props.notebook} onOpen={props.onOpen} />}</For>
            <Show when={cards().total > cards().rows.length}><p class="review-cards-more">{cards().total - cards().rows.length} more</p></Show>
          </Show>
        </section>}</Show>
      </div>}</Show>
      <Show when={(done() || leaving()) && session()}>{value => <section class="review-done" aria-label="Session summary" tabIndex={-1}>
        <h2>{gradedCount()} reviewed this session in {reviewDuration((value().ended_at ?? grades().at(-1)?.created_at ?? value().started_at) - value().started_at)}</h2>
        <dl class="review-stats">
          <div><dt>Good or easy</dt><dd>{grades().filter(event => event.grade === 'good' || event.grade === 'easy').length}</dd></div>
          <div><dt>Again</dt><dd class="error">{missed().length}</dd></div>
          <div><dt>Tomorrow</dt><dd>{stats()?.forecast[1]?.count ?? '—'}<small>due</small></dd></div>
          <div><dt>Streak</dt><dd>{stats()?.streak ?? '—'}<small>{stats()?.streak === 1 ? 'day' : 'days'}</small></dd></div>
        </dl>
        <Show when={grades().some(event => event.grade === 'hard')}><p class="review-pending">{grades().filter(event => event.grade === 'hard').length} Hard</p></Show>
        <Show when={stats()}>{value => <ReviewForecast stats={value()} today={props.notebook.todayDate()} />}</Show>
        <Show when={missed().length}><section class="review-missed"><h3>Missed</h3><For each={missed()}>{event => <ReviewMissedCard event={event} notebook={props.notebook} />}</For></section></Show>
        <div class="review-done-actions"><Button class="review-start" aria-disabled={dis(locked() || loading())} onClick={() => void backToToday()}>Back to Today</Button><Show when={missed().length}><Button class="bordered" aria-disabled={dis(locked() || loading())} onClick={() => void reviewMissed()}>Review missed</Button></Show><Button aria-disabled={dis(locked() || loading())} onClick={() => moveTo({ deckId: deckId(), sessionId: null })}>Back to decks</Button></div>
      </section>}</Show>
      <Show when={stale()}><section class="review-stale" aria-label="Card changed">
        <p role="alert">{stale()}</p>
        <Show when={updated() && shown() && (updated()!.item.card.front !== shown()!.item.card.front || updated()!.item.card.back !== shown()!.item.card.back)}>
          <div class="review-stale-versions">
            <section><h2>Shown text</h2><div><CardFront plain={!!shown()!.item.card.template} kind={shown()!.item.card.kind} front={shown()!.item.card.front} back={shown()!.item.card.back} notebook={props.notebook} /></div><div><CardBack plain={!!shown()!.item.card.template} kind={shown()!.item.card.kind} front={shown()!.item.card.front} back={shown()!.item.card.back} blocks={shown()!.item.card.answer_blocks} notebook={props.notebook} /></div></section>
            <section><h2>Current text</h2><div><CardFront plain={!!updated()!.item.card.template} kind={updated()!.item.card.kind} front={updated()!.item.card.front} back={updated()!.item.card.back} notebook={props.notebook} /></div><div><CardBack plain={!!updated()!.item.card.template} kind={updated()!.item.card.kind} front={updated()!.item.card.front} back={updated()!.item.card.back} blocks={updated()!.item.card.answer_blocks} notebook={props.notebook} /></div></section>
          </div>
        </Show>
        <Button class="bordered" aria-disabled={dis(locked() || loading() || !!readError())} onClick={acceptUpdated}>{updated() ? 'Review current card' : 'Next card'}</Button>
      </section></Show>
      <Show keyed when={shown() ?? (loading() || holdOutgoing() || holding() ? outgoing() : null)}>{snapshot => <>
        <div ref={settleLayout} class="review-session-layout" classList={{ 'review-has-context': !!snapshot.context }}>
          <ReviewCard item={snapshot.item} context={snapshot.context} onReveal={setAnswerRevealed} onEdit={beside => { publish(); props.onOpen({ kind: 'page', pageId: snapshot.item.source.page.id, blockId: snapshot.item.source.block.id, editOcclusion: snapshot.item.card.kind === 'occlusion' }, beside); }} notebook={props.notebook} previews={snapshot.previews.current} resetPreviews={snapshot.previews.reset} busy={locked() || loading() || !!readError() || !!stale() || needsReload() || !openSession()} onGrade={(value, restart) => grade(value, restart, snapshot)} onReset={() => reset(snapshot)} onSource={beside => {
            publish(); props.onOpen(snapshot.context && !snapshot.item.card.template ? { kind: 'reader', sourceId: snapshot.context.citation.source_id, snapshotId: snapshot.context.citation.snapshot_id, at: snapshot.context.citation.start.passage_id, citationId: snapshot.context.citation.id } : { kind: 'page', pageId: snapshot.item.source.page.id, blockId: snapshot.item.source.block.id }, beside);
          }} onUndo={() => void undoGrade()} undoDisabled={undoDisabled()} onEnd={anchor => { setCommandError(''); setClosing(anchor); }} />
          <Show when={snapshot.context}>{context => <ReviewSourcePassage context={context()} revealed={answerRevealed()} />}</Show>
        </div>
        <Show when={snapshot.item.last_review}><ReviewHistory cardId={snapshot.item.card.id} kind={snapshot.item.card.kind} template={!!snapshot.item.card.template} notebook={props.notebook} /></Show>
      </>}</Show>
    </div>
    <Show when={(openSession() && !leaving()) || ((done() || leaving() || !!outgoing()) && latestGrade())}><footer class="review-session-actions">
      <Show when={openSession() || latestGrade()}><Button disabled={!latestGrade()} aria-disabled={dis(undoDisabled())} aria-keyshortcuts="Meta+Z Control+Z" onClick={() => void undoGrade()}>Undo last grade</Button></Show>
      <Show when={openSession() && !leaving()}>
        <Button class="review-end" aria-disabled={dis(locked() || loading() || !!readError())} aria-haspopup="dialog" onClick={event => { setCommandError(''); setClosing(event.currentTarget); }}>End review</Button>
      </Show>
    </footer></Show>
    <Show keyed when={sessionActions()}>{anchor => <Menu anchor={anchor} label="Session actions" title="Session actions" onDismiss={() => setSessionActions(null)} items={[
      { label: 'Undo last grade', disabledReason: undoDisabled() ? latestGrade() ? 'Wait for the review to finish loading or saving.' : 'Grade a card first.' : undefined, action: () => void undoGrade() },
      { label: 'End review', disabledReason: locked() || loading() || !!readError() ? 'Wait for the review to finish loading or saving.' : undefined, action: () => { setCommandError(''); setClosing(anchor); } },
    ]} />}</Show>
    <Show keyed when={composer()}>{anchor => <CardComposer anchor={anchor} where={`${shortDay(props.notebook.todayDate())} · end of journal`} bounds={paneBounds} onSave={createCard} onDismiss={() => setComposer(null)} />}</Show>
    <Show keyed when={picker()}>{anchor => <Picker<ReviewSession> anchor={anchor} label="Open reviews" query={search()} onQuery={setSearch} placeholder="Find a review" items={sessionChoices()} key={value => value.id} onDismiss={() => setPicker(null)} onPick={value => { setPicker(null); requestMove({ deckId: value.deck_id, sessionId: value.id }, anchor); }} row={value => <><Icon name={value.id === sessionId() ? 'check' : 'page'} /><span class="picker-text">{sessionLabel(value)}</span></>} empty="No open reviews." />}</Show>
    <Show keyed when={selectedDeck() && actions()}>{anchor => <Menu anchor={anchor} label="Deck actions" onDismiss={() => setActions(null)} items={[
      { label: 'Edit deck', disabledReason: openSession() ? 'End the open review first.' : undefined, action: () => { const deck = selectedDeck(); if (deck) setEditor({ anchor, deck }); } },
      { label: 'Delete deck', danger: true, disabledReason: openSession() ? 'End the open review first.' : undefined, action: () => { const deck = selectedDeck(); if (deck) setDeletion({ anchor, deck }); } },
    ]} />}</Show>
    <Show keyed when={editor()}>{state => <DeckEditor anchor={state.anchor} notebook={props.notebook} deck={state.deck} query={query()} bounds={paneBounds} onDismiss={() => setEditor(null)} onSaved={id => { setEditor(null); moveTo({ deckId: id, sessionId: null }); }} />}</Show>
    <Show keyed when={closing()}>{anchor => <Popup anchor={anchor} placement={coverLayout.matches ? 'sheet' : 'anchor'} bounds={paneBounds} label="End review" class="review-confirm" returnFocus={reviewCard} onDismiss={() => { if (!pending()) setClosing(null); }}>
      <p>End this review? Graded cards keep their grades.</p>
      <Show when={commandError()}><p class="error" role="alert">{commandError()}</p></Show>
      <div class="popup-actions"><Button disabled={locked()} onClick={() => setClosing(null)}>Keep going</Button><Button class="bordered" disabled={locked()} onClick={() => void closeSession('finished')}>End review</Button></div>
    </Popup>}</Show>
    <Show keyed when={deletion()}>{state => <Popup anchor={state.anchor} placement={coverLayout.matches ? 'sheet' : 'anchor'} bounds={paneBounds} label="Delete deck" class="review-confirm" onDismiss={() => { if (!pending()) setDeletion(null); }}>
      <p>Delete “{state.deck.name}”? Source cards, schedules and review history stay.</p>
      <Show when={commandError()}><p class="error" role="alert">{commandError()}</p></Show>
      <div class="popup-actions"><Button disabled={locked()} onClick={() => setDeletion(null)}>Cancel</Button><Button class="bordered danger" disabled={locked()} onClick={() => void deleteDeck(state.deck)}>Delete deck</Button></div>
    </Popup>}</Show>
    <Show keyed when={switching()}>{state => <Popup anchor={state.anchor} placement={coverLayout.matches ? 'sheet' : 'anchor'} bounds={paneBounds} label="End review" class="review-confirm" returnFocus={reviewCard} onDismiss={() => { if (!pending()) setSwitching(null); }}>
      <p>End this review? Graded cards keep their grades.</p>
      <Show when={commandError()}><p class="error" role="alert">{commandError()}</p></Show>
      <div class="popup-actions"><Button disabled={locked()} onClick={() => setSwitching(null)}>Keep going</Button><Button class="bordered" disabled={locked()} onClick={() => void closeSession('finished', state.target)}>End review</Button></div>
    </Popup>}</Show>
  </div>;
}

function ReviewQueueRow(props: { row: CardRow; notebook: NotebookClient; onOpen: ReviewPaneProps['onOpen'] }) {
  const [siblings] = createResource(() => props.row.card.kind === 'occlusion' ? props.row : false, row => props.notebook.api.sourceCards(row.card.source_block_id).then(cards => cards.filter(card => card.active)));
  const kind = createMemo(() => cardKindLabel(props.row.card, siblings() ?? parseCardText(props.row.source.block.text).cards));
  const front = createMemo(() => {
    const card = props.row.card;
    const text = card.kind === 'occlusion' ? occlusionSides(card)?.front.hint ?? `Mask ${groupLetter(card.occlusion_index ?? 0)}` : card.front;
    return text.split('\n', 1)[0] ?? '';
  });
  const due = createMemo(() => props.row.card.schedule.last_reviewed_at === null ? null : relativeDate(civilDate(props.row.card.schedule.due_at, props.notebook.settings()?.time_zone), props.notebook.todayDate()));
  return <Button class="review-queue-row" onClick={event => props.onOpen({ kind: 'page', pageId: props.row.source.page.id, blockId: props.row.source.block.id }, opensBeside(event))}>
    <span class="review-queue-text"><span class="review-queue-front"><Show when={props.row.card.kind === 'occlusion'} fallback={<CardFront plain={!!props.row.card.template} kind={props.row.card.kind} front={front()} back={props.row.card.back} notebook={props.notebook} />}>{front()}</Show></span><span class="review-queue-meta"><span class="review-queue-kind">{kind()}</span><span class="review-queue-source">{plainText(props.row.source.page.text, id => props.notebook.lookup(id))}</span></span></span>
    <span class="review-queue-due" classList={{ overdue: due() !== null && props.row.card.schedule.due_at < Date.now() }}>{due() ?? 'new'}</span>
  </Button>;
}

function nextCardTime(due: number, today: string, timeZone?: string): string {
  const date = civilDate(due, timeZone);
  const time = new Intl.DateTimeFormat('en', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(due);
  return `${relativeDate(date, today)} · ${time}`;
}

function reviewDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60 ? `${seconds} sec` : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} sec` : ''}`;
}

function GradeStrip(props: { grades: ReviewEvent[]; remaining?: number }) {
  const segments = createMemo<(Grade | 'current' | 'waiting')[]>(() => [...props.grades.map(event => event.grade!), ...Array.from({ length: props.remaining ?? 0 }, (_, index) => index === 0 ? 'current' as const : 'waiting' as const)]);
  return <div class="review-grade-strip" role="img" aria-label={`${props.grades.length} reviewed${props.remaining ? `, ${props.remaining} remaining` : ''}`}><For each={segments()}>{grade => <i class={`review-grade-segment review-grade-${grade}`} title={grade === 'current' ? 'Current card' : grade === 'waiting' ? 'Waiting' : gradeLabels[grade]} />}</For></div>;
}

function ReviewForecast(props: { stats: ReviewStats; today: string }) {
  const maximum = createMemo(() => Math.max(1, ...props.stats.forecast.map(day => day.count)));
  const [selectedDate, setSelectedDate] = createSignal<string | null>(null);
  const selected = createMemo(() => props.stats.forecast.find(day => day.date === selectedDate()) ?? props.stats.forecast[0]);
  return <section class="review-forecast" aria-label="Next two weeks due forecast">
    <header><h2>Next two weeks</h2><span>{props.stats.forecast.reduce((sum, day) => sum + day.count, 0)} due</span></header>
    <div class="review-forecast-bars"><For each={props.stats.forecast}>{(day, index) => {
      const weekday = new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
      const label = `${relativeDate(day.date, props.today)} · ${day.count} due`;
      return <button type="button" class="review-forecast-day" classList={{ 'review-forecast-selected': selected()?.date === day.date, 'review-forecast-empty': day.count === 0, 'review-forecast-week-start': index() === 7 }} aria-label={label} aria-pressed={selected()?.date === day.date} title={label} onFocus={() => setSelectedDate(day.date)} onClick={() => setSelectedDate(day.date)}>
        <span class="review-forecast-track"><i style={{ height: `${day.count / maximum() * 100}%` }} /></span><span>{index() === 0 ? Number(day.date.slice(-2)) : weekday.slice(0, 2)}</span>
      </button>;
    }}</For></div>
    <p class="review-forecast-caption" role="status" aria-live="polite"><Show when={selected()}>{day => <><time dateTime={day().date}>{relativeDate(day().date, props.today)}</time> · {day().count} due</>}</Show></p>
  </section>;
}

function ReviewMissedCard(props: { event: ReviewEvent; notebook: NotebookClient }) {
  const [kind, setKind] = createSignal<CardKind>();
  const [template, setTemplate] = createSignal(false);
  const [error, setError] = createSignal('');
  createEffect(() => {
    let cancelled = false;
    void props.notebook.api.card(props.event.card_id).then(card => {
      if (!cancelled) { setKind(card.kind); setTemplate(card.key.startsWith('tpl:')); setError(''); }
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    onCleanup(() => { cancelled = true; });
  });
  return <div class="review-missed-card"><Show when={kind()}>{value => <div class="review-missed-answer"><Show when={value() === 'occlusion'}><CardFront kind={value()} front={props.event.shown_front} back={props.event.shown_back} revealed notebook={props.notebook} /></Show><CardBack plain={template()} kind={value()} front={props.event.shown_front} back={props.event.shown_back} notebook={props.notebook} /></div>}</Show><Show when={error()}><p class="error" role="alert">{error()}</p></Show></div>;
}

function ReviewHistory(props: { cardId: string; kind: CardKind; template: boolean; notebook: NotebookClient }) {
  const [open, setOpen] = createSignal(false);
  const [events, setEvents] = createSignal<ReviewEvent[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [retry, setRetry] = createSignal(0);
  createEffect(() => {
    if (!open()) return;
    props.notebook.changeSequence(); retry();
    let cancelled = false;
    setLoading(true);
    void props.notebook.api.cardReviews(props.cardId).then(value => {
      if (!cancelled) { setEvents(value); setError(''); setLoading(false); }
    }).catch(reason => {
      if (!cancelled) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    onCleanup(() => { cancelled = true; });
  });
  return <details class="review-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Review history</summary>
    <Show when={open()}>
      <Show when={loading() && !events().length}><p role="status">Loading history…</p></Show>
      <Show when={error()}><p class="error" role="alert">{error()} <Button onClick={() => setRetry(value => value + 1)}>Retry</Button></p></Show>
      <Show when={!loading() && !error() && !events().length}><p>No review events.</p></Show>
      <ul><For each={[...events()].reverse()}>{event => {
        const [expanded, setExpanded] = createSignal(false);
        const date = new Date(event.created_at);
        return <li>
          <Button class="review-history-event" aria-expanded={expanded()} onClick={() => setExpanded(value => !value)}><time dateTime={date.toISOString()}>{localDate(date)} {date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time> · {event.kind === 'reset' ? 'Reset' : gradeLabels[event.grade!]}<Show when={event.undone_by}> · Undone</Show> · {event.before.interval_days ? formatInterval(event.before.interval_days) : 'new'} → {formatInterval(event.after.interval_days)}</Button>
          <Show when={expanded()}><div class="review-history-text"><CardFront plain={props.template} kind={props.kind} front={event.shown_front} back={event.shown_back} notebook={props.notebook} /></div><div class="review-history-text"><CardBack plain={props.template} kind={props.kind} front={event.shown_front} back={event.shown_back} notebook={props.notebook} /></div></Show>
        </li>;
      }}</For></ul>
    </Show>
  </details>;
}
