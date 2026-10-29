import { createSignal } from 'solid-js';

const EASE = 'cubic-bezier(.2, .8, .2, 1)';
/** A row that leaves or arrives takes about this long; the tokens cannot reach Web Animations. */
const DURATION = 180;
/** How long a collapsed row waits for the refetch that removes it before it is brought back. */
const EXIT_HOLD = 1500;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The done glyph's pop, shared by the task status button and Agenda rows. */
export function popStatusGlyph(icon: Element | null | undefined): void {
  if (!icon || reduced()) return;
  icon.animate([{ scale: 0.4, opacity: 0.4 }, { scale: 1.15 }, { scale: 1, opacity: 1 }], { duration: 220, easing: EASE });
}

export interface RowExit {
  /** Resolves when the row has faded and collapsed, or when it has been brought back. */
  finished: Promise<void>;
  /** Eases a row that outlived its list back to full size, for example when the refetch kept it. */
  release(): void;
  /** Drops the exit at once, for a row that is being removed. */
  cancel(): void;
}

const exits = new WeakMap<HTMLElement, RowExit>();

/**
 * The row's resting look, as keyframes: what an exit leaves from and an entrance arrives at. A row that `content-visibility: auto`
 * skips reports its placeholder size, so it is made visible first; the caller restores `contentVisibility` when its animation ends.
 */
function restingFrame(row: HTMLElement, closeGap: boolean): { rest: Keyframe; gone: Keyframe } {
  row.style.contentVisibility = 'visible';
  const style = getComputedStyle(row);
  const rest: Keyframe = { height: `${row.offsetHeight}px`, opacity: 1, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderBottomWidth: style.borderBottomWidth };
  const gone: Keyframe = { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', borderBottomWidth: '0px' };
  if (closeGap) {
    // A group in a column with a gap takes the gap with it, or the list would jump by the gap when the group unmounts.
    const gap = parseFloat(getComputedStyle(row.parentElement!).rowGap) || 0;
    rest.marginBottom = '0px'; gone.marginBottom = `${-gap}px`;
  }
  return { rest, gone };
}

/**
 * Fades a row out and collapses its height, so the rows below close the gap instead of jumping. Null under reduced motion.
 * The row carries `data-leaving` while it goes, and eases back by itself if nothing removes it.
 */
export function exitRow(row: HTMLElement, delay = 0, closeGap = false): RowExit | null {
  if (reduced() || !row.isConnected) return null;
  exits.get(row)?.cancel();
  const { rest, gone } = restingFrame(row, closeGap);
  row.style.overflow = 'hidden';
  row.dataset.leaving = '';
  const animation = row.animate([rest, gone], { duration: DURATION, delay, easing: EASE, fill: 'both' });
  const timer = window.setTimeout(() => exit.release(), EXIT_HOLD);
  const stop = () => {
    window.clearTimeout(timer);
    animation.cancel();
    row.style.overflow = ''; row.style.contentVisibility = '';
    delete row.dataset.leaving;
    if (exits.get(row) === exit) exits.delete(row);
  };
  const exit: RowExit = {
    finished: animation.finished.then(() => {}, () => {}),
    release() {
      window.clearTimeout(timer);
      delete row.dataset.leaving;
      if (animation.playState === 'finished') {
        // A finished animation cannot be reversed reliably (WebKit fires its queued finish into the reverse): start over from collapsed.
        stop();
        enterRow(row, closeGap);
      } else if (animation.pending || Number(animation.currentTime ?? 0) <= delay) {
        // Not visibly started: reversing would rewind to the end, and cancelling looks the same.
        stop();
      } else {
        animation.reverse();
        void animation.finished.then(() => { if (exits.get(row) === exit) stop(); }, () => {});
      }
    },
    cancel: stop,
  };
  exits.set(row, exit);
  return exit;
}

/** Brings a leaving row back (or drops its exit at once when `animate` is false). */
export function releaseRow(row: HTMLElement, animate = true): void {
  const exit = exits.get(row);
  if (!exit) return;
  if (animate) exit.release(); else exit.cancel();
}

const [held, setHeld] = createSignal<ReadonlySet<string>>(new Set());
/** Task ids whose rows keep rendering in the list they left until their exit ends. */
export const heldRows = held;
/** A refetch removes a task's row at once; holding its id lets the row finish leaving first. */
export function holdRows(ids: readonly string[], until: Promise<unknown>): void {
  setHeld(current => new Set([...current, ...ids]));
  void until.then(() => setHeld(current => {
    const next = new Set(current);
    for (const id of ids) next.delete(id);
    return next;
  }));
}

/** A row that arrives after its list was shown glides open from nothing: it fades and grows, so the rows below move smoothly. */
export function enterRow(row: HTMLElement, closeGap = false): void {
  if (reduced() || !row.isConnected) return;
  const { rest, gone } = restingFrame(row, closeGap);
  row.style.overflow = 'hidden';
  const animation = row.animate([gone, rest], { duration: DURATION, easing: EASE });
  const done = () => { row.style.overflow = ''; row.style.contentVisibility = ''; };
  void animation.finished.then(done, done);
}
