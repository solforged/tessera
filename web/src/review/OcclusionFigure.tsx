import { For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { NotebookImage } from '../ui/NotebookImage';
import { occlusionSides } from './card-text';
import type { CardMask } from './card-text';
import './occlusion.css';

export function MaskShape(props: { mask: CardMask; class?: string; style?: JSX.CSSProperties }) {
  return <Show when={props.mask.shape === 'ellipse'} fallback={<rect class={props.class} style={props.style} x={props.mask.x} y={props.mask.y} width={props.mask.w} height={props.mask.h} vector-effect="non-scaling-stroke" />}>
    <ellipse class={props.class} style={props.style} cx={props.mask.x + props.mask.w / 2} cy={props.mask.y + props.mask.h / 2} rx={props.mask.w / 2} ry={props.mask.h / 2} vector-effect="non-scaling-stroke" />
  </Show>;
}

/** Both live cards and retained review evidence render their own immutable image and geometry. */
export function OcclusionFigure(props: { front: string; back: string; notebook: NotebookClient; revealed?: boolean; thumbnail?: boolean }) {
  const sides = createMemo(() => occlusionSides(props));
  const area = createMemo(() => {
    const front = sides()?.front;
    if (!front) return { x: 0, y: 0, w: 1, h: 1 };
    if (front.area) return front.area;
    if (!props.thumbnail || !front.tested.length) return { x: 0, y: 0, w: 1, h: 1 };
    const x = Math.min(...front.tested.map(mask => mask.x)), y = Math.min(...front.tested.map(mask => mask.y));
    return { x, y, w: Math.max(...front.tested.map(mask => mask.x + mask.w)) - x, h: Math.max(...front.tested.map(mask => mask.y + mask.h)) - y };
  });
  return <Show when={sides()}>{value => <figure class="occlusion-figure" classList={{ 'occlusion-thumbnail': props.thumbnail }} aria-label={props.revealed ? 'Answer' : 'Image occlusion'} style={{ '--image-ratio': value().front.image.width * area().w / (value().front.image.height * area().h) }}>
    <div class="occlusion-crop">
      <NotebookImage image={value().front.image} api={props.notebook.api} alt="Image" style={{ width: `${100 / area().w}%`, height: `${100 / area().h}%`, left: `${-100 * area().x / area().w}%`, top: `${-100 * area().y / area().h}%` }} />
      <svg viewBox={`${area().x} ${area().y} ${area().w} ${area().h}`} preserveAspectRatio="none" aria-hidden="true">
        <For each={value().front.covered}>{mask => <MaskShape mask={mask} class="occlusion-covered" />}</For>
        <For each={value().front.tested}>{mask => <g>
          <MaskShape mask={mask} class={props.revealed ? 'occlusion-revealed' : 'occlusion-tested'} />
          <Show when={!props.revealed && value().front.hint}><text class="occlusion-hint" x={mask.x + mask.w / 2} y={mask.y + mask.h / 2} text-anchor="middle" dominant-baseline="central" style={{ 'font-size': `${Math.min(mask.w / Math.max(1, (value().front.hint?.length ?? 0) * .65), mask.h * .5)}px` }}>{value().front.hint}</text></Show>
        </g>}</For>
      </svg>
    </div>
    <Show when={!props.revealed && value().front.hint}><span class="visually-hidden">{value().front.hint}</span></Show>
  </figure>}</Show>;
}
