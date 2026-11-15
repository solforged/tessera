import { newTask } from '../../tasks/quick-date';
import { sameState } from '../types';
import type { Edit } from '../contract';
import type { DocumentInternals } from './internals';
import type { EditSession } from './session';

export function editKeptCopy(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'keptCopy' }>,
): void {
  const { actions } = session;
  const block = doc.snapshot(edit.id);
  const copy = block.kept_copy;
  if (!copy) throw new Error('This atom is not a kept copy.');
  if (edit.choice === 'both') {
    actions.push({ kind: 'settleSyncCopy', id: edit.id, settled: true, copy });
  } else {
    doc.guardHide(edit.id);
    if (edit.choice === 'use') {
      if (!doc.block(copy.of)) throw new Error('The original is not on this atom. Both versions are unchanged.');
      actions.push({ kind: 'text', id: copy.of, text: block.text });
    }
    actions.push({ kind: 'delete', id: edit.id });
  }
}

export function editArchive(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'archive' }>,
): void {
  const { actions } = session;
  if (edit.archived) doc.guardHide(edit.id);
  actions.push({ kind: 'archive', id: edit.id, archived: edit.archived });
}

export function editInsert(
  _doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'insert' }>,
): void {
  session.caret = { id: session.insert(edit.parentId, edit.after, edit.text ?? '', null, edit.quote), offset: 0 };
}

export function editDelete(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'delete' }>,
): void {
  const { actions } = session;
  const roots = session.selected(edit.ids);
  let removed = 0;
  for (const id of roots) {
    doc.guardHide(id);
    actions.push({ kind: 'delete', id });
    const at = doc.outline.indexOf(id);
    removed += doc.outline.subtreeEnd(at) - at;
  }
  session.caret =
    removed && removed === doc.outline.size() ? { id: session.insert(doc.pageId, null, ''), offset: 0 } : null;
}

export function editMoveTo(
  _doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'moveTo' }>,
): void {
  session.move(session.selected(edit.ids), edit.parentId, edit.after);
}

export function editIndent(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'indent' }>,
): void {
  const ids = session.selected(edit.ids, edit.zoomRoot);
  if (!ids.length) return;
  const parent = doc.outline.previousSibling(ids[0]!);
  if (!parent) return;
  session.move(ids, parent, doc.outline.children(parent).at(-1) ?? null);
}

export function editOutdent(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'outdent' }>,
): void {
  const { actions } = session;
  const ids = session.selected(edit.ids, edit.zoomRoot);
  if (!ids.length) return;
  const parent = doc.outline.parentOf(ids[0]!);
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const owner = doc.outline.parentOf(id);
    if (owner === doc.pageId || owner === edit.zoomRoot) continue;
    const group = groups.get(owner) ?? [];
    group.push(id);
    groups.set(owner, group);
  }
  for (const [owner, roots] of groups) session.move(roots, doc.outline.parentOf(owner), owner);
  // An empty todo that Enter continued leaves the task list with its indent: below a plain line it becomes a plain line.
  const only = ids.length === 1 ? doc.snapshot(ids[0]!) : null;
  const task = only && doc.block(only.id)?.task;
  if (
    only &&
    groups.size &&
    task &&
    !only.text &&
    !doc.outline.children(only.id).length &&
    !doc.block(parent)?.task &&
    sameState(task, newTask('todo'))
  )
    actions.push({
      kind: 'task',
      id: only.id,
      value: null,
      previous: doc.capabilities(only.id).task,
      baseRevision: only.revision,
    });
}

export function editMove(doc: DocumentInternals, session: EditSession, edit: Extract<Edit, { kind: 'move' }>): void {
  const ids = session.selected(edit.ids, edit.zoomRoot);
  if (!ids.length) return;
  const parent = doc.outline.parentOf(ids[0]!);
  if (ids.some(id => doc.outline.parentOf(id) !== parent)) return;
  const siblings = doc.outline.children(parent);
  const first = siblings.indexOf(ids[0]!);
  const last = siblings.indexOf(ids.at(-1)!);
  if (edit.direction === 'up') {
    if (first <= 0) return;
    session.move(ids, parent, siblings[first - 2] ?? null);
  } else {
    if (last + 1 >= siblings.length) return;
    session.move(ids, parent, siblings[last + 1]!);
  }
}
