import { ulid } from 'ulid';
import { markdownPasteRows } from '../clipboard';
import { splitToken } from './session';
import type { Edit } from '../contract';
import type { DocumentInternals } from './internals';
import type { EditSession } from './session';

export function editPositionLinks(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'positionLinks' }>,
): void {
  session.setText(doc.snapshot(edit.id), edit.text);
}

export function editText(doc: DocumentInternals, session: EditSession, edit: Extract<Edit, { kind: 'text' }>): void {
  const { actions } = session;
  if (doc.snapshot(edit.id).text !== edit.text || edit.relationPick)
    actions.push({
      kind: 'text',
      id: edit.id,
      text: edit.text,
      ...(edit.relationPick ? { relationPick: edit.relationPick } : {}),
    });
  if (edit.heading !== undefined && doc.snapshot(edit.id).heading !== edit.heading)
    actions.push({ kind: 'heading', id: edit.id, heading: edit.heading });
  if (edit.caret !== undefined)
    session.caret = { id: edit.id, offset: Math.max(0, Math.min(edit.text.length, edit.caret)) };
}

export function editHeading(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'heading' }>,
): void {
  const { actions } = session;
  const targets = 'ids' in edit ? edit.ids : [edit.id];
  for (const id of new Set(targets)) {
    if (doc.snapshot(id).heading === edit.level) continue;
    actions.push({ kind: 'heading', id, heading: edit.level });
  }
}

export function editSplit(doc: DocumentInternals, session: EditSession, edit: Extract<Edit, { kind: 'split' }>): void {
  const old = doc.snapshot(edit.id);
  if (old.kind !== 'block') throw new Error('Only outline notes can split.');
  const at = Math.max(0, Math.min(edit.offset, old.text.length));
  const offset = splitToken(old.text, at)?.end ?? at;
  session.split(old, old.text.slice(0, offset), old.text.slice(offset), edit.zoomRoot, edit.fieldEntry);
}

export function editMerge(doc: DocumentInternals, session: EditSession, edit: Extract<Edit, { kind: 'merge' }>): void {
  const { actions } = session;
  const source = doc.snapshot(edit.sourceId);
  const destination = doc.snapshot(edit.destinationId);
  if (source.kind !== 'block') throw new Error('A titled note cannot merge into an outline note.');
  let parent = destination.id;
  while (parent !== doc.pageId) {
    if (parent === source.id) throw new Error('Cannot merge into a descendant.');
    parent = doc.outline.parentOf(parent);
  }
  for (let ancestor: string | null = destination.id; ancestor; ancestor = doc.block(ancestor)?.parentId ?? null)
    if (doc.block(ancestor)?.archived) {
      doc.guardHide(source.id);
      break;
    }
  doc.guardMerge(source.id);
  if (doc.block(destination.id)?.image) throw new Error("Image notes can't be merged.");
  actions.push({
    kind: 'merge',
    id: source.id,
    destinationId: destination.id,
    text: destination.text + source.text,
  });
  session.caret = { id: destination.id, offset: destination.text.length };
}

export function editDeleteRange(
  _doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'deleteRange' }>,
): void {
  session.replace(edit.range, edit.between, '', 'text');
}

export function editReplaceRange(
  _doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'replaceRange' }>,
): void {
  session.replace(edit.range, edit.between, edit.text, edit.mode, edit.zoomRoot, edit.fieldEntry);
}

export function editPaste(doc: DocumentInternals, session: EditSession, edit: Extract<Edit, { kind: 'paste' }>): void {
  const block = doc.snapshot(edit.at.id);
  session.paste(
    block,
    block.text.slice(0, edit.at.offset),
    block.text.slice(edit.at.offset),
    markdownPasteRows(edit.text),
  );
}

export function editPasteRows(
  _doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'pasteRows' }>,
): void {
  if (!edit.rows.length) return;
  if (edit.replaceRoots?.length)
    session.paste(session.rowPasteTarget(edit.replaceRoots, edit.zoomRoot), '', '', edit.rows);
  else session.replace(edit.range, edit.between, '', 'paste', edit.zoomRoot, undefined, edit.rows);
}

