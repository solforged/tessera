import { ulid } from 'ulid';
import type { Block, QuoteState } from '../../api/types';
import { markdownPasteRows } from '../clipboard';
import type { Caret, HistoryCaret, PasteRow, TextRange } from '../contract';
import { parseCardText } from '../../review/card-text';
import { newTask } from '../../tasks/quick-date';
import { quoteTarget, textTokens } from '../text-tokens';
import { titleKey } from '../title-key';
import type { Action } from '../types';
import type { DocumentInternals } from './internals';

/** The reference or tag holding `offset` strictly inside it, where Enter must not cut. */
export const splitToken = (text: string, offset: number) =>
  textTokens(text).find(
    token => (token.kind === 'reference' || token.kind === 'tag') && offset > token.start && offset < token.end,
  );

/** Mutable actions, caret and shared helpers for one `Document.edit` call. */
export class EditSession {
  readonly actions: Action[] = [];
  caret: Caret | null;
  readonly created: string[] = [];
  readonly caretBefore: HistoryCaret | null;

  constructor(
    readonly doc: DocumentInternals,
    caretBefore: HistoryCaret | null,
  ) {
    this.caretBefore = caretBefore;
    this.caret = caretBefore ? { id: caretBefore.id, offset: caretBefore.offset } : null;
  }

