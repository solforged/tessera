import { For, Show } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget } from '../shell/contract';
import { opensBeside } from '../shell/beside';
import { Button } from '../ui/Button';
import { createRevisits, revisitKind } from './revisits';
import './revisits.css';

export function ResearchToRevisit(props: { notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void }) {
  const queue = createRevisits(props.notebook);
  return <Show when={queue.rows().length || queue.error()}><section class="research-revisits" aria-label="Research to revisit">
    <header class="related-header"><h2>Research to revisit</h2><span>{queue.rows().length}</span></header>
    <Show when={queue.error()}><p class="error" role="alert">{queue.error()}</p></Show>
    <For each={queue.rows()}>{row => <div class="research-revisit-row">
      <div><BlockText text={row.block.block.text} notebook={props.notebook} interactive={false} /><span class="revisit-meta">{revisitKind(row)} · {row.revisit_on}</span></div>
      <Button onClick={event => props.onOpen({ kind: 'revisits', revisitId: row.block.block.id }, opensBeside(event))}>Open in Revisits</Button>
    </div>}</For>
  </section></Show>;
}
