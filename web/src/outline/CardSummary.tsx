import { opensBeside, besideHint } from '../shell/beside';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { ulid } from 'ulid';
import type { CardUnit } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { ParsedCard } from '../review/card-text';
import { cardKindLabel, clozeSegments, occlusionSubject } from '../review/card-text';
import { CardBack, ClozeText } from '../review/CardSides';
import { formatInterval } from '../review/query';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { BlockText } from './BlockText';
import { OcclusionFigure } from '../review/OcclusionFigure';

export function CardSummary(props: { blockId: string; cards: ParsedCard[]; templateCount?: number; notebook: NotebookClient; register?: (control: { open(anchor: HTMLElement): void } | undefined) => void; onOpen(target: OpenTarget, beside: boolean): void }) {
  const keys = createMemo(() => props.cards.map(card => card.key).join('\n'));
  const [stored, setStored] = createSignal<CardUnit[]>([]);
  const [storedSequence, setStoredSequence] = createSignal(-1);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [retry, setRetry] = createSignal(0);
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const [confirm, setConfirm] = createSignal<string | null>(null);
  const [resetError, setResetError] = createSignal('');
  const [holdError, setHoldError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  let disposed = false;
  onCleanup(() => { disposed = true; });
  function open(trigger: HTMLElement) { setNow(Date.now()); setAnchor(trigger); }
  onMount(() => props.register?.({ open }));
  onCleanup(() => props.register?.(undefined));

  createEffect(() => {
    const id = props.blockId;
    const cardKeys = keys();
    const sequence = props.notebook.changeSequence(); retry();
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    if (!anchor()) return;
    setError(''); setLoading(true);
    if (!cardKeys && !props.templateCount) { setStored([]); setLoading(false); return; }
    if (props.notebook.lookup(id)()?.revision === 0) return;
    void props.notebook.api.sourceCards(id, controller.signal).then(cards => {
      if (controller.signal.aborted) return;
      setStored(cards.filter(card => card.active));
      setStoredSequence(sequence);
      setNow(Date.now()); setLoading(false);
    }, reason => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
  });

  const ordered = createMemo(() => {
    const byKey = new Map(stored().map(card => [card.key, card]));
    return [...props.cards.flatMap(card => byKey.get(card.key) ?? []), ...stored().filter(card => card.key.startsWith('tpl:'))];
  });
  // Fetch only while open; never show cached counts after another committed change.
  const label = createMemo(() => {
    const count = props.cards.length + (props.templateCount ?? 0);
    const cards = storedSequence() === props.notebook.changeSequence() ? ordered() : [];
    const due = cards.filter(card => !card.held && card.schedule.due_at <= now()).length;
    const held = cards.filter(card => card.held).length;
    return `${count} ${count === 1 ? 'card' : 'cards'}${due ? ` · ${due} due` : ''}${held ? ` · ${held} not yet` : ''}`;
  });
  const confirmation = createMemo(() => stored().find(card => card.id === confirm()));
  function dismiss() { setAnchor(null); setConfirm(null); setResetError(''); setHoldError(''); }
  async function hold(cards: CardUnit[], held: boolean) {
    if (busy() || loading() || error()) return;
    setBusy(true); setHoldError('');
    let doc;
    try {
      const source = props.notebook.lookup(props.blockId)() ?? await props.notebook.api.block(props.blockId);
      doc = props.notebook.open(source.page_id);
      if (doc.status() !== 'ready') throw new Error('The page is not ready.');
      const result = doc.edit({ kind: 'cardHeld', cards, held });
      if (!result.ok) throw new Error(result.reason);
      await doc.flush();
      if (doc.saveState() === 'conflict' || doc.saveState() === 'error') throw new Error(doc.saveMessage());
    } catch (reason) {
      if (!disposed) setHoldError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      doc?.release();
      if (!disposed) setBusy(false);
    }
  }
  async function reset() {
    const card = confirmation();
    if (!card || busy() || loading() || error()) return;
    setBusy(true); setResetError('');
    try {
      await props.notebook.commit([{ op: 'reset_card', id: card.id, base_revision: card.revision, event_id: ulid(), session_id: null, reviewed_at: Date.now() }], 'Reset card');
      if (!disposed) { setConfirm(null); setRetry(value => value + 1); }
    } catch (reason) {
      if (!disposed) setResetError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  return <>
    <Show when={error() || props.cards.length || props.templateCount}><Button class="outline-planning outline-card-count" title="Show cards" aria-haspopup="dialog" aria-expanded={!!anchor()} onClick={event => {
      if (opensBeside(event)) { dismiss(); props.onOpen({ kind: 'review', blockId: props.blockId }, true); return; }
      open(event.currentTarget);
    }}>{label()}</Button></Show>
    <Show when={anchor()}>{trigger => <Popup anchor={trigger()} label="Cards" class="outline-capability-popup outline-cards-popup" onDismiss={dismiss}>
      <Show when={loading() && !ordered().length}><p class="outline-capability-notice" role="status">Loading cards…</p></Show>
      <Show when={error()}><p class="error" role="alert">{error()} <Button onClick={() => setRetry(value => value + 1)}>Retry</Button></p></Show>
      <Show when={!error() && ordered().length}><div class="outline-cards-list">
        <For each={ordered()}>{card => <div class="outline-cards-row">
          <span class="outline-cards-kind">{card.template ? 'Template' : cardKindLabel(card, ordered())}</span>
          <div class="outline-cards-content">
            <CardPreview card={card} notebook={props.notebook} />
            <Show when={card.template}>{template => <p class="outline-cards-provenance">#{template().type_name} · {template().name}</p>}</Show>
          </div>
          <span class="outline-cards-state">{card.held ? card.schedule.last_reviewed_at === null ? 'Not yet' : 'Paused' : card.schedule.last_reviewed_at === null ? 'New' : card.schedule.due_at <= now() ? 'Due' : `In ${formatInterval(Math.ceil((card.schedule.due_at - now()) / 86_400_000))}`}</span>
          <div class="outline-cards-actions">
            <Button disabled={busy() || loading() || !!error()} onClick={() => void hold([card], !card.held)}>{card.held ? card.schedule.last_reviewed_at === null ? 'Start' : 'Resume' : card.schedule.last_reviewed_at === null ? 'Not yet' : 'Pause'}</Button>
            <Show when={card.schedule.last_reviewed_at !== null}><Button disabled={busy()} onClick={() => { setConfirm(card.id); setResetError(''); }}>Reset</Button></Show>
          </div>
        </div>}</For>
      </div></Show>
      <Show when={confirmation()}><div class="outline-cards-confirm">
        <p>Reset this card’s schedule? Review history stays.</p>
        <div class="outline-capability-actions">
          <Button disabled={busy()} onClick={() => { setConfirm(null); setResetError(''); }}>Cancel</Button>
          <Button class="bordered" disabled={busy() || loading() || !!error()} onClick={() => void reset()}>Reset</Button>
        </div>
        <Show when={resetError()}><p class="error" role="alert">{resetError()}</p></Show>
      </div></Show>
      <Show when={holdError()}><p class="error" role="alert">{holdError()}</p></Show>
      <div class="outline-capability-actions">
        <Show when={ordered().length >= 2 && ordered().some(card => card.held)}><Button disabled={busy() || loading() || !!error()} onClick={() => void hold(ordered().filter(card => card.held), false)}>Start all</Button></Show>
        <Button class="bordered" disabled={!ordered().some(card => !card.held)} title={`Review this block's cards · ${besideHint}`} onClick={event => { dismiss(); props.onOpen({ kind: 'review', blockId: props.blockId }, opensBeside(event)); }}>Review</Button>
      </div>
    </Popup>}</Show>
  </>;
}

/** A popup row shows at most this many answer items; the rest are counted. */
const previewItems = 5;

/** The card's sides as review shows them, in the popup's smaller type. */
function CardPreview(props: { card: CardUnit; notebook: NotebookClient }) {
  const segments = createMemo(() => {
    if (props.card.kind !== 'cloze') return null;
    const text = props.notebook.lookup(props.card.source_block_id)()?.text;
    const parts = text === undefined ? null : clozeSegments(text, props.card.key);
    return parts?.map(part => 'text' in part ? part.text : part.answer).join('') === props.card.back ? parts : null;
  });
  const hidden = () => Math.max(0, props.card.answer_blocks.length - previewItems);
  return <Show when={props.card.kind === 'occlusion'} fallback={<Show when={segments()} fallback={<>
    <div class="outline-cards-front"><BlockText text={props.card.front} notebook={props.notebook} interactive={false} /></div>
    <div class="outline-cards-answer">
      <CardBack kind={props.card.kind} back={props.card.back} blocks={props.card.answer_blocks.slice(0, previewItems)} notebook={props.notebook} />
      <Show when={hidden()}><p class="outline-cards-more">{hidden()} more</p></Show>
    </div>
  </>}>{parts => <>
    <div class="outline-cards-front"><ClozeText segments={parts()} revealed={false} notebook={props.notebook} /></div>
    <div class="outline-cards-answer"><ClozeText segments={parts()} revealed notebook={props.notebook} /></div>
  </>}</Show>}>
    <OcclusionFigure front={props.card.front} back={props.card.back} thumbnail revealed notebook={props.notebook} />
    <div class="outline-cards-answer">{occlusionSubject(props.card)}</div>
  </Show>;
}
