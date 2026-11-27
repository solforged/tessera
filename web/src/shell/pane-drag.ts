import { batch, createSignal, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { ContextRef } from '../api/types';
import { mac } from '../core/beside';
import type { OpenTarget, PaneId } from '../core/contract';
import type { WorkshopClient } from '../document/contract';
import { besideSlot, insertPane, paneCapacity } from './pane-row';

/** A drop replaces a pane, or inserts a new one at a position in the row. */
type DropZone = { replace: PaneId } | { insert: number };

/** What a modifier-click or a drag can open: links, buttons and rows. */
const OPENABLE =
  'a[href], button, [role="button"], [role="link"], [role="option"], [role="tab"], [data-reference], [data-open-page]';
/** Index rows take ⌘ and Shift for selection, so holding the modifier there previews nothing. */
const SELECTING = '.index-selectable, .index-queue-row, .index-source-row, .library-checkbox';

export interface PaneGuide {
  left: number;
  width: number;
  label: string;
  fresh: boolean;
}

export interface PaneDragChip {
  x: number;
  y: number;
  label: string;
}

export interface PaneDragOptions {
  paneRow: Accessor<HTMLElement | undefined>;
  workshop: WorkshopClient;
  order: Accessor<PaneId[]>;
  active: Accessor<PaneId>;
  tabbed: Accessor<boolean>;
  fit: Accessor<number>;
  rowWidth: Accessor<number>;
  canOpenBeside(owner: PaneId): boolean;
  open(target: OpenTarget, beside?: boolean, owner?: PaneId, restore?: undefined, insertAt?: number): void;
  addDockContext(ref: ContextRef, title: string): void;
}

/**
 * Where a click or a drop will open shows before it happens: a gilt frame over the pane it replaces, or a hatched
 * ghost where a new pane will stand. Holding the beside modifier over something openable shows it for a click.
 */
export function createPaneDragGuide(options: PaneDragOptions) {
  const [guide, setGuide] = createSignal<PaneGuide | null>(null);
  const [dragChip, setDragChip] = createSignal<PaneDragChip | null>(null);

  const rowChild = (selector: string) => options.paneRow()?.querySelector<HTMLElement>(`:scope > ${selector}`) ?? null;

  /** A new pane at `index` would add a pane, fold one into a spine, or close the one farthest from it. */
  const newPaneLabel = (index: number) => {
    const placed = insertPane(options.order(), index, '');
    const closed = placed.closed
      ? ` · pane ${options.order().indexOf(placed.closed) + 1} closes`
      : paneCapacity(options.rowWidth(), placed.order.length) < placed.order.length
        ? ' · one folds aside'
        : '';
    return `New pane ${index + 1}${closed}`;
  };

  /** The guide over `existing` (its spine when folded), or a ghost of a new pane at `index`. */
  const guideAt = (index: number, existing: PaneId | null, label: string): PaneGuide | null => {
    const rowElement = options.paneRow();
    if (!rowElement) return null;
    const row = rowElement.getBoundingClientRect();
    const element =
      existing &&
      (rowChild(`.pane[data-pane="${CSS.escape(existing)}"]:not(.folded)`) ??
        rowChild(`.pane-spine[data-spine="${CSS.escape(existing)}"]`));
    if (element) {
      const rect = element.getBoundingClientRect();
      return { left: rect.left - row.left, width: rect.width, label, fresh: false };
    }
    const width = row.width / (Math.min(options.fit(), options.order().length) + 1);
    const next = options.order()[index];
    const edge = next
      ? (
          rowChild(`.pane[data-pane="${CSS.escape(next)}"]:not(.folded)`) ??
          rowChild(`.pane-spine[data-spine="${CSS.escape(next)}"]`)
        )?.getBoundingClientRect().left
      : undefined;
    const left =
      edge === undefined ? row.width - width : Math.max(0, Math.min(row.width - width, edge - row.left - width / 2));
    return { left, width, label, fresh: true };
  };

  /** The pane a drop at (x, y) replaces, or the position a new pane takes when it lands on a pane's edge. */
  const dropAt = (x: number, y: number): DropZone | null => {
    if (options.tabbed()) return null;
    const rowElement = options.paneRow();
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('.panes > .pane, .panes > .pane-spine');
    if (!element || !rowElement || element.parentElement !== rowElement) return null;
    const pane = element.dataset.pane ?? element.dataset.spine!;
    if (element.classList.contains('pane-spine')) return { replace: pane };
    const rect = element.getBoundingClientRect(),
      at = options.order().indexOf(pane),
      edge = Math.min(64, rect.width / 6);
    if (x < rect.left + edge) return { insert: at };
    if (x > rect.right - edge) return { insert: at + 1 };
    return { replace: pane };
  };

  const guideForDrop = (zone: DropZone) =>
    'replace' in zone
      ? guideAt(
          options.order().indexOf(zone.replace),
          zone.replace,
          `Open in pane ${options.order().indexOf(zone.replace) + 1}`,
        )
      : guideAt(zone.insert, null, newPaneLabel(zone.insert));

  /** What a dragged row or reference opens: `data-open-page` (with `data-open-block`) or a rendered reference. */
  const dragTarget = (element: Element): { target: OpenTarget; label: string } | null => {
    const row = element.closest<HTMLElement>('[data-open-page]');
    if (row)
      return {
        target: {
          kind: 'page',
          pageId: row.dataset.openPage!,
          ...(row.dataset.openBlock ? { blockId: row.dataset.openBlock } : {}),
        },
        label: row.dataset.openLabel ?? row.textContent?.trim() ?? '',
      };
    const reference = element.closest<HTMLElement>('.outline-reference[data-reference]');
    const block = reference && options.workshop.lookup(reference.dataset.reference!)();
    if (!reference || !block) return null;
    return {
      target:
        block.id === block.page_id
          ? { kind: 'page', pageId: block.id }
          : { kind: 'page', pageId: block.page_id, blockId: block.id },
      label: reference.textContent?.trim() ?? '',
    };
  };

  onMount(() => {
    const modifier = mac ? 'Meta' : 'Control';
    let pointer: { x: number; y: number } | null = null,
      held = false,
      holdTimer = 0;
    let drag: { x: number; y: number; target: OpenTarget; label: string; moving: boolean } | null = null;
    const previewBeside = () => {
      if (!held || !pointer || drag?.moving || options.tabbed()) {
        if (!drag?.moving) setGuide(null);
        return;
      }
      const hit = document.elementFromPoint(pointer.x, pointer.y);
      // A pane's view transition covers the page and answers every hit test; look again once it has passed.
      if (hit === document.documentElement) {
        requestAnimationFrame(previewBeside);
        return;
      }
      const openable = hit?.closest(OPENABLE);
      const owner =
        openable && !openable.closest(`${SELECTING}, .global-rail, .pane-tabs, .panes > .pane-spine`)
          ? (openable.closest<HTMLElement>('.panes > .pane')?.dataset.pane ??
            (openable.closest('.sidebar') ? options.active() : undefined))
          : undefined;
      if (!owner || !options.canOpenBeside(owner)) {
        setGuide(null);
        return;
      }
      const slot = besideSlot(options.order(), owner);
      setGuide(
        guideAt(
          slot.index,
          slot.existing,
          slot.existing ? `Opens in pane ${slot.index + 1}` : newPaneLabel(slot.index),
        ),
      );
    };
    const release = () => {
      clearTimeout(holdTimer);
      held = false;
      if (!drag?.moving) setGuide(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (drag?.moving && event.key === 'Escape') {
        event.preventDefault();
        endDrag();
        return;
      }
      if (event.key !== modifier || event.repeat) {
        release();
        return;
      }
      if (event.shiftKey || event.altKey) return;
      clearTimeout(holdTimer);
      // A shortcut presses its letter within a moment; only a held modifier previews.
      holdTimer = window.setTimeout(() => {
        held = true;
        previewBeside();
      }, 180);
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key === modifier) release();
    };
    const endDrag = () => {
      drag = null;
      document.documentElement.classList.remove('pane-dragging');
      document.querySelector('.agent-dock')?.classList.remove('drop-target');
      batch(() => {
        setGuide(null);
        setDragChip(null);
      });
    };
    const pointerdown = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        event.pointerType === 'touch' ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const element = event.target instanceof Element ? event.target : null;
      if (!element || element.closest('.cm-editor, input, textarea, [contenteditable="true"], .popup')) return;
      const found = dragTarget(element);
      drag = found ? { x: event.clientX, y: event.clientY, ...found, moving: false } : null;
    };
    const pointermove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (!drag) {
        if (held) previewBeside();
        return;
      }
      if (!drag.moving) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        drag.moving = true;
        document.documentElement.classList.add('pane-dragging');
        getSelection()?.removeAllRanges();
      }
      // Over the agent dock a drop adds the page to what the agent reads.
      const overDock = !!document.elementFromPoint(event.clientX, event.clientY)?.closest('.agent-dock');
      document.querySelector('.agent-dock')?.classList.toggle('drop-target', overDock);
      const zone = overDock ? null : dropAt(event.clientX, event.clientY);
      batch(() => {
        setDragChip({ x: event.clientX, y: event.clientY, label: drag!.label });
        setGuide(zone ? guideForDrop(zone) : null);
      });
    };
    const pointerup = (event: PointerEvent) => {
      if (!drag) return;
      const moved = drag.moving,
        target = drag.target,
        label = drag.label,
        zone = moved ? dropAt(event.clientX, event.clientY) : null;
      const toDock = moved && !!document.elementFromPoint(event.clientX, event.clientY)?.closest('.agent-dock');
      endDrag();
      if (!moved) return;
      // The press that ends a drag is not also a click on whatever lies under it.
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }));
      if (toDock && target.kind === 'page')
        options.addDockContext(
          { page_id: target.pageId, ...(target.blockId ? { block_id: target.blockId } : {}) },
          label,
        );
      if (!zone) return;
      if ('replace' in zone) options.open(target, false, zone.replace);
      else options.open(target, false, options.active(), undefined, zone.insert);
    };
    // After a modifier-click the row may have changed under a still-held modifier.
    const click = () => {
      if (held) requestAnimationFrame(previewBeside);
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('blur', release);
    window.addEventListener('pointerdown', pointerdown, true);
    window.addEventListener('pointermove', pointermove, { passive: true });
    window.addEventListener('pointerup', pointerup, true);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('click', click);
    onCleanup(() => {
      clearTimeout(holdTimer);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('blur', release);
      window.removeEventListener('pointerdown', pointerdown, true);
      window.removeEventListener('pointermove', pointermove);
      window.removeEventListener('pointerup', pointerup, true);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('click', click);
    });
  });

  return { guide, dragChip };
}
