import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from 'solid-js';
import type { CardRow, Grade } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
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

const grades: readonly { grade: Grade; label: string; shortcut: string }[] = [
  { grade: 'again', label: 'Again', shortcut: '1' },
  { grade: 'hard', label: 'Hard', shortcut: '2' },
  { grade: 'good', label: 'Good', shortcut: '3' },
  { grade: 'easy', label: 'Easy', shortcut: '4' },
];

export function ReviewCard(props: ReviewCardProps) {
  const [revealed, setRevealed] = createSignal(false);
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
  const interval = (grade: Grade) => {
    const preview = (resetOnGrade() ? props.resetPreviews : props.previews).find(value => value.grade === grade);
    return preview ? `${preview.interval_days} ${preview.interval_days === 1 ? 'day' : 'days'}` : undefined;
  };
  let region!: HTMLDivElement;
  let generation = 0;
  let disposed = false;

  createEffect(on(() => props.item.card.id, () => {
    const focused = region?.contains(region.ownerDocument.activeElement);
    generation++;
    setRevealed(false);
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
    setRevealed(true);
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
    <div class="review-card-source">
      <Button icon="page" label="Open source" title="Open source · Shift opens beside" disabled={locked()} onClick={event => props.onSource(event.shiftKey)}>Source</Button>
      <span class="review-card-source-page"><BlockText text={props.item.source.page.text} notebook={props.notebook} interactive={false} /></span>
    </div>
    <Show when={changed()}><p class="review-card-change-notice">Card text changed since the last review.</p></Show>
    <section class="review-card-side" aria-label="Front">
      <h2>Front</h2>
      <div class="review-card-text"><BlockText text={props.item.card.front} notebook={props.notebook} interactive={false} /></div>
    </section>
    <Show when={revealed()} fallback={<div class="review-card-actions">
      <Button class="bordered" label="Reveal answer" shortcut="Space" aria-keyshortcuts="Space" aria-expanded={false} aria-controls={answerId} disabled={locked()} onClick={reveal}>Reveal answer <kbd>Space</kbd></Button>
    </div>}>
      <section id={answerId} class="review-card-side" aria-label="Answer">
        <h2>Answer</h2>
        <div class="review-card-text"><BlockText text={props.item.card.back} notebook={props.notebook} interactive={false} /></div>
      </section>
      <Show when={changed() && props.item.last_review}>{last => <section class="review-card-comparison" aria-label="Changed card text">
        <div class="review-card-comparison-version">
          <h2>Last shown</h2>
          <dl>
            <dt>Front</dt><dd class="review-card-text"><BlockText text={last().shown_front} notebook={props.notebook} interactive={false} /></dd>
            <dt>Answer</dt><dd class="review-card-text"><BlockText text={last().shown_back} notebook={props.notebook} interactive={false} /></dd>
          </dl>
        </div>
        <div class="review-card-comparison-version">
          <h2>Current</h2>
          <dl>
            <dt>Front</dt><dd class="review-card-text"><BlockText text={props.item.card.front} notebook={props.notebook} interactive={false} /></dd>
            <dt>Answer</dt><dd class="review-card-text"><BlockText text={props.item.card.back} notebook={props.notebook} interactive={false} /></dd>
          </dl>
        </div>
      </section>}</Show>
      <div class="review-card-progress" role="group" aria-label="Review progress">
        <Button class="bordered" aria-pressed={!resetOnGrade()} disabled={locked()} onClick={() => setResetOnGrade(false)}>Keep progress</Button>
        <Button class="bordered" aria-pressed={resetOnGrade()} disabled={locked()} onClick={() => setResetOnGrade(true)}>Start over</Button>
      </div>
      <div class="review-card-grades" role="group" aria-label="Grade answer">
        <For each={grades}>{choice => <Button class="bordered review-card-grade" label={choice.label} shortcut={choice.shortcut} aria-keyshortcuts={choice.shortcut} aria-label={`${choice.label}${interval(choice.grade) ? ` · ${interval(choice.grade)}` : ''}`} disabled={locked()} onClick={() => grade(choice.grade)}>
          <span class="review-card-grade-label">{choice.label} <kbd>{choice.shortcut}</kbd></span>
          <Show when={interval(choice.grade)}>{value => <span class="review-card-interval">{value()}</span>}</Show>
        </Button>}</For>
      </div>
      <div class="review-card-actions"><Button disabled={locked()} aria-haspopup="dialog" aria-expanded={!!resetAnchor()} onClick={event => setResetAnchor(event.currentTarget)}>Reset progress</Button></div>
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
