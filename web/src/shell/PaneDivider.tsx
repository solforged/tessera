import { Show, createSignal } from 'solid-js';
import { Icon } from '../ui/Icon';
import type { PaneId } from '../core/contract';
import { dividerRatio } from './pane-row';

/**
 * The rule between two shown panes. Dragging it shares their width, snapping at a third, a half and two thirds;
 * arrow keys move it, and a double click evens the row. A list's rule carries an arrow toward the pane it fills.
 */
export function PaneDivider(props: {
  left: PaneId;
  right: PaneId;
  follows: boolean;
  weights: Record<PaneId, number>;
  onResize(left: number, right: number): void;
  onReset(): void;
}) {
  const [snap, setSnap] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal(false);
  const total = () => (props.weights[props.left] ?? 1) + (props.weights[props.right] ?? 1);
  const share = () => (props.weights[props.left] ?? 1) / total();
  const pair = () => {
    const find = (pane: PaneId) =>
      document.querySelector<HTMLElement>(`.panes > .pane[data-pane="${CSS.escape(pane)}"]`)?.getBoundingClientRect();
    const left = find(props.left),
      right = find(props.right);
    return left && right ? { start: left.left, width: right.right - left.left } : null;
  };
  const resize = (ratio: number, width: number, tolerance?: number) => {
    const next = dividerRatio(ratio, width, tolerance);
    setSnap(next.snap);
    props.onResize(total() * next.ratio, total() * (1 - next.ratio));
  };
  const pointerdown = (event: PointerEvent) => {
    const bounds = pair();
    if (event.button !== 0 || !bounds) return;
    event.preventDefault();
    const divider = event.currentTarget as HTMLElement;
    divider.setPointerCapture(event.pointerId);
    setDragging(true);
    const move = (next: PointerEvent) => resize((next.clientX - bounds.start) / bounds.width, bounds.width);
    const end = () => {
      setDragging(false);
      setSnap(null);
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', end);
      divider.removeEventListener('pointercancel', end);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);
  };
  const keydown = (event: KeyboardEvent) => {
    const bounds = pair();
    if (!bounds || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    resize(share() + (event.key === 'ArrowLeft' ? -0.05 : 0.05), bounds.width, 0);
  };
  return (
    <div
      class="pane-divider"
      classList={{ dragging: dragging() }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share() * 100)}
      tabIndex={0}
      onPointerDown={pointerdown}
      onKeyDown={keydown}
      onDblClick={() => props.onReset()}
      onBlur={() => setSnap(null)}
    >
      <Show when={props.follows}>
        <span class="pane-follows" title="The list opens its rows in the pane to its right">
          <Icon name="right" />
        </span>
      </Show>
      <Show when={snap()}>
        <span class="pane-snap">{snap()}</span>
      </Show>
    </div>
  );
}
