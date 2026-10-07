import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { ulid } from 'ulid';
import type { CardPreviews, CardQuery, CardRow, CardSelection, Deck, Grade, ReviewEvent, ReviewSession } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget, PaneId, ReviewViewState } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { DeckEditor } from './DeckEditor';
import { ReviewCard } from './ReviewCard';
import { copyCardQuery, formatInterval, gradeLabels, gradeOperation, openReviewSession, reviewedInSession, sameCardSnapshot, selectionLabels } from './query';
import './review.css';

export interface ReviewPaneProps {
  pane: PaneId;
  view: ReviewViewState;
  notebook: NotebookClient;
  active: boolean;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: ReviewViewState): void;
}

type Presentation = { item: CardRow; previews: CardPreviews };
type Destination = { deckId: string | null; sessionId: string | null; selection?: CardSelection | null };
type DeckChoice = { id: string | null; name: string };

const selections = Object.keys(selectionLabels) as CardSelection[];

export function ReviewPane(props: ReviewPaneProps) {
  const [deckId, setDeckId] = createSignal(props.view.deckId);
  const [sessionId, setSessionId] = createSignal(props.view.sessionId);
  const [decks, setDecks] = createSignal<Deck[]>([]);
  const [sessions, setSessions] = createSignal<ReviewSession[]>([]);
  const [session, setSession] = createSignal<ReviewSession | null>(null);
  const [selection, setSelection] = createSignal<CardSelection | null>(props.view.selection ?? null);
  const [query, setQuery] = createSignal<CardQuery>({ source: null, selection: 'due', limit: null });
  const [rows, setRows] = createSignal<CardRow[]>([]);
  const [total, setTotal] = createSignal(0);
  const [loadedCount, setLoadedCount] = createSignal(0);
  const [counts, setCounts] = createSignal<Partial<Record<CardSelection, number>>>({});
  const [ready, setReady] = createSignal(false);
  const [shown, setShown] = createSignal<Presentation | null>(null);
  const [updated, setUpdated] = createSignal<Presentation | null>(null);
  const [stale, setStale] = createSignal('');
  const [needsReload, setNeedsReload] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [readError, setReadError] = createSignal('');
  const [commandError, setCommandError] = createSignal('');
  const [pending, setPending] = createSignal('');
  const [retry, setRetry] = createSignal(0);
  const [picker, setPicker] = createSignal<{ kind: 'decks' | 'sessions'; anchor: HTMLElement } | null>(null);
  const [search, setSearch] = createSignal('');
  const [actions, setActions] = createSignal<HTMLElement | null>(null);
  const [editor, setEditor] = createSignal<{ anchor: HTMLElement; deck: Deck | null } | null>(null);
  const [deletion, setDeletion] = createSignal<{ anchor: HTMLElement; deck: Deck } | null>(null);
  const [switching, setSwitching] = createSignal<{ anchor: HTMLElement; target: Destination } | null>(null);
  const selectedDeck = createMemo(() => decks().find(deck => deck.id === deckId()));
  const openSession = createMemo(() => session()?.state === 'open' && session()?.id === sessionId() ? session() : null);
  const openSessions = createMemo(() => sessions().filter(value => value.state === 'open').sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id)));
  const otherSessions = createMemo(() => openSessions().filter(value => value.id !== sessionId()));
  // Queue bookkeeping must not refresh a shown card unless command state changes.
  const commandState = createMemo(() => props.notebook.commandState());
  const queued = createMemo(() => ['saving', 'queued', 'offline'].includes(commandState()));
  const locked = createMemo(() => !!pending() || queued());
  const deckChoices = createMemo((): DeckChoice[] => {
    const needle = search().trim().toLocaleLowerCase();
    return [{ id: null, name: 'All cards' }, ...decks()].filter(deck => deck.name.toLocaleLowerCase().includes(needle));
  });
  const sessionChoices = createMemo(() => {
    const needle = search().trim().toLocaleLowerCase();
    return otherSessions().filter(value => sessionLabel(value).toLocaleLowerCase().includes(needle));
  });
  let scroll!: HTMLDivElement;
  let deckTrigger!: HTMLButtonElement;
  let generation = 0;
  let disposed = false;
  let recover = true;
  onCleanup(() => { disposed = true; generation++; });
  onMount(() => { scroll.scrollTop = props.view.scroll; });

  function sessionLabel(value: ReviewSession) {
    const name = value.deck_id ? decks().find(deck => deck.id === value.deck_id)?.name ?? 'Deleted deck' : 'All cards';
    return `${name} · ${new Date(value.started_at).toLocaleString()}`;
  }

  function publish() {
    if (!disposed) props.onViewChange({ deckId: deckId(), sessionId: sessionId(), selection: selection(), scroll: scroll?.scrollTop ?? props.view.scroll });
  }

  function moveTo(target: Destination) {
    recover = false;
    generation++;
    batch(() => {
      setDeckId(target.deckId); setSessionId(target.sessionId); setSession(null); setSelection(target.selection ?? null);
      setShown(null); setUpdated(null); setStale(''); setNeedsReload(false); setCommandError('');
      setRows([]); setCounts({}); setReady(false); setLoading(true); setSwitching(null); setRetry(value => value + 1);
    });
    publish();
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
    requestMove({ deckId: nextDeck, sessionId: nextSession, selection: nextSelection }, deckTrigger);
  }, { defer: true }));

  createEffect(on(() => [deckId(), sessionId(), selection(), props.notebook.changeSequence(), commandState(), retry()] as const, () => { void refresh(); }));
  createEffect(on(shown, value => {
    if (!value) return;
    queueMicrotask(() => {
      if (!disposed && props.active && shown() === value) scroll.querySelector<HTMLElement>('.review-card')?.focus({ preventScroll: true });
    });
  }));

  async function presentation(item: CardRow): Promise<Presentation> {
    const previews = await props.notebook.api.cardPreviews(item.card.id);
    const current = await props.notebook.api.card(item.card.id);
    if (!sameCardSnapshot(item.card, current)) throw new Error('The card changed while loading its intervals. Refresh to review its current text.');
    return { item, previews };
  }

  async function refresh() {
    const version = ++generation;
    const requestedDeck = deckId();
    const requestedSession = sessionId();
    const requestedSelection = selection();
    setLoading(true);
    try {
      const [savedDecks, savedSessions] = await Promise.all([props.notebook.api.decks(), props.notebook.api.reviewSessions()]);
      if (disposed || version !== generation) return;
      setDecks(savedDecks); setSessions(savedSessions);
      let currentSession = requestedSession ? savedSessions.find(value => value.id === requestedSession) ?? await props.notebook.api.reviewSession(requestedSession) : null;
      if (disposed || version !== generation) return;
      if (!requestedSession && recover && !pending() && !queued()) {
        recover = false;
        currentSession = openReviewSession(savedSessions, requestedDeck) ?? null;
        if (currentSession) {
          setSessionId(currentSession.id); publish();
          return;
        }
      }
      setSession(currentSession);
      if (currentSession?.state === 'open' && currentSession.deck_id !== requestedDeck) {
        setDeckId(currentSession.deck_id); setSelection(null); publish();
        return;
      }
      const deck = savedDecks.find(value => value.id === requestedDeck);
      if (requestedDeck && !deck) throw new Error('This deck was deleted. Finish or abandon any open review, then choose another deck.');
      const nextQuery = copyCardQuery(deck?.query ?? { source: null, selection: 'due', limit: null });
      if (requestedSelection) nextQuery.selection = requestedSelection;
      const [result, ...totals] = await Promise.all([
        props.notebook.api.cardQuery({ ...nextQuery, limit: nextQuery.limit ?? 2000 }),
        ...selections.map(value => props.notebook.api.cardQuery({ ...nextQuery, selection: value, limit: 1 }).then(found => found.total)),
      ]);
      const remaining = currentSession?.state === 'open'
        ? (await Promise.all(result.rows.map(async row => {
          const reviewed = reviewedInSession(row, currentSession!);
          return (reviewed ?? reviewedInSession(row, currentSession!, await props.notebook.api.cardReviews(row.card.id))) ? null : row;
        }))).filter((row): row is CardRow => row !== null)
        : result.rows;
      if (disposed || version !== generation) return;
      setQuery(nextQuery); setRows(remaining); setTotal(result.total); setLoadedCount(result.rows.length);
      setCounts(Object.fromEntries(selections.map((value, index) => [value, totals[index]!])));
      const previous = shown();
      if (currentSession?.state !== 'open') {
        setUpdated(null);
        setStale(previous ? 'This review was closed elsewhere. Its committed grades are retained.' : '');
      } else if (previous) {
        const candidate = remaining.find(row => row.card.id === previous.item.card.id);
        if (!candidate) {
          setUpdated(null); setStale('This card is no longer in this queue, or was already graded in this review.');
        } else if (!sameCardSnapshot(previous.item.card, candidate.card) || needsReload()) {
          const next = await presentation(candidate);
          if (disposed || version !== generation) return;
          setUpdated(next);
          setStale(needsReload() ? 'Review the current card before continuing.' : 'This card changed after it was shown. Review its current text before grading.');
        } else {
          setUpdated(null); setStale('');
        }
      } else if (remaining[0] && !queued() && !pending()) {
        const next = await presentation(remaining[0]);
        if (disposed || version !== generation) return;
        setShown(next); setUpdated(null); setStale('');
      }
      setReadError(''); setReady(true);
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
    recover = false; setPending('Starting review…'); setCommandError('');
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
    const value = openSession();
    if (!value || locked()) return;
    setPending(state === 'finished' ? 'Finishing review…' : 'Abandoning review…'); setCommandError('');
    try {
      const receipt = await props.notebook.commit([{ op: 'finish_review_session', id: value.id, base_revision: value.revision, state, ended_at: Date.now() }], state === 'finished' ? 'Finish review' : 'Abandon review');
      if (disposed) return;
      recover = false;
      setSession(receipt.review_sessions?.find(item => item.id === value.id) ?? null);
      setShown(null); setUpdated(null); setStale(''); setNeedsReload(false);
      if (target) moveTo(target);
      else { setSwitching(null); publish(); }
    } catch (reason) {
      if (!disposed) setCommandError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) { setPending(''); setRetry(value => value + 1); }
    }
  }

  async function grade(value: Grade, reset: boolean, snapshot: Presentation) {
    const currentSession = openSession();
    if (locked() || loading() || readError() || stale() || needsReload() || !currentSession || shown() !== snapshot) return;
    const operation = gradeOperation(snapshot.item, currentSession.id, value, reset, ulid(), Date.now());
    setPending('Saving grade…'); setCommandError('');
    try {
      await props.notebook.commit([operation], 'Grade card');
    } catch (reason) {
      if (!disposed) {
        setNeedsReload(true);
        setPending(''); await refresh();
      }
      throw reason;
    }
    if (disposed) return;
    // The acknowledgement, not the click or a speculative query, releases the shown snapshot.
    setShown(null); setUpdated(null); setStale(''); setPending('');
    await refresh();
  }

  async function reset(snapshot: Presentation) {
    const currentSession = openSession();
    if (locked() || loading() || readError() || stale() || needsReload() || !currentSession || shown() !== snapshot) return;
    setPending('Resetting progress…'); setCommandError('');
    try {
      await props.notebook.commit([{ op: 'reset_card', id: snapshot.item.card.id, base_revision: snapshot.item.card.revision, event_id: ulid(), session_id: currentSession.id, reviewed_at: Date.now() }], 'Reset card');
    } catch (reason) {
      if (!disposed) {
        setNeedsReload(true);
        setPending(''); await refresh();
      }
      throw reason;
    }
    if (disposed) return;
    setNeedsReload(true); setPending('');
    await refresh();
    if (disposed) return;
    const next = updated();
    if (next) { setShown(next); setUpdated(null); setStale(''); setNeedsReload(false); }
  }

  function acceptUpdated() {
    if (locked() || loading() || readError()) return;
    const next = updated();
    setShown(next); setUpdated(null); setStale(''); setNeedsReload(false); setCommandError('');
    if (!next) setRetry(value => value + 1);
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

  return <div class="review-pane" data-pane={props.pane} role="region" aria-label="Review" tabIndex={0} onFocusIn={props.onActivate} onPointerDown={props.onActivate}>
    <div class="review-toolbar">
      <Button ref={deckTrigger} class="bordered" disabled={locked() || loading()} aria-haspopup="dialog" onClick={event => { setSearch(''); setPicker({ kind: 'decks', anchor: event.currentTarget }); }}>{deckId() ? selectedDeck()?.name ?? 'Unavailable deck' : 'All cards'}<Icon name="down" /></Button>
      <div role="group" aria-label="Review queue" class="review-queue-controls mode-tabs"><For each={selections}>{value => <Button aria-pressed={query().selection === value} disabled={locked() || loading()} onClick={() => {
        if (value === query().selection) return;
        setShown(null); setUpdated(null); setStale(''); setNeedsReload(false); setSelection(value); publish();
      }}>{selectionLabels[value]}<Show when={counts()[value] !== undefined}><span class="review-count">{counts()[value]}</span></Show></Button>}</For></div>
      <Show when={otherSessions().length}><Button class="review-open-sessions" disabled={locked() || loading()} aria-haspopup="dialog" onClick={event => { setSearch(''); setPicker({ kind: 'sessions', anchor: event.currentTarget }); }}>Open reviews<span class="review-count">{otherSessions().length}</span></Button></Show>
      <Button class="review-deck-actions" icon="more" label="Deck actions" aria-haspopup="menu" disabled={locked() || loading()} onClick={event => setActions(event.currentTarget)} />
    </div>
    <Show when={queued() && !pending()}><div class="review-notice" role="status">
      {commandState() === 'offline' ? 'Offline · Review changes are kept for retry.' : 'Saving review changes…'}
      <Show when={commandState() === 'offline'}><Button onClick={() => props.notebook.retry()}>Retry delivery</Button></Show>
    </div></Show>
    <Show when={commandError()}><div class="pane-error" role="alert">{commandError()}</div></Show>
    <Show when={readError()}><div class="pane-error" role="alert">{readError()} <Button disabled={locked()} onClick={() => setRetry(value => value + 1)}>Refresh</Button></div></Show>
    <div ref={scroll} class="review-scroll" onScroll={publish}>
      <div class="review-summary">
        <Show when={!openSession() && rows().length}><Button class="bordered" disabled={locked() || loading() || !!readError()} onClick={() => void start()}>Start review</Button></Show>
        <Show when={!shown() || !openSession() || !ready() || !rows().length}><span role="status">{!ready() ? 'Loading cards…'
          : rows().length ? `${rows().length} ${openSession() ? 'left' : rows().length === 1 ? 'card' : 'cards'}`
          : openSession() ? 'Queue complete.' : !deckId() && counts().all === 0 ? 'No cards yet. Type >> in any block to make one, or <> for both directions.'
            : query().selection === 'due' ? 'Nothing due.' : 'No cards in this queue.'}</span></Show>
        <Show when={openSession() && ready() && !rows().length && !shown()}><Button class="bordered" disabled={locked()} onClick={() => void closeSession('finished')}>Finish review</Button></Show>
        <Show when={pending()}><span class="review-pending" role="status">{pending()}</span></Show>
        <Show when={session() && session()!.state !== 'open'}><p role="status">{session()!.state === 'finished' ? 'Review finished.' : 'Review abandoned.'} Its grades are kept.</p></Show>
        <Show when={total() > loadedCount()}><p>Showing {loadedCount()} of {total()} matching cards. Narrow the deck’s source filters to review the rest.</p></Show>
      </div>
      <Show when={stale()}><section class="review-stale" aria-label="Card changed">
        <p role="alert">{stale()}</p>
        <Show when={updated() && shown() && (updated()!.item.card.front !== shown()!.item.card.front || updated()!.item.card.back !== shown()!.item.card.back)}>
          <div class="review-stale-versions">
            <section><h2>Shown text</h2><div><BlockText text={shown()!.item.card.front} notebook={props.notebook} interactive={false} /></div><div><BlockText text={shown()!.item.card.back} notebook={props.notebook} interactive={false} /></div></section>
            <section><h2>Current text</h2><div><BlockText text={updated()!.item.card.front} notebook={props.notebook} interactive={false} /></div><div><BlockText text={updated()!.item.card.back} notebook={props.notebook} interactive={false} /></div></section>
          </div>
        </Show>
        <Button class="bordered" disabled={locked() || loading() || !!readError()} onClick={acceptUpdated}>{updated() ? 'Review current card' : 'Next card'}</Button>
      </section></Show>
      <Show keyed when={shown()}>{snapshot => <>
        <ReviewCard item={snapshot.item} notebook={props.notebook} remaining={openSession() && ready() && rows().length ? rows().length : undefined} previews={snapshot.previews.current} resetPreviews={snapshot.previews.reset} busy={locked() || loading() || !!readError() || !!stale() || needsReload() || !openSession()} onGrade={(value, restart) => grade(value, restart, snapshot)} onReset={() => reset(snapshot)} onSource={beside => {
          publish(); props.onOpen({ kind: 'page', pageId: snapshot.item.source.page.id, blockId: snapshot.item.source.block.id }, beside);
        }} />
        <Show when={snapshot.item.last_review}><ReviewHistory cardId={snapshot.item.card.id} notebook={props.notebook} /></Show>
      </>}</Show>
    </div>
    <Show when={openSession() && (rows().length || shown())}><footer class="review-session-actions">
      <Button class="bordered" disabled={locked()} onClick={() => void closeSession('finished')}>Finish review</Button>
      <Button disabled={locked()} onClick={() => void closeSession('abandoned')}>Abandon review</Button>
    </footer></Show>
    <Show keyed when={picker()}>{state => state.kind === 'decks'
      ? <Picker<DeckChoice> anchor={state.anchor} label="Deck" query={search()} onQuery={setSearch} placeholder="Find a deck" items={deckChoices()} key={value => value.id ?? 'all'} onDismiss={() => setPicker(null)} onPick={value => { setPicker(null); if (value.id !== deckId()) requestMove({ deckId: value.id, sessionId: null }, state.anchor); }} row={value => <><Icon name={value.id === deckId() ? 'check' : 'table'} /><span class="picker-text">{value.name}</span></>} empty="No matching decks." />
      : <Picker<ReviewSession> anchor={state.anchor} label="Open reviews" query={search()} onQuery={setSearch} placeholder="Find a review" items={sessionChoices()} key={value => value.id} onDismiss={() => setPicker(null)} onPick={value => { setPicker(null); requestMove({ deckId: value.deck_id, sessionId: value.id }, state.anchor); }} row={value => <><Icon name={value.id === sessionId() ? 'check' : 'page'} /><span class="picker-text">{sessionLabel(value)}</span></>} empty="No open reviews." />}</Show>
    <Show keyed when={actions()}>{anchor => <Menu anchor={anchor} label="Deck actions" onDismiss={() => setActions(null)} items={[
      { label: 'New deck', disabledReason: openSession() ? 'Finish or abandon the open review first.' : undefined, action: () => setEditor({ anchor, deck: null }) },
      { label: 'Edit deck', disabledReason: openSession() ? 'Finish or abandon the open review first.' : !selectedDeck() ? 'Choose a saved deck first.' : undefined, action: () => { const deck = selectedDeck(); if (deck) setEditor({ anchor, deck }); } },
      { label: 'Delete deck', danger: true, disabledReason: openSession() ? 'Finish or abandon the open review first.' : !selectedDeck() ? 'Choose a saved deck first.' : undefined, action: () => { const deck = selectedDeck(); if (deck) setDeletion({ anchor, deck }); } },
    ]} />}</Show>
    <Show keyed when={editor()}>{state => <DeckEditor anchor={state.anchor} notebook={props.notebook} deck={state.deck} query={query()} onDismiss={() => setEditor(null)} onSaved={id => { setEditor(null); moveTo({ deckId: id, sessionId: null }); }} />}</Show>
    <Show keyed when={deletion()}>{state => <Popup anchor={state.anchor} label="Delete deck" class="review-confirm" onDismiss={() => { if (!pending()) setDeletion(null); }}>
      <p>Delete “{state.deck.name}”? Source cards, schedules and review history stay.</p>
      <Show when={commandError()}><p class="error" role="alert">{commandError()}</p></Show>
      <div class="popup-actions"><Button disabled={locked()} onClick={() => setDeletion(null)}>Cancel</Button><Button class="bordered danger" disabled={locked()} onClick={() => void deleteDeck(state.deck)}>Delete deck</Button></div>
    </Popup>}</Show>
    <Show keyed when={switching()}>{state => <Popup anchor={state.anchor} label="Close open review" class="review-confirm" onDismiss={() => { if (!pending()) setSwitching(null); }}>
      <p>Finish or abandon this review before switching. Committed grades stay.</p>
      <Show when={commandError()}><p class="error" role="alert">{commandError()}</p></Show>
      <div class="popup-actions"><Button disabled={locked()} onClick={() => setSwitching(null)}>Cancel</Button><Button disabled={locked()} onClick={() => void closeSession('abandoned', state.target)}>Abandon review</Button><Button class="bordered" disabled={locked()} onClick={() => void closeSession('finished', state.target)}>Finish review</Button></div>
    </Popup>}</Show>
  </div>;
}

function ReviewHistory(props: { cardId: string; notebook: NotebookClient }) {
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
      <ul><For each={[...events()].reverse()}>{event => <li>
        <div><time dateTime={new Date(event.created_at).toISOString()}>{new Date(event.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time> · {event.kind === 'reset' ? 'Reset' : gradeLabels[event.grade!]} · {event.before.interval_days ? formatInterval(event.before.interval_days) : 'New'} → {formatInterval(event.after.interval_days)}</div>
        <details><summary>Shown text</summary><div class="review-history-text"><BlockText text={event.shown_front} notebook={props.notebook} interactive={false} /></div><div class="review-history-text"><BlockText text={event.shown_back} notebook={props.notebook} interactive={false} /></div></details>
      </li>}</For></ul>
    </Show>
  </details>;
}
