import { opensBeside } from '../shell/beside';
import { For, Show, createMemo, createUniqueId } from 'solid-js';
import type { RelationKind } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';

const WIDTH = 240;
const HEIGHT = 220;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const INNER = 56;
const OUTER = 92;
const LABEL = 11;

interface Node { id: string; x: number; y: number; angle: number }
/** An authored relation between two holders' perspectives on this page's subject. */
export interface HolderRelation { from: string; to: string; kind: Exclude<RelationKind, 'answers'> }

const kindOrder: readonly HolderRelation['kind'][] = ['disputes', 'qualifies', 'supports'];
const kindVerb: Record<HolderRelation['kind'], string> = { supports: 'supports', disputes: 'disputes', qualifies: 'qualifies' };

/**
 * A chord bowed toward the hub but kept clear of it, so a pair across the ring passes beside the centre rather
 * than through it. It ends short of the target node so its arrowhead stays visible.
 */
function chord(from: Node, to: Node): string {
  const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
  const offset = Math.hypot(mx - CX, my - CY);
  const [ux, uy] = offset > 1 ? [(mx - CX) / offset, (my - CY) / offset] : [-(to.y - from.y) / INNER / 2, (to.x - from.x) / INNER / 2];
  const bow = Math.max(offset * 0.35, 18);
  const cx = CX + ux * bow, cy = CY + uy * bow;
  const dx = to.x - cx, dy = to.y - cy, length = Math.hypot(dx, dy) || 1;
  return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x - dx / length * 7} ${to.y - dy / length * 7}`;
}

function ring(ids: readonly string[], radius: number, offset: number): Node[] {
  return ids.map((id, index) => {
    const angle = -Math.PI / 2 + offset + index * 2 * Math.PI / ids.length;
    return { id, angle, x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
  });
}

const clip = (text: string) => text.length > LABEL ? `${text.slice(0, LABEL - 1).trimEnd()}…` : text;

/**
 * The margin of a concept page with three or more perspectives: the constellation (the concept at the centre,
 * its holders on the inner ring, the authored relations between them as chords and the pages that link to it
 * outside) and the key to the sigla on the page.
 */
export function Apparatus(props: {
  notebook: NotebookClient;
  holders: readonly string[];
  linked: readonly string[];
  relations: readonly HolderRelation[];
  sources: readonly { id: string; siglum: string }[];
  onOpen(target: OpenTarget, beside: boolean): void;
}) {
  const title = (id: string) => props.notebook.lookup(id)()?.text.trim() || 'Untitled';
  const inner = () => ring(props.holders, INNER, 0);
  const outer = () => ring(props.linked, OUTER, Math.PI / Math.max(props.linked.length, 1));
  const open = (id: string, event: MouseEvent) => props.onOpen({ kind: 'page', pageId: id }, opensBeside(event));
  const marker = createUniqueId();
  const chords = createMemo(() => {
    const nodes = new Map(inner().map(node => [node.id, node]));
    return props.relations.flatMap(relation => {
      const from = nodes.get(relation.from), to = nodes.get(relation.to);
      return from && to ? [{ ...relation, path: chord(from, to) }] : [];
    });
  });
  const kinds = () => kindOrder.filter(kind => props.relations.some(relation => relation.kind === kind));
  return <aside class="outline-apparatus" aria-label="Apparatus">
    <h6>Constellation</h6>
    <svg class="constellation" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" aria-label="Perspectives and linked pages">
      <circle class="constellation-orbit" cx={CX} cy={CY} r={INNER} />
      <Show when={props.linked.length}><circle class="constellation-orbit" cx={CX} cy={CY} r={OUTER} /></Show>
      <defs>
        <For each={kindOrder}>{kind => <marker id={`${marker}-${kind}`} class={`constellation-arrow constellation-${kind}`} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 6 3 L 0 6 z" /></marker>}</For>
      </defs>
      <For each={inner()}>{node => <line class="constellation-spoke" x1={CX} y1={CY} x2={node.x} y2={node.y} />}</For>
      <For each={chords()}>{relation => <path class={`constellation-relation constellation-${relation.kind}`} d={relation.path} marker-end={`url(#${marker}-${relation.kind})`}>
        <title>{`${title(relation.from)} ${kindVerb[relation.kind]} ${title(relation.to)}`}</title>
      </path>}</For>
      <For each={outer()}>{node => <g class="constellation-linked" role="link" tabIndex={0} aria-label={title(node.id)} onClick={event => open(node.id, event)}>
        <title>{title(node.id)}</title>
        <circle cx={node.x} cy={node.y} r={3} />
      </g>}</For>
      <For each={inner()}>{node => {
        const cos = Math.cos(node.angle);
        const anchor = cos > 0.35 ? 'start' : cos < -0.35 ? 'end' : 'middle';
        const x = node.x + (anchor === 'start' ? 8 : anchor === 'end' ? -8 : 0);
        const y = anchor !== 'middle' ? node.y + 4 : Math.sin(node.angle) < 0 ? node.y - 9 : node.y + 16;
        return <g class="constellation-holder" role="link" tabIndex={0} aria-label={title(node.id)} onClick={event => open(node.id, event)}>
          <title>{title(node.id)}</title>
          <circle cx={node.x} cy={node.y} r={4} />
          <text x={x} y={y} text-anchor={anchor}>{clip(title(node.id))}</text>
        </g>;
      }}</For>
      <circle class="constellation-centre" cx={CX} cy={CY} r={8} />
      <circle class="constellation-hub" cx={CX} cy={CY} r={3.5} />
    </svg>
    <Show when={kinds().length}>
      <ul class="constellation-key" aria-label="Relations">
        <For each={kinds()}>{kind => <li><svg viewBox="0 0 16 6" aria-hidden="true"><line class={`constellation-relation constellation-${kind}`} x1="0" y1="3" x2="16" y2="3" /></svg>{kindVerb[kind]}</li>}</For>
      </ul>
    </Show>
    <Show when={props.sources.length}>
      <h6>Sources</h6>
      <ul class="apparatus-sources">
        <For each={props.sources}>{source => <li>
          <span class="apparatus-siglum">{source.siglum}</span>
          <button type="button" onClick={event => open(source.id, event)}>{title(source.id)}</button>
        </li>}</For>
      </ul>
    </Show>
  </aside>;
}
