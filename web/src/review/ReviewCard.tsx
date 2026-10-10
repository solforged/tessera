import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from 'solid-js';
import type { CardAnswerBlock, CardKind, CardRow, Grade } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockBreadcrumb, BlockText } from '../outline/BlockText';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import { clozeSegments } from './card-text';
import type { ClozeSegment } from './card-text';
import { gradeIntervals, gradeLabels } from './query';
import './review-card.css';

export interface ReviewCardProps {
  item: CardRow;
  notebook: NotebookClient;
  previews: readonly { grade: Grade; interval_days: number }[];
  resetPreviews: readonly { grade: Grade; interval_days: number }[];
  busy?: boolean;
  onGrade(grade: Grade, reset: boolean): void | Promise<void>;
  onSource(beside: boolean): void;
  onReset(): void | Promise<void>;
}

const grades = (['again', 'hard', 'good', 'easy'] as const).map((grade, index) => ({ grade, label: gradeLabels[grade], shortcut: String(index + 1) }));
/** A word or short phrase, such as a vocabulary card, is set large; sentences keep reading size. */
const terse = (text: string) => text.length <= 40 && !text.includes('\n');

export function ReviewCard(props: ReviewCardProps) {
  const [revealedItems, setRevealedItems] = createSignal(0);
  const itemCount = () => props.item.card.kind === 'list' ? props.item.card.answer_blocks.length : 1;
  const revealed = () => revealedItems() >= itemCount();
  const [resetOnGrade, setResetOnGrade] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [resetAnchor, setResetAnchor] = createSignal<HTMLElement | null>(null);
  const answerId = createUniqueId();
  const locked = () => !!props.busy || pending();
  const changed = createMemo(() => {
    const last = props.item.last_review;
    return !!last && (last.shown_front !== props.item.card.front || last.shown_back !== props.item.card.back);
  });
  // Cloze sides are flat text; the source marks where the gaps are. Use it only
  // while it still derives exactly the shown sides.
  const gaps = createMemo(() => {
    const { card, source } = props.item;
    const segments = card.kind === 'cloze' ? clozeSegments(source.block.text, card.key) : null;
    if (!segments) return null;
    const side = (back: boolean) => segments.map(segment => 'text' in segment ? segment.text : back ? segment.answer : segment.hint ?? '[…]').join('');
    return side(false) === card.front && side(true) === card.back ? segments : null;
  });
  const intervals = createMemo(() => gradeIntervals(resetOnGrade() ? props.resetPreviews : props.previews));
  const interval = (grade: Grade) => intervals()[grade];
  let region!: HTMLDivElement;
  let generation = 0;
  let disposed = false;

  createEffect(on(() => props.item.card.id, () => {
    const focused = region?.contains(region.ownerDocument.activeElement);
    generation++;
    setRevealedItems(0);
    setResetOnGrade(false);
    setPending(false);
    setError('');
    setResetAnchor(null);
    if (focused) region.focus({ preventScroll: true });
  }));
  onCleanup(() => { disposed = true; });

  async function submit(action: () => void | Promise<void>, committed?: () => void) {
    if (locked()) return;
    const current = generation;
    setPending(true);
    setError('');
    try {
      await action();
      if (!disposed && current === generation) committed?.();
    } catch (reason) {
      if (!disposed && current === generation) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!disposed && current === generation) setPending(false);
    }
  }
  function reveal() {
    if (locked() || revealed()) return;
    const focused = region.contains(region.ownerDocument.activeElement);
    setRevealedItems(value => value + 1);
    if (focused) region.focus({ preventScroll: true });
  }
  function grade(value: Grade) {
    if (!revealed() || locked()) return;
    const reset = resetOnGrade();
    void submit(() => props.onGrade(value, reset));
  }
  function cancelReset() {
    const anchor = resetAnchor();
    setResetAnchor(null);
    anchor?.focus({ preventScroll: true });
  }
  function resetProgress() {
    if (!revealed() || !resetAnchor() || locked()) return;
    void submit(() => props.onReset(), () => {
      setResetOnGrade(false);
      setResetAnchor(null);
      region.focus({ preventScroll: true });
    });
  }
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || locked() || resetAnchor()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') || target instanceof HTMLElement && target.isContentEditable) return;
    if (event.key === ' ' && !revealed()) {
      // Space on a control belongs to that control's native activation.
      if (target?.closest('button, a, summary, [role="button"]')) return;
      event.preventDefault(); event.stopPropagation(); reveal();
      return;
    }
    if (!revealed()) return;
    const choice = grades.find(value => value.shortcut === event.key);
    if (choice) { event.preventDefault(); event.stopPropagation(); grade(choice.grade); }
  }
  onMount(() => {
    region.addEventListener('keydown', keydown);
    onCleanup(() => region.removeEventListener('keydown', keydown));
  });

  return <div ref={region} class="review-card" role="region" aria-label="Review card" aria-busy={locked()} tabIndex={0}>
    <div class="review-card-meta">
      <Button class="review-card-source" title="Open source · Shift opens beside" disabled={locked()} onClick={event => props.onSource(event.shiftKey)}>
        <Icon name={props.notebook.lookup(props.item.source.block.page_id)()?.kind === 'journal' ? 'calendar' : 'page'} /><span><BlockBreadcrumb block={props.item.source.block} notebook={props.notebook} /></span>
      </Button>
      <Show when={props.item.card.kind !== 'forward'}><span class="review-card-kind">{props.item.card.kind === 'reverse' ? 'Reverse' : props.item.card.kind === 'multiline' ? 'Multi-line' : props.item.card.kind === 'list' ? 'List' : `Cloze ${props.item.card.key.slice('cloze:c'.length)}`}</span></Show>
      <Show when={revealed() && props.item.card.schedule.last_reviewed_at !== null}>
        <Button class="review-card-reset-trigger" disabled={locked()} aria-haspopup="dialog" aria-expanded={!!resetAnchor()} onClick={event => setResetAnchor(event.currentTarget)}>Reset progress</Button>
      </Show>
    </div>
    <Show when={changed()}><p class="review-card-change-notice">Wording changed since your last review.</p></Show>
    <Show when={gaps()} fallback={<>
      <section class="review-card-side" classList={{ 'review-card-terse': terse(props.item.card.front) }} aria-label="Front"><BlockText text={props.item.card.front} notebook={props.notebook} interactive={false} /></section>
      <Show when={revealedItems() > 0}>
        <section id={answerId} class="review-card-side review-card-answer" classList={{ 'review-card-terse': !props.item.card.answer_blocks.length && terse(props.item.card.back) }} aria-label="Answer"><CardBack kind={props.item.card.kind} back={props.item.card.back} blocks={props.item.card.answer_blocks} visibleItems={revealedItems()} notebook={props.notebook} /></section>
      </Show>
    </>}>{segments => <section id={revealed() ? answerId : undefined} class="review-card-side" aria-label={revealed() ? 'Answer' : 'Front'}>
      <ClozeText segments={segments()} revealed={revealed()} notebook={props.notebook} />
    </section>}</Show>
    <Show when={props.item.card.kind === 'list' && revealedItems() > 0}><p class="review-card-kind" role="status">{revealedItems()} of {itemCount()}</p></Show>
    <Show when={revealed()} fallback={<div class="review-card-actions">
      <Button class="bordered" label={revealedItems() ? 'Reveal next item' : 'Reveal answer'} shortcut="Space" aria-keyshortcuts="Space" aria-expanded={revealedItems() > 0} aria-controls={answerId} disabled={locked()} onClick={reveal}>{revealedItems() ? 'Reveal next item' : 'Reveal answer'} <kbd>Space</kbd></Button>
    </div>}>
      <Show when={changed() && props.item.last_review}>{last => <section class="review-card-comparison" aria-label="Changed card text">
        <div class="review-card-comparison-versions">
          <div class="review-card-comparison-version">
            <h2>Last reviewed</h2>
            <dl>
              <dt>Front</dt><dd class="review-card-text"><BlockText text={last().shown_front} notebook={props.notebook} interactive={false} /></dd>
              <dt>Answer</dt><dd class="review-card-text"><CardBack kind={props.item.card.kind} back={last().shown_back} notebook={props.notebook} /></dd>
            </dl>
          </div>
          <div class="review-card-comparison-version">
            <h2>Current</h2>
            <dl>
              <dt>Front</dt><dd class="review-card-text"><BlockText text={props.item.card.front} notebook={props.notebook} interactive={false} /></dd>
              <dt>Answer</dt><dd class="review-card-text"><CardBack kind={props.item.card.kind} back={props.item.card.back} blocks={props.item.card.answer_blocks} notebook={props.notebook} /></dd>
            </dl>
          </div>
        </div>
        <div class="review-card-progress" role="group" aria-label="Review progress">
          <Button aria-pressed={!resetOnGrade()} disabled={locked()} onClick={() => setResetOnGrade(false)}>Keep progress</Button>
          <Button aria-pressed={resetOnGrade()} disabled={locked()} onClick={() => setResetOnGrade(true)}>Start over</Button>
        </div>
      </section>}</Show>
      <div class="review-card-grades" role="group" aria-label="Grade answer">
        <For each={grades}>{choice => <Button class="review-card-grade" label={choice.label} shortcut={choice.shortcut} aria-keyshortcuts={choice.shortcut} aria-label={`${choice.label}${interval(choice.grade) ? ` · ${interval(choice.grade)}` : ''}`} disabled={locked()} onClick={() => grade(choice.grade)}>
          <span class="review-card-grade-label">{choice.label} <kbd>{choice.shortcut}</kbd></span>
          <Show when={interval(choice.grade)}>{value => <span class="review-card-interval">{value()}</span>}</Show>
        </Button>}</For>
      </div>
    </Show>
    <Show when={error() && !resetAnchor()}><p class="error review-card-error" role="alert">{error()}</p></Show>
    <Show when={resetAnchor()}>{anchor => <Popup anchor={anchor()} label="Reset progress" class="review-card-reset" onDismiss={() => setResetAnchor(null)}>
      <p>Reset this card’s schedule? Review history stays.</p>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions">
        <Button disabled={locked()} onClick={cancelReset}>Cancel</Button>
        <Button class="bordered" disabled={locked()} onClick={resetProgress}>Reset</Button>
      </div>
    </Popup>}</Show>
  </div>;
}

