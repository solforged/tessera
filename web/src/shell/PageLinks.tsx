import { For, createMemo } from 'solid-js';
import type { Block } from '../api/types';
import type { WorkshopClient } from '../document/contract';
import { displayTitle } from '../outline/names';
import { createPageIcon } from '../outline/source';
import { Button } from '../ui/Button';
import { opensBeside } from '../core/beside';
import type { OpenTarget } from '../core/contract';

export function PageLinks(props: {
  roots: Block[];
  sourceIcons?: boolean;
  workshop: WorkshopClient;
  activeId?: string;
  onOpen(target: OpenTarget, beside?: boolean): void;
}) {
  // Roots arrive as fresh objects whenever any root changes; keying rows by id keeps them mounted.
  const byId = createMemo(() => new Map(props.roots.map(root => [root.id, root])));
  const ids = createMemo(() => props.roots.map(root => root.id), undefined, {
    equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
  });
  return (
    <For each={ids()}>
      {id => {
        const root = () => byId().get(id)!;
        const title = () => {
          const page = props.workshop.lookup(id)() ?? root();
          return page.kind === 'page' ? displayTitle(page.text, target => props.workshop.lookup(target)) : page.text;
        };
        const icon = createPageIcon(props.workshop, root, () => !!props.sourceIcons, 'today');
        return (
          <Button
            class={id === props.activeId ? 'selected' : ''}
            icon={icon()}
            title={title()}
            data-open-page={id}
            data-open-label={title()}
            onClick={event => props.onOpen({ kind: 'page', pageId: id }, opensBeside(event))}
          >
            <span>{title()}</span>
          </Button>
        );
      }}
    </For>
  );
}
