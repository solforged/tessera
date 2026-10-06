import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { ulid } from 'ulid';
import type { CardUnit } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { ParsedCard } from '../review/card-text';
import { formatInterval } from '../review/query';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { BlockText } from './BlockText';

export function CardSummary(props: { blockId: string; cards: ParsedCard[]; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void }) {
  const keys = createMemo(() => props.cards.map(card => card.key).join('\n'));
  const [stored, setStored] = createSignal<CardUnit[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [retry, setRetry] = createSignal(0);
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const [confirm, setConfirm] = createSignal<string | null>(null);
  const [resetError, setResetError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  let disposed = false;
  onCleanup(() => { disposed = true; });

  createEffect(() => {
    const id = props.blockId;
    const cardKeys = keys();
    props.notebook.changeSequence(); retry();
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    setError(''); setLoading(!!cardKeys);
    if (!cardKeys) { setStored([]); return; }
    void props.notebook.api.sourceCards(id, controller.signal).then(cards => {
      if (controller.signal.aborted) return;
      setStored(cards.filter(card => card.active));
      setNow(Date.now()); setLoading(false);
    }, reason => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
  });

  const ordered = createMemo(() => {
    const byKey = new Map(stored().map(card => [card.key, card]));
    return props.cards.flatMap(card => byKey.get(card.key) ?? []);
  });
  const label = createMemo(() => {
    const count = props.cards.length;
    const due = loading() || error() ? 0 : stored().filter(card => card.schedule.due_at <= now()).length;
    return `${count} ${count === 1 ? 'card' : 'cards'}${due ? ` · ${due} due` : ''}`;
  });
  const confirmation = createMemo(() => stored().find(card => card.id === confirm()));
  function dismiss() { setAnchor(null); setConfirm(null); setResetError(''); }
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
    <Button class="outline-planning" title="Show cards" aria-haspopup="dialog" aria-expanded={!!anchor()} onClick={event => {
      if (event.shiftKey) { dismiss(); props.onOpen({ kind: 'review' }, true); return; }
      setNow(Date.now()); setAnchor(event.currentTarget);
    }}>{label()}</Button>
    <Show when={anchor()}>{trigger => <Popup anchor={trigger()} label="Cards" class="outline-capability-popup outline-cards-popup" onDismiss={dismiss}>
      <Show when={loading()}><p class="outline-capability-notice" role="status">Loading cards…</p></Show>
      <Show when={error()}><p class="error" role="alert">{error()} <Button onClick={() => setRetry(value => value + 1)}>Retry</Button></p></Show>
      <Show when={!loading() && !error()}><div class="outline-cards-list">
        <For each={ordered()}>{card => <div class="outline-cards-row">
          <span class="outline-cards-kind">{card.kind === 'cloze' ? `Cloze ${card.key.slice('cloze:c'.length)}` : card.kind === 'forward' ? 'Forward' : 'Reverse'}</span>
          <span class="outline-cards-front"><BlockText text={card.front} notebook={props.notebook} interactive={false} /></span>
          <span class="outline-cards-state">{card.schedule.last_reviewed_at === null ? 'New' : card.schedule.due_at <= now() ? 'Due' : `In ${formatInterval(Math.ceil((card.schedule.due_at - now()) / 86_400_000))}`}</span>
          <Show when={card.schedule.last_reviewed_at !== null}><Button disabled={busy()} onClick={() => { setConfirm(card.id); setResetError(''); }}>Reset</Button></Show>
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
      <div class="outline-capability-actions"><Button class="bordered" onClick={event => { dismiss(); props.onOpen({ kind: 'review' }, event.shiftKey); }}>Review</Button></div>
    </Popup>}</Show>
  </>;
}
