import { For, Show, createEffect, createMemo, createResource, createSignal, createUniqueId, on, onCleanup, onMount } from 'solid-js';
import type { CardRow, Grade } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockBreadcrumb } from '../outline/BlockText';
import { besideHint, opensBeside } from '../shell/beside';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { cardKindLabel, clozeSegments, parseCardText } from './card-text';
import { CardBack, CardFront, ClozeText } from './CardSides';
import { gradeIntervals, gradeLabels } from './query';
import { settleHeight } from './settle';
import { phoneQuery } from '../ui/phone';
import { attachSwipe } from './swipe';
import type { SwipeGrade } from './swipe';
import { createPhone } from './use-phone';
import type { ReviewSource } from './ReviewSource';
import './review-card.css';

export interface ReviewCardProps {
  item: CardRow;
  notebook: NotebookClient;
  previews: readonly { grade: Grade; interval_days: number }[];
  resetPreviews: readonly { grade: Grade; interval_days: number }[];
  busy?: boolean;
  context?: ReviewSource | null;
  onReveal?(revealed: boolean): void;
  onEdit(beside: boolean): void;
  onGrade(grade: Grade, reset: boolean): void | Promise<void>;
  onSource(beside: boolean): void;
  onReset(): void | Promise<void>;
  onUndo(): void;
  undoDisabled: boolean;
  onEnd(anchor: HTMLElement): void;
  /** On a phone the session bar's ··· opens the card's actions; it hands over the button the menu is anchored to. */
  actionsAnchor?: HTMLElement | null;
  onActionsDismiss?(): void;
}

const grades = (['again', 'hard', 'good', 'easy'] as const).map((grade, index) => ({ grade, label: gradeLabels[grade], shortcut: String(index + 1) }));
/** A word or short phrase, such as a vocabulary card, is set large; sentences keep reading size. */
const terse = (text: string) => text.length <= 40 && !text.includes('\n');
/** On the cover screen a confirmation is a bottom sheet, as the shell's delete confirmation is. */
const coverLayout = window.matchMedia(phoneQuery);
/** Set once a card has been graded by swiping: the hint at the foot of the card has done its job. */
const swipeUsedKey = 'tessera.review-swipe-used';