/** Canonical child snapshots also render in history and stale-definition views. */
export function CardBack(props: { kind: CardKind; back: string; blocks?: CardAnswerBlock[]; visibleItems?: number; notebook: NotebookClient }) {
  const blocks = createMemo(() => {
    if (props.kind !== 'multiline' && props.kind !== 'list') return null;
    const answer: CardAnswerBlock[] = props.blocks ?? JSON.parse(props.back);
    return props.kind === 'list' && props.visibleItems !== undefined ? answer.slice(0, props.visibleItems) : answer;
  });
  return <Show when={blocks()} fallback={<BlockText text={props.back} notebook={props.notebook} interactive={false} />}>{answer => <AnswerOutline blocks={answer()} notebook={props.notebook} />}</Show>;
}

function AnswerOutline(props: { blocks: CardAnswerBlock[]; notebook: NotebookClient }) {
  return <ul class="review-answer-outline"><For each={props.blocks}>{block => <li>
    <BlockText text={block.text} cards notebook={props.notebook} interactive={false} />
    <Show when={block.children.length}><AnswerOutline blocks={block.children} notebook={props.notebook} /></Show>
  </li>}</For></ul>;
}

function ClozeText(props: { segments: ClozeSegment[]; revealed: boolean; notebook: NotebookClient }) {
  return <For each={props.segments}>{segment => 'text' in segment
    ? <BlockText text={segment.text} notebook={props.notebook} interactive={false} />
    : <Show when={props.revealed} fallback={<span class="review-cloze-gap"><span class="visually-hidden">{segment.hint ? 'Blank, hint: ' : 'Blank'}</span>{segment.hint ? <BlockText text={segment.hint} notebook={props.notebook} interactive={false} /> : '…'}</span>}>
      <mark class="review-cloze-answer"><BlockText text={segment.answer} notebook={props.notebook} interactive={false} /></mark>
    </Show>}</For>;
}
