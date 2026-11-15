import { For, Show, createMemo } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { CardAnswerBlock, CardKind } from '../api/types';
import type { WorkshopClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { ClozeSegment } from '../core/card-text';
import { occlusionSides } from '../core/card-text';
import { OcclusionFigure } from './OcclusionFigure';
import './card-sides.css';
import { WorkshopImage } from '../ui/NotebookImage';
import '../outline/image.css';

export function CardFront(props: {
  kind: CardKind;
  front: string;
  back: string;
  plain?: boolean;
  revealed?: boolean;
  workshop: WorkshopClient;
}) {
  return (
    <Show
      when={props.kind === 'occlusion'}
      fallback={
        <Show
          when={props.plain}
          fallback={<BlockText text={props.front} workshop={props.workshop} interactive={false} />}
        >
          {props.front}
        </Show>
      }
    >
      <OcclusionFigure front={props.front} back={props.back} revealed={props.revealed} workshop={props.workshop} />
    </Show>
  );
}
/** Canonical child snapshots also render in history and stale-definition views. */
export function CardBack(props: {
  kind: CardKind;
  back: string;
  front?: string;
  blocks?: CardAnswerBlock[];
  visibleItems?: number;
  plain?: boolean;
  workshop: WorkshopClient;
}) {
  const blocks = createMemo(() => {
    if (props.kind !== 'multiline' && props.kind !== 'list') return null;
    const answer: CardAnswerBlock[] = props.blocks ?? JSON.parse(props.back);
    return props.kind === 'list' && props.visibleItems !== undefined ? answer.slice(0, props.visibleItems) : answer;
  });
  return (
    <Show
      when={props.kind === 'occlusion'}
      fallback={
        <Show
          when={props.plain}
          fallback={
            <Show
              when={blocks()}
              fallback={<BlockText text={props.back} workshop={props.workshop} interactive={false} />}
            >
              {answer => <AnswerOutline blocks={answer()} numbered={props.kind === 'list'} workshop={props.workshop} />}
            </Show>
          }
        >
          {props.back}
        </Show>
      }
    >
      {occlusionSides({ front: props.front ?? '', back: props.back })?.back.answer}
    </Show>
  );
}

/** A list answer numbers its items in rubric, as a manuscript numbers its points; nested blocks keep plain bullets. */
function AnswerOutline(props: { blocks: CardAnswerBlock[]; numbered?: boolean; workshop: WorkshopClient }) {
  return (
    <Dynamic component={props.numbered ? 'ol' : 'ul'} class="card-answer-outline">
      <For each={props.blocks}>
        {block => (
          <li>
            <Show when={block.image}>
              {image => (
                <WorkshopImage class="card-answer-image" image={image()} api={props.workshop.api} alt={block.text} />
              )}
            </Show>
            <BlockText text={block.text} cards workshop={props.workshop} interactive={false} />
            <Show when={block.children.length}>
              <AnswerOutline blocks={block.children} workshop={props.workshop} />
            </Show>
          </li>
        )}
      </For>
    </Dynamic>
  );
}

/** A cloze's gaps read `[…]`, or `[hint]`, until revealed, wherever the card is shown. */
export function ClozeText(props: { segments: ClozeSegment[]; revealed: boolean; workshop: WorkshopClient }) {
  return (
    <For each={props.segments}>
      {segment =>
        'text' in segment ? (
          <BlockText text={segment.text} workshop={props.workshop} interactive={false} />
        ) : (
          <Show
            when={props.revealed}
            fallback={
              <span class="card-cloze-gap">
                <span class="visually-hidden">{segment.hint ? 'Blank, hint: ' : 'Blank'}</span>
                <span aria-hidden="true">[</span>
                {segment.hint ? (
                  <BlockText text={segment.hint} workshop={props.workshop} interactive={false} />
                ) : (
                  <span aria-hidden="true">…</span>
                )}
                <span aria-hidden="true">]</span>
              </span>
            }
          >
            <mark class="card-cloze-answer">
              <BlockText text={segment.answer} workshop={props.workshop} interactive={false} />
            </mark>
          </Show>
        )
      }
    </For>
  );
}