  insert(parentId: string, after: string | null, text: string, heading: 1 | 2 | 3 | null = null, quote?: QuoteState) {
    if (!this.doc.block(parentId) && !this.created.includes(parentId)) throw new Error('The parent no longer exists.');
    const id = ulid();
    this.created.push(id);
    this.actions.push({
      kind: 'insert',
      after,
      block: {
        id,
        kind: 'block',
        parent_id: parentId,
        page_id: this.doc.pageId,
        text,
        heading,
        archived: false,
        kept_copy: null,
        revision: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    });
    if (quote) {
      if (quoteTarget(text) !== quote.target_id || quote.target_id === id)
        throw new Error('Quote target must match a different atom.');
      this.actions.push({ kind: 'quote', id, value: structuredClone(quote), previous: null, baseRevision: 0 });
    }
    return id;
  }

  selected(ids: string[], zoomRoot?: string | null) {
    const set = new Set(ids);
    if (zoomRoot) {
      const start = this.doc.outline.indexOf(zoomRoot);
      if (start < 0) return [];
      const end = this.doc.outline.subtreeEnd(start);
      if (
        ids.some(id => {
          const at = this.doc.outline.indexOf(id);
          return at <= start || at >= end;
        })
      )
        return [];
    }
    return ids
      .filter(id => {
        if (this.doc.outline.indexOf(id) < 0) throw new Error('A selected atom no longer exists.');
        let parent = this.doc.outline.parentOf(id);
        while (parent !== this.doc.pageId) {
          if (set.has(parent)) return false;
          parent = this.doc.outline.parentOf(parent);
        }
        return true;
      })
      .sort((a, b) => this.doc.outline.indexOf(a) - this.doc.outline.indexOf(b));
  }

  move(ids: string[], parentId: string, after: string | null) {
    for (const id of ids) {
      let parent = parentId;
      while (parent !== this.doc.pageId) {
        if (parent === id) throw new Error('An atom cannot move into its own subtree.');
        if (!this.doc.block(parent)) throw new Error('The destination no longer exists.');
        parent = this.doc.outline.parentOf(parent);
      }
      if (after && !ids.includes(after) && this.doc.outline.parentOf(after) !== parentId)
        throw new Error('The destination sibling no longer exists.');
      for (let ancestor: string | null = parentId; ancestor; ancestor = this.doc.block(ancestor)?.parentId ?? null)
        if (this.doc.block(ancestor)?.archived) {
          this.doc.guardHide(id);
          break;
        }
      this.actions.push({ kind: 'move', id, parentId, after });
      after = id;
    }
  }

  setText(block: Block, text: string) {
    if (block.text !== text) this.actions.push({ kind: 'text', id: block.id, text });
  }

  removeCapabilityTags(id: string, name: string) {
    // The behavior operation owns written-token removal and its text receipt.
    // Keep manual removals in history too, so undo restores both origins.
    for (const title of this.doc.block(id)?.manual_types ?? []) {
      if (titleKey(title) === name) this.actions.push({ kind: 'removeType', id, title });
    }
  }

  guardSplit(block: Block, prefix: string, suffix: string) {
    if (!parseCardText(block.text).cards.length || (!suffix && prefix === block.text)) return;
    if (prefix || this.doc.block(block.id)?.reviewedCards)
      throw new Error('This split would divide or move a card. Keep its source in one atom.');
  }

  split(block: Block, prefix: string, suffix: string, zoomRoot?: string | null, fieldEntry?: string | null) {
    if (this.doc.block(block.id)?.image && !prefix && suffix) {
      this.caret = { id: this.insert(block.parent_id!, block.id, ''), offset: 0 };
      return;
    }
    const task = this.doc.block(block.id)?.task;
    if (!prefix && suffix) {
      this.setText(block, suffix);
      if (zoomRoot === block.id) this.insert(block.id, null, '');
      else this.insert(block.parent_id!, this.doc.outline.previousSibling(block.id), '');
      this.caret = { id: block.id, offset: 0 };
      return;
    }
    if (
      fieldEntry &&
      fieldEntry === block.parent_id &&
      zoomRoot !== block.id &&
      zoomRoot !== fieldEntry &&
      !prefix &&
      !suffix &&
      !this.doc.outline.children(block.id).length
    ) {
      this.doc.guardHide(block.id);
      this.actions.push({ kind: 'delete', id: block.id });
      this.caret = { id: this.insert(this.doc.outline.parentOf(fieldEntry), fieldEntry, ''), offset: 0 };
      return;
    }
    if (task?.status === 'todo' && !prefix && !suffix && !this.doc.outline.children(block.id).length) {
      this.setText(block, '');
      this.actions.push({
        kind: 'task',
        id: block.id,
        value: null,
        previous: this.doc.capabilities(block.id).task,
        baseRevision: block.revision,
      });
      this.caret = { id: block.id, offset: 0 };
      return;
    }
    if (!task && block.heading !== null && !prefix && !suffix) {
      this.setText(block, '');
      this.actions.push({ kind: 'heading', id: block.id, heading: null });
      this.caret = { id: block.id, offset: 0 };
      return;
    }
    this.guardSplit(block, prefix, suffix);
    this.setText(block, prefix + suffix);
    const child =
      zoomRoot === block.id ||
      (!suffix &&
        (this.doc.outline.children(block.id).length > 0 ||
          parseCardText(block.text).cards.some(card => card.kind === 'multiline' || card.kind === 'list')));
    const id = this.insert(block.parent_id!, block.id, suffix, block.heading);
    const insertion = this.actions.pop() as Extract<Action, { kind: 'insert' }>;
    this.actions.push({ kind: 'split', id: block.id, block: insertion.block, left: prefix, right: suffix });
    if (child) this.actions.push({ kind: 'move', id, parentId: block.id, after: null });
    if (!suffix && block.heading !== null) this.actions.push({ kind: 'heading', id, heading: null });
    if (task?.status) this.actions.push({ kind: 'task', id, value: newTask('todo'), previous: null, baseRevision: 0 });
    this.caret = { id, offset: 0 };
  }

  paste(block: Block, prefix: string, suffix: string, rows: PasteRow[], zoomRoot?: string | null) {
    if (!rows.length) return;
    const style = (id: string, row: PasteRow, previousHeading: Block['heading'], revision: number) => {
      if (row.heading !== null && row.heading !== previousHeading)
        this.actions.push({ kind: 'heading', id, heading: row.heading });
      if (row.task) {
        const previous = this.doc.block(id)?.task ?? null;
        const value = previous ?? newTask('todo');
        if (!previous) this.actions.push({ kind: 'task', id, value, previous: null, baseRevision: revision });
        if (row.task === 'done' && value.status !== 'done')
          this.actions.push({
            kind: 'completeTask',
            id,
            occurrenceId: ulid(),
            completedOn: this.doc.host.todayDate(),
            previous: value,
            baseRevision: revision,
          });
      }
    };
    const first = rows[0]!;
    if (rows.length === 1) {
      this.setText(block, prefix + first.text + suffix);
      if (!prefix) style(block.id, first, block.heading, block.revision);
      this.caret = { id: block.id, offset: prefix.length + first.text.length };
      return;
    }
    this.guardSplit(block, prefix, suffix);
    this.setText(block, prefix + suffix);
    const rightId = ulid();
    this.created.push(rightId);
    const right: Block = { ...block, id: rightId, text: suffix, revision: 0, heading: block.heading };
    this.actions.push({ kind: 'split', id: block.id, block: right, left: prefix, right: suffix });
    this.setText({ ...block, text: prefix }, prefix + first.text);
    if (!prefix) style(block.id, first, block.heading, block.revision);
    const zoom = zoomRoot === block.id;
    const stack = [{ width: first.indent, id: block.id, parentId: zoom ? block.id : block.parent_id! }];
    let zoomAfter: string | null = null;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!;
      const width = row.indent;
      while (stack.length > 1 && width < stack.at(-1)!.width) stack.pop();
      const previous = stack.at(-1)!;
      const nested = width > previous.width;
      const parentId = nested ? previous.id : previous.parentId;
      const after = zoom && parentId === block.id ? zoomAfter : nested ? null : previous.id;
      const body = row.text + (i === rows.length - 1 ? suffix : '');
      let id: string;
      if (i === 1) {
        id = rightId;
        if (parentId !== block.parent_id || after !== block.id)
          this.actions.push({ kind: 'move', id, parentId, after });
        this.setText(right, body);
        if (right.heading !== null) this.actions.push({ kind: 'heading', id, heading: null });
      } else id = this.insert(parentId, after, body);
      style(id, row, null, 0);
      if (zoom && parentId === block.id) zoomAfter = id;
      if (!nested) stack.pop();
      stack.push({ width, id, parentId });
      this.caret = { id, offset: row.text.length };
    }
  }