export function ReviewCard(props: ReviewCardProps) {
  const [revealedItems, setRevealedItems] = createSignal(0);
  const [hintShown, setHintShown] = createSignal(false);
  const itemCount = () => props.item.card.kind === 'list' ? props.item.card.answer_blocks.length : 1;
  const revealed = () => revealedItems() >= itemCount();
  const [resetOnGrade, setResetOnGrade] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [resetAnchor, setResetAnchor] = createSignal<HTMLElement | null>(null);
  const [actions, setActions] = createSignal<HTMLElement | null>(null);
  const phone = createPhone();
  const [swipeHint, setSwipeHint] = createSignal(localStorage.getItem(swipeUsedKey) === null);
  const answerId = createUniqueId();
  const locked = () => !!props.busy || pending();
  const lockedAttr = () => locked() ? 'true' as const : undefined;
  // One size per card: large only when both sides are short, so a short question never outsizes its answer.
  const large = () => !props.item.card.answer_blocks.length && terse(props.item.card.front) && terse(props.item.card.back);
  const [siblings] = createResource(() => props.item.card.kind === 'occlusion' ? props.item.card.source_block_id : false, id => props.notebook.api.sourceCards(id).then(cards => cards.filter(card => card.active)));
  const kindLabel = createMemo(() => cardKindLabel(props.item.card, siblings() ?? parseCardText(props.item.source.block.text).cards));
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
  let leaf!: HTMLDivElement;
  let generation = 0;
  let disposed = false;

  createEffect(on(() => props.item.card.id, () => {
    const focused = region?.contains(region.ownerDocument.activeElement);
    generation++;
    setRevealedItems(0);
    setHintShown(false);
    setResetOnGrade(false);
    setPending(false);
    setError('');
    setResetAnchor(null);
    setActions(null);
    if (focused) region.focus({ preventScroll: true });
  }));
  onCleanup(() => { disposed = true; });
  createEffect(() => props.onReveal?.(revealed()));

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
  /** Brings the grades into view inside the review scroller once the answer has settled; it never takes focus. A card taller than the scroller
   * loses its top first: the grades are what the writer needs next. Without a grade strip (a list still revealing) the card's top stays in view. */
  function keepInView() {
    const scroller = region.closest<HTMLElement>('.review-scroll');
    if (disposed || !scroller || !region.querySelector('.review-card-answer, .recipe-answer, .review-card-grades')) return;
    const card = region.getBoundingClientRect(), view = scroller.getBoundingClientRect();
    const hidden = card.bottom - view.bottom;
    const over = region.querySelector('.review-card-grades') ? hidden : Math.min(hidden, card.top - view.top);
    if (over > 0) scroller.scrollBy({ top: over, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function reveal() {
    if (locked() || revealed()) return;
    const focused = region.contains(region.ownerDocument.activeElement);
    const from = region.offsetHeight;
    setRevealedItems(value => value + 1);
    if (focused) region.focus({ preventScroll: true });
    const settling = settleHeight(region, from);
    if (settling) void settling.finished.then(keepInView, () => {}); else keepInView();
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
    if ((event.key === ' ' || event.key === 'Enter') && !target?.closest('button, a, summary, [role="button"]')) {
      event.preventDefault(); event.stopPropagation(); grade('good'); return;
    }
    const choice = grades.find(value => value.shortcut === event.key);
    if (choice) { event.preventDefault(); event.stopPropagation(); grade(choice.grade); }
  }
  onMount(() => {
    region.addEventListener('keydown', keydown);
    onCleanup(() => region.removeEventListener('keydown', keydown));
  });
  // A phone grades by dragging the card sideways: right is Good, left is Again. The capsules stay the visible path.
  onMount(() => {
    onCleanup(attachSwipe(leaf, {
      enabled: () => coverLayout.matches && revealed() && !locked() && !resetAnchor(),
      onDrag(dx, armed) {
        leaf.dataset.dragging = '';
        leaf.dataset.swipe = armed ?? '';
        leaf.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      },
      onCommit: fling,
      onCancel: settleLeaf,
    }));
  });
  // A grade that is refused brings the card back.
  createEffect(() => { if (error()) settleLeaf(); });
  function settleLeaf() {
    delete leaf.dataset.dragging;
    delete leaf.dataset.swipe;
    leaf.style.removeProperty('transform');
    leaf.style.removeProperty('opacity');
  }
  function fling(value: SwipeGrade) {
    try { localStorage.setItem(swipeUsedKey, '1'); } catch { /* storage is off: the hint simply stays */ }
    setSwipeHint(false);
    delete leaf.dataset.dragging;
    const away = value === 'good' ? 1 : -1;
    leaf.style.transform = `translateX(${away * 120}%) rotate(${away * 8}deg)`;
    leaf.style.opacity = '0';
    grade(value);
  }
  /** A phone sets an interval's figure in mono and its unit in prose: `3 days`. */
  const intervalText = (value: string) => {
    const [figure, ...unit] = value.split(' ');
    return phone() ? <><span class="review-fig">{figure}</span> {unit.join(' ')}</> : value;
  };
  const glyph = (name: IconName): IconName | undefined => phone() ? name : undefined;

  return <div ref={region} class="review-card" classList={{ 'review-recipe': !!props.item.card.template, 'review-answering': revealedItems() > 0 }} role="region" aria-label="Review card" aria-busy={locked()} tabIndex={0} onClick={event => {
    if ((event.target as Element).closest('button, a, summary, input, textarea, [role="button"]') || !window.getSelection()?.isCollapsed) return;
    reveal();
  }}>
    {/* The leaf holds what is asked and answered; on a phone the reveal and the grades sit below it, on the page. Elsewhere it adds no box. */}
    <div ref={leaf} class="review-card-leaf">
    <div class="review-card-meta">
      <Button class="review-card-source" title={`${props.context ? 'Open in the book' : 'Open source'} · ${besideHint}`} aria-disabled={lockedAttr()} onClick={event => props.onSource(opensBeside(event))}>
        <Show when={props.context} fallback={<BlockBreadcrumb block={props.item.source.block} notebook={props.notebook} omitParent={props.item.card.kind === 'descriptor'} />}>{context => <span>{context().source.source.siglum} · {context().source.page.text}<Show when={context().chapter}> · {context().chapter}</Show> · ¶{context().citation.ordinal + 1}</span>}</Show>
      </Button>
      <span class="review-card-kind">{kindLabel()}</span>
      <Show when={!phone()}><Button icon="more" label="Card actions" aria-haspopup="menu" aria-disabled={lockedAttr()} onClick={event => setActions(event.currentTarget)} /></Show>
    </div>
    <Show when={props.item.card.template}>{template => <p class="review-card-meta recipe-provenance"><span>from #{template().type_name}</span><span>{template().name}</span></p>}</Show>
    <Show when={changed()}><p class="review-card-change-notice">Wording changed since your last review.</p></Show>
    <Show when={props.item.card.template} fallback={<>
    <Show when={gaps()} fallback={<>
      <section class="review-card-side" classList={{ 'review-card-terse': large() }} aria-label="Front"><CardFront kind={props.item.card.kind} front={props.item.card.front} back={props.item.card.back} revealed={revealed()} notebook={props.notebook} /></section>
      <Show when={revealedItems() > 0}>
        <section id={answerId} class="review-card-side review-card-answer" classList={{ 'review-card-terse': large() }} aria-label="Answer"><CardBack kind={props.item.card.kind} front={props.item.card.front} back={props.item.card.back} blocks={props.item.card.answer_blocks} visibleItems={revealedItems()} notebook={props.notebook} /></section>
      </Show>
    </>}>{segments => <section id={revealed() ? answerId : undefined} class="review-card-side" classList={{ 'review-card-terse': large() }} aria-label={revealed() ? 'Answer' : 'Front'}>
      <ClozeText segments={segments()} revealed={revealed()} notebook={props.notebook} />
    </section>}</Show>
    </>}>{recipe => <>
      <section class="recipe-front" aria-label="Front"><span class="recipe-index">01</span><div><div class="recipe-label">{recipe().front_label}</div><div class="review-card-side">{props.item.card.front}</div></div></section>
      <Show when={!revealed() && recipe().hint}>{hint => <div class="recipe-hint"><span>{hint().label}</span><Show when={hintShown()} fallback={<Button aria-disabled={lockedAttr()} onClick={() => setHintShown(true)}>Show hint</Button>}><span>{hint().value}</span></Show></div>}</Show>
      <Show when={revealed()}><section id={answerId} class="recipe-answer" aria-label="Answer">
        <div class="recipe-label">{recipe().back_label}</div><div class="review-card-side">{props.item.card.back}</div>
        <Show when={recipe().details.length}><dl class="recipe-apparatus"><For each={recipe().details}>{detail => <><dt>{detail.label}</dt><dd classList={{ 'recipe-prose': detail.prose }}>{detail.value}</dd></>}</For></dl></Show>
      </section></Show>
    </>}</Show>
    <Show when={props.item.card.kind === 'list' && revealedItems() > 0}><p class="review-list-progress" role="status">{revealedItems()} of {itemCount()}</p></Show>
    <Show when={revealed() && props.context?.following}><blockquote class="review-card-following">{props.context!.following}</blockquote></Show>
    <Show when={phone() && revealed()}><div class="review-card-swipe" classList={{ used: !swipeHint() }} aria-hidden="true"><span><Icon name="left" />Again</span><span>Good<Icon name="right" /></span></div></Show>
    </div>
    <Show when={revealed()} fallback={<div class="review-card-actions">
      <Button class={phone() ? undefined : 'bordered'} kind={phone() ? 'stamp' : undefined} size={phone() ? 'lg' : undefined} label={revealedItems() ? 'Reveal next item' : props.item.card.template ? 'Show answer' : 'Reveal answer'} shortcut="Space" aria-keyshortcuts="Space" aria-expanded={revealedItems() > 0} aria-controls={answerId} aria-disabled={lockedAttr()} onClick={reveal}>{revealedItems() ? 'Reveal next item' : props.item.card.template ? 'Show answer' : 'Reveal answer'} <kbd>Space</kbd></Button>
    </div>}>
      <Show when={changed() && props.item.last_review}>{last => <section class="review-card-comparison" aria-label="Changed card text">
        <div class="review-card-comparison-versions">
          <div class="review-card-comparison-version">
            <h2>Last reviewed</h2>
            <dl>
              <dt>Front</dt><dd class="review-card-text"><CardFront kind={props.item.card.kind} front={last().shown_front} back={last().shown_back} plain={!!props.item.card.template} notebook={props.notebook} /></dd>
              <dt>Answer</dt><dd class="review-card-text"><CardBack plain={!!props.item.card.template} kind={props.item.card.kind} front={last().shown_front} back={last().shown_back} notebook={props.notebook} /></dd>
            </dl>
          </div>
          <div class="review-card-comparison-version">
            <h2>Current</h2>
            <dl>
              <dt>Front</dt><dd class="review-card-text"><CardFront kind={props.item.card.kind} front={props.item.card.front} back={props.item.card.back} plain={!!props.item.card.template} notebook={props.notebook} /></dd>
              <dt>Answer</dt><dd class="review-card-text"><CardBack plain={!!props.item.card.template} kind={props.item.card.kind} front={props.item.card.front} back={props.item.card.back} blocks={props.item.card.answer_blocks} notebook={props.notebook} /></dd>
            </dl>
          </div>
        </div>
        <div class="review-card-progress" role="group" aria-label="Review progress">
          <Button aria-pressed={!resetOnGrade()} aria-disabled={lockedAttr()} onClick={() => setResetOnGrade(false)}>Keep progress</Button>
          <Button aria-pressed={resetOnGrade()} aria-disabled={lockedAttr()} onClick={() => setResetOnGrade(true)}>Start over</Button>
        </div>
      </section>}</Show>
      <div class="review-card-grades" role="group" aria-label="Grade answer">
        <For each={grades}>{choice => <Button class="review-card-grade" kind={phone() ? 'tint' : undefined} classList={{ 'review-card-grade-default': choice.grade === 'good', 'review-card-grade-again': choice.grade === 'again' }} label={choice.label} shortcut={choice.shortcut} aria-keyshortcuts={choice.grade === 'good' ? `${choice.shortcut} Space Enter` : choice.shortcut} aria-label={`${choice.label}${choice.grade === 'good' ? ' · default' : ''}${interval(choice.grade) ? ` · ${interval(choice.grade)}` : ''}`} aria-disabled={lockedAttr()} onClick={() => grade(choice.grade)}>
          <span class="review-card-grade-label">{choice.label} <kbd>{choice.shortcut}</kbd></span>
          <Show when={interval(choice.grade)}>{value => <span class="review-card-interval">{intervalText(value())}</span>}</Show>
        </Button>}</For>
      </div>
    </Show>
    <Show when={error() && !resetAnchor()}><p class="error review-card-error" role="alert">{error()}</p></Show>
    <Show keyed when={phone() ? props.actionsAnchor : actions()}>{anchor => <Menu anchor={anchor} label="Card actions" onDismiss={() => phone() ? props.onActionsDismiss?.() : setActions(null)} items={[
      { label: props.context ? 'Open in the book' : 'Open source', icon: glyph(props.context ? 'book' : 'page'), action: () => props.onSource(false) },
      { label: 'Edit card', icon: glyph('edit'), action: () => props.onEdit(false) },
      { label: 'Reset progress', icon: glyph('history'), disabledReason: !revealed() ? 'Reveal the answer first.' : props.item.card.schedule.last_reviewed_at === null ? 'This card has no progress yet.' : undefined, action: () => setResetAnchor(anchor) },
      { label: 'Undo last grade', icon: glyph('undo'), divider: true, disabledReason: props.undoDisabled ? 'Nothing graded yet.' : undefined, action: props.onUndo },
      { label: 'End review', icon: glyph('close'), action: () => props.onEnd(anchor) },
    ]} />}</Show>
    <Show when={resetAnchor()}>{anchor => <Popup anchor={anchor()} placement={coverLayout.matches ? 'sheet' : 'anchor'} label="Reset progress" class="review-card-reset" onDismiss={() => setResetAnchor(null)}>
      <p>Reset this card’s schedule? Review history stays.</p>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions">
        <Button disabled={locked()} onClick={cancelReset}>Cancel</Button>
        <Button class="bordered" disabled={locked()} onClick={resetProgress}>Reset</Button>
      </div>
    </Popup>}</Show>
  </div>;
}
