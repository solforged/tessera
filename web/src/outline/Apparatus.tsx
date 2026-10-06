import { For, Show } from 'solid-js';
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

function ring(ids: readonly string[], radius: number, offset: number): Node[] {
  return ids.map((id, index) => {
    const angle = -Math.PI / 2 + offset + index * 2 * Math.PI / ids.length;
    return { id, angle, x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
  });
}

const clip = (text: string) => text.length > LABEL ? `${text.slice(0, LABEL - 1).trimEnd()}…` : text;

/**
 * The margin of a concept page with three or more perspectives: the constellation (the concept at the centre,
 * its holders on the inner ring and the pages that link to it outside) and the key to the sigla on the page.
 */
export function Apparatus(props: {
  notebook: NotebookClient;
  holders: readonly string[];
  linked: readonly string[];
  sources: readonly { id: string; siglum: string }[];
  onOpen(target: OpenTarget, beside: boolean): void;
}) {
  const title = (id: string) => props.notebook.lookup(id)()?.text.trim() || 'Untitled';
  const inner = () => ring(props.holders, INNER, 0);
  const outer = () => ring(props.linked, OUTER, Math.PI / Math.max(props.linked.length, 1));
  const open = (id: string, event: MouseEvent) => props.onOpen({ kind: 'page', pageId: id }, event.shiftKey);
  return <aside class="outline-apparatus" aria-label="Apparatus">
    <h6>Constellation</h6>
    <svg class="constellation" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" aria-label="Perspectives and linked pages">
      <circle class="constellation-orbit" cx={CX} cy={CY} r={INNER} />
      <Show when={props.linked.length}><circle class="constellation-orbit" cx={CX} cy={CY} r={OUTER} /></Show>
      <For each={inner()}>{node => <line class="constellation-spoke" x1={CX} y1={CY} x2={node.x} y2={node.y} />}</For>
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