  replace(
    range: TextRange,
    visible: string[],
    text: string,
    mode: 'text' | 'paste' | 'split',
    zoomRoot?: string | null,
    fieldEntry?: string | null,
    rows?: PasteRow[],
  ) {
    let { anchor: start, head: end } = range;
    if (this.doc.outline.indexOf(start.id) < 0 || this.doc.outline.indexOf(end.id) < 0)
      throw new Error('A selected atom no longer exists.');
    if (
      this.doc.outline.indexOf(start.id) > this.doc.outline.indexOf(end.id) ||
      (start.id === end.id && start.offset > end.offset)
    )
      [start, end] = [end, start];
    const first = this.doc.snapshot(start.id);
    const last = this.doc.snapshot(end.id);
    let startOffset = Math.max(0, Math.min(start.offset, first.text.length));
    let endOffset = Math.max(0, Math.min(end.offset, last.text.length));
    if (mode === 'split' && start.id === end.id && startOffset === endOffset)
      startOffset = endOffset = splitToken(first.text, startOffset)?.end ?? startOffset;
    else if (mode === 'split') {
      startOffset = splitToken(first.text, startOffset)?.start ?? startOffset;
      endOffset = splitToken(last.text, endOffset)?.end ?? endOffset;
    }
    if (mode === 'text' && !text && (start.id !== end.id || startOffset !== endOffset)) {
      for (const token of textTokens(first.text))
        if (token.kind === 'reference' && startOffset > token.start && startOffset < token.end)
          startOffset = token.start;
      for (const token of textTokens(last.text))
        if (token.kind === 'reference' && endOffset > token.start && endOffset < token.end) endOffset = token.end;
    }
    const between = this.doc.outline
      .slice(this.doc.outline.indexOf(start.id) + 1, this.doc.outline.indexOf(end.id))
      .map(row => row.id);
    if (between.length !== visible.length || between.some((id, i) => id !== visible[i]))
      throw new Error('Expand hidden atoms before deleting this text range.');
    if (start.id !== end.id) this.doc.guardMerge(end.id);
    if (start.id !== end.id && this.doc.block(start.id)?.image) throw new Error("Image atoms can't be merged.");
    const multiline = mode === 'split' || (mode === 'paste' && (rows ? rows.length > 1 : /[\r\n]/.test(text)));
    if (
      multiline &&
      (parseCardText(first.text).cards.length || (start.id !== end.id && parseCardText(last.text).cards.length)) &&
      !(
        start.id === end.id &&
        startOffset === endOffset &&
        (endOffset === first.text.length || (mode === 'split' && startOffset === 0))
      )
    ) {
      throw new Error('Replace this card in place before splitting its source.');
    }
    const deleted = start.id === end.id ? [] : this.selected([...between, end.id]);
    const removed = new Set([...between, end.id]);
    const preserved: string[] = [];
    for (const id of deleted) {
      const at = this.doc.outline.indexOf(id);
      for (const row of this.doc.outline.slice(at, this.doc.outline.subtreeEnd(at))) {
        if (!removed.has(row.id) && removed.has(row.parentId)) preserved.push(row.id);
      }
    }
    const prefix = first.text.slice(0, startOffset);
    const suffix = last.text.slice(endOffset);
    if (preserved.length) {
      let after: string | null = this.doc.outline.children(first.id).at(-1) ?? null;
      if (this.doc.outline.indexOf(end.id) < this.doc.outline.subtreeEnd(this.doc.outline.indexOf(first.id))) {
        after = end.id;
        while (this.doc.outline.parentOf(after) !== first.id) after = this.doc.outline.parentOf(after);
      }
      this.move(preserved, first.id, after);
    }
    if (start.id !== end.id)
      this.actions.push({ kind: 'merge', id: end.id, destinationId: first.id, text: first.text + last.text });
    for (const id of deleted)
      if (id !== end.id) {
        this.doc.guardHide(id);
        this.actions.push({ kind: 'delete', id });
      }
    const merged = start.id === end.id ? first : { ...first, text: first.text + last.text };
    if (mode === 'split') this.split(merged, prefix + text, suffix, zoomRoot, fieldEntry);
    else if (mode === 'paste') this.paste(merged, prefix, suffix, rows ?? markdownPasteRows(text), zoomRoot);
    else {
      this.setText(merged, prefix + text + suffix);
      this.caret = { id: first.id, offset: prefix.length + text.length };
    }
  }

  rowPasteTarget(ids: string[], zoomRoot?: string | null): Block {
    const roots = this.selected(ids, zoomRoot);
    if (!roots.length || roots.length !== ids.length) throw new Error('The selected rows changed before paste.');
    const first = this.doc.snapshot(roots[0]!);
    for (const id of roots) this.doc.guardHide(id);
    const after = this.doc.outline.previousSibling(first.id);
    // Capture deletion inverses before a replacement can become their predecessor.
    for (const root of roots) this.actions.push({ kind: 'delete', id: root });
    this.insert(first.parent_id!, after, '');
    const insertion = this.actions.at(-1) as Extract<Action, { kind: 'insert' }>;
    return insertion.block;
  }
}