export function editPasteBlocks(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'pasteBlocks' }>,
): void {
  const { actions } = session;
  const content = edit.content;
  if (!content.blocks.length) return;
  const replacing = edit.replaceRoots?.length ? session.selected(edit.replaceRoots, edit.zoomRoot) : null;
  if (replacing && replacing.length !== edit.replaceRoots!.length)
    throw new Error('The selected rows changed before paste.');
  let { anchor: start, head: end } = replacing
    ? {
        anchor: { id: replacing[0]!, offset: 0 },
        head: { id: replacing.at(-1)!, offset: doc.block(replacing.at(-1)!)!.text.length },
      }
    : edit.range;
  if (doc.outline.indexOf(start.id) > doc.outline.indexOf(end.id) || (start.id === end.id && start.offset > end.offset))
    [start, end] = [end, start];
  const target = doc.snapshot(start.id);
  const last = doc.snapshot(end.id);
  const prefix = replacing ? '' : target.text.slice(0, start.offset);
  const suffix = replacing ? '' : last.text.slice(end.offset);
  const zoom = !replacing && edit.zoomRoot === target.id;
  if (replacing) {
    for (const id of replacing) {
      doc.guardHide(id);
      actions.push({ kind: 'delete', id });
    }
  } else {
    if (!zoom) session.guardSplit(target, prefix, suffix);
    session.replace(edit.range, edit.between, '', 'text', edit.zoomRoot);
  }
  const parentId = zoom ? target.id : target.parent_id!;
  const depth = zoom ? doc.outline.depth(target.id) + 1 : doc.outline.depth(target.id);
  const emptyLeaf =
    !replacing &&
    start.id === end.id &&
    !prefix &&
    !suffix &&
    !zoom &&
    !doc.outline.children(target.id).length &&
    !doc.capabilities(target.id).merge_protected;
  let after = zoom ? null : !prefix || emptyLeaf ? doc.outline.previousSibling(target.id) : target.id;
  if (emptyLeaf) actions.push({ kind: 'delete', id: target.id });
  else if (!zoom && prefix && suffix) session.setText({ ...target, text: prefix + suffix }, prefix);
  const roots = content.blocks.filter(item => item.depth === 0);
  const moving = content.cut && content.scope === doc.host.clipboardScope();
  if (moving && !doc.host.canRestore(roots.map(item => item.block.id)))
    throw new Error('Prepare this cut before pasting it.');
  if (moving) {
    for (let at = 0; at < content.blocks.length; ) {
      let end = at + 1;
      while (end < content.blocks.length && content.blocks[end]!.depth > 0) end++;
      const root = content.blocks[at]!;
      const snapshots = content.blocks.slice(at, end).map(item => {
        const parent = item.depth === 0 ? parentId : item.block.parent_id!;
        return {
          block: { ...item.block, parent_id: parent, page_id: doc.pageId },
          row: { id: item.block.id, parentId: parent, depth: depth + item.depth },
          manual_types: [...item.manualTypes],
          capabilities: item.capabilities,
        };
      });
      actions.push({ kind: 'restore', id: root.block.id, snapshots, after });
      actions.push({ kind: 'move', id: root.block.id, parentId, after });
      after = root.block.id;
      at = end;
    }
    const tail = content.blocks.at(-1)!.block;
    session.caret = { id: tail.id, offset: tail.text.length };
  } else {
    const stack: string[] = [];
    const previous = new Map<string, string>();
    for (const item of content.blocks) {
      const parent = item.depth ? stack[item.depth - 1]! : parentId;
      if (!parent) throw new Error('The clipboard hierarchy is invalid.');
      const id = session.insert(
        parent,
        item.depth ? (previous.get(parent) ?? null) : after,
        item.block.text,
        item.block.heading,
      );
      if (content.scope === doc.host.clipboardScope() && item.capabilities.image)
        actions.push({
          kind: 'image',
          id,
          value: structuredClone(item.capabilities.image),
          previous: null,
          baseRevision: 0,
        });
      if (content.scope === doc.host.clipboardScope() && item.capabilities.image && item.capabilities.occlusion)
        actions.push({
          kind: 'occlusion',
          id,
          value: structuredClone(item.capabilities.occlusion),
          previous: null,
          baseRevision: 0,
        });
      if (item.capabilities.task) {
        const task = item.capabilities.task;
        const value = task.status === 'done' ? { ...task, status: 'todo' as const, completed_on: null } : task;
        actions.push({ kind: 'task', id, value, previous: null, baseRevision: 0 });
        if (task.status === 'done')
          actions.push({
            kind: 'completeTask',
            id,
            occurrenceId: ulid(),
            completedOn: task.completed_on!,
            previous: value,
            baseRevision: 0,
          });
      }
      for (const title of item.manualTypes) actions.push({ kind: 'addType', id, title });
      if (item.block.archived) actions.push({ kind: 'archive', id, archived: true });
      stack[item.depth] = id;
      stack.length = item.depth + 1;
      previous.set(parent, id);
      if (!item.depth) after = id;
      session.caret = { id, offset: item.block.text.length };
    }
  }
  if (!zoom && prefix && suffix) session.insert(parentId, after, suffix, target.heading);
}
