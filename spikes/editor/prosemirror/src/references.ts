import { REFERENCE } from '@spike/shared';
import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as DocumentBlock } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';

interface ReferenceState {
  decorations: DecorationSet;
  changedTargets: Set<string>;
}

export function references(): Plugin<ReferenceState> {
  const targets = new Map<string, string>();
  const rendered = new Map<string, Set<HTMLElement>>();

  function decorationsFor(block: DocumentBlock, before: number): Decoration[] {
    const decorations: Decoration[] = [];
    for (const match of block.textContent.matchAll(REFERENCE)) {
      const start = before + 1 + match.index!;
      const end = start + match[0].length;
      const target = match[1]!;
      const alias = match[2];
      decorations.push(Decoration.inline(start, end, { class: 'reference-source' }));
      decorations.push(Decoration.widget(end, () => {
        const span = document.createElement('span');
        span.className = 'reference';
        span.contentEditable = 'false';
        span.dataset.referenceTarget = target;
        span.textContent = alias ?? targets.get(target) ?? `[[${target}]]`;
        if (!alias) {
          const elements = rendered.get(target) ?? new Set<HTMLElement>();
          elements.add(span);
          rendered.set(target, elements);
        }
        return span;
      }, {
        side: -1,
        key: `${block.attrs.id}:${match.index}:${target}:${alias ?? ''}`,
        destroy: element => {
          if (element instanceof HTMLElement && !alias) {
            const elements = rendered.get(target);
            elements?.delete(element);
            if (elements?.size === 0) rendered.delete(target);
          }
        },
      }));
    }
    return decorations;
  }

  function refreshRanges(tr: Transaction, state: EditorState): ReferenceState {
    const affected = new Map<string, { block: DocumentBlock; before: number }>();
    const changedTargets = new Set<string>();
    // Step maps identify changed textblocks. No full outline serialization or
    // reference scan is performed on a single-row edit.
    for (let index = 0; index < tr.mapping.maps.length; index++) {
      tr.mapping.maps[index]!.forEach((oldStart, oldEnd, newStart, newEnd) => {
        const oldMap = tr.mapping.slice(0, index).invert();
        const fromOld = oldMap.map(oldStart, -1);
        const toOld = oldMap.map(oldEnd, 1);
        tr.before.nodesBetween(Math.max(0, fromOld - 1), Math.min(tr.before.content.size, toOld + 1), (block) => {
          if (block.type.name === 'row') {
            targets.delete(block.attrs.id);
            changedTargets.add(block.attrs.id);
          }
          return false;
        });
        const remaining = tr.mapping.slice(index + 1);
        const from = remaining.map(newStart, -1);
        const to = remaining.map(newEnd, 1);
        tr.doc.nodesBetween(Math.max(0, from - 1), Math.min(tr.doc.content.size, to + 1), (block, before) => {
          if (block.type.name === 'row') affected.set(block.attrs.id, { block, before });
          return false;
        });
      });
    }
    let decorations = (plugin.getState(state)?.decorations ?? DecorationSet.empty).map(tr.mapping, tr.doc);
    const additions: Decoration[] = [];
    for (const { block, before } of affected.values()) {
      targets.set(block.attrs.id, block.textContent);
      changedTargets.add(block.attrs.id);
      decorations = decorations.remove(decorations.find(before, before + block.nodeSize));
      additions.push(...decorationsFor(block, before));
    }
    return { decorations: decorations.add(tr.doc, additions), changedTargets };
  }

  const plugin: Plugin<ReferenceState> = new Plugin({
    state: {
      init: (_, state) => {
        state.doc.forEach(block => targets.set(block.attrs.id, block.textContent));
        const decorations: Decoration[] = [];
        state.doc.forEach((block, before) => decorations.push(...decorationsFor(block, before)));
        return { decorations: DecorationSet.create(state.doc, decorations), changedTargets: new Set<string>() };
      },
      apply: (tr, previous, oldState) => tr.docChanged ? refreshRanges(tr, oldState) : { decorations: previous.decorations, changedTargets: new Set<string>() },
    },
    props: { decorations: state => plugin.getState(state)!.decorations },
    view: () => ({
      update: view => {
        for (const target of plugin.getState(view.state)!.changedTargets) {
          for (const element of rendered.get(target) ?? []) element.textContent = targets.get(target) ?? `[[${target}]]`;
        }
      },
    }),
  });
  return plugin;
}
