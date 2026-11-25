import { ulid } from 'ulid';
import type { Operation } from '../api/types';
import type { DocumentChange, SourceDetailsEdit, WorkshopClient } from '../document/contract';
import type { Document } from '../document/page-document';
import type { Action } from '../document/types';

type SourceCommandPart = { pageId: string; actions: Action[]; expected?: string; stale?: boolean };

export interface SourceActionsHost extends WorkshopClient {
  flushPage(pageId: string): Promise<void>;
  compilePageActions(pageId: string, actions: readonly Action[]): Operation[];
}

const queues = new WeakMap<WorkshopClient, Promise<unknown>>();

function serializeSourceChange<T>(workshop: WorkshopClient, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(workshop) ?? Promise.resolve();
  const result = previous.then(work, work);
  queues.set(
    workshop,
    result.catch(() => undefined),
  );
  return result;
}

async function commitSourceActions(
  workshop: SourceActionsHost,
  parts: readonly SourceCommandPart[],
): Promise<SourceCommandPart[]> {
  const docs = parts.map(part => workshop.open(part.pageId) as Document);
  try {
    await Promise.all(
      docs.map(async doc => {
        if (doc.status() === 'loading') await doc.reload(false);
        await doc.flush();
        if (doc.status() !== 'ready') throw new Error(doc.statusMessage() || 'This atom is not ready.');
      }),
    );
    const operations: Operation[] = [];
    const inverse: SourceCommandPart[] = parts.map((part, index) => {
      const doc = docs[index]!;
      if (part.stale || (part.expected !== undefined && doc.sourceActionsState(part.actions) !== part.expected))
        throw new Error('The field changed since this edit. Its current value was kept.');
      const actions = part.actions.map(action =>
        action.kind === 'source' ? { ...action, baseRevision: doc.root()!.revision } : action,
      );
      const inverseActions = doc.sourceActionsInverse(actions);
      operations.push(...workshop.compilePageActions(part.pageId, actions));
      return { pageId: part.pageId, actions: inverseActions, expected: '' };
    });
    const ack = operations.length
      ? await workshop.commit(
          operations,
          undefined,
          parts.map(part => part.pageId),
          { retainRejection: false },
        )
      : undefined;
    for (let index = 0; index < inverse.length; index++) {
      const doc = docs[index]!;
      const part = inverse[index]!;
      part.expected = doc.sourceActionsState(part.actions);
      // A page refresh may already contain edits newer than this receipt. Never
      // bless those values as this command's own values for a subsequent undo.
      part.stale = ack?.revisions.some(({ id, revision }) => {
        const block = doc.block(id);
        return block !== undefined && (block.pending || block.revision > revision);
      });
    }
    return inverse;
  } finally {
    for (const doc of docs) doc.release();
  }
}

export async function editSourceDetails(
  workshop: SourceActionsHost,
  edits: readonly { pageId: string; edit: SourceDetailsEdit }[],
): Promise<DocumentChange> {
  let next = await serializeSourceChange(workshop, async () => {
    const docs = edits.map(({ pageId }) => workshop.open(pageId) as Document);
    try {
      await Promise.all(
        docs.map(async doc => {
          if (doc.status() === 'loading') await doc.reload(false);
          await doc.flush();
        }),
      );
      const parts = edits.map(({ pageId, edit }, index) => {
        const doc = docs[index]!;
        const actions = doc.sourceDetailsActions(edit);
        return { pageId, actions, expected: doc.sourceActionsState(actions) };
      });
      return await commitSourceActions(workshop, parts);
    } finally {
      for (const doc of docs) doc.release();
    }
  });
  let applied = true;
  const travel = (undo: boolean) =>
    serializeSourceChange(workshop, async () => {
      if (applied !== undo) return;
      next = await commitSourceActions(workshop, next);
      applied = !undo;
    });
  return { undo: () => travel(true), redo: () => travel(false) };
}

export async function integrateBlock(
  workshop: SourceActionsHost,
  id: string,
  destinationId: string,
): Promise<DocumentChange> {
  return serializeSourceChange(workshop, async () => {
    const source = await workshop.api.block(id),
      destination = await workshop.api.block(destinationId);
    const pages = [...new Set([source.page_id, destination.page_id])];
    const docs = pages.map(pageId => workshop.open(pageId) as Document);
    try {
      await Promise.all(
        docs.map(async doc => {
          if (doc.status() === 'loading') await doc.reload(false);
          await doc.flush();
        }),
      );
      const sourceDoc = docs[pages.indexOf(source.page_id)]!;
      const destinationDoc = docs[pages.indexOf(destination.page_id)]!;
      if (sourceDoc.root()?.kind !== 'journal' || source.kind !== 'block')
        throw new Error('Integrate an atom from a journal day.');
      const block = await workshop.api.block(id);
      if (!block.parent_id || block.page_id !== source.page_id)
        throw new Error('The atom moved while choosing its destination.');
      const parentId = block.parent_id;
      const siblings = sourceDoc.outline.children(parentId);
      const after = siblings[siblings.indexOf(id) - 1] ?? null;
      let ancestor: string | null = destinationId;
      while (ancestor) {
        if (ancestor === id) throw new Error('An atom cannot move into its own subtree.');
        ancestor = destinationDoc.block(ancestor)?.parentId ?? null;
      }
      const referenceId = ulid();
      const referenceText = `[[${id}]]`;
      let applied = false,
        deletionId: string | undefined,
        referenceRevision = 0;
      const travel = async (forward: boolean) => {
        if (applied === forward) return;
        const opened = pages.map(pageId => workshop.open(pageId) as Document);
        try {
          await Promise.all(
            opened.map(async doc => {
              if (doc.status() === 'loading') await doc.reload(false);
              await doc.flush();
            }),
          );
          const current = await workshop.api.block(id);
          if (current.parent_id !== (forward ? parentId : destinationId))
            throw new Error('The atom moved since this change. Its current place was kept.');
          const operations: Operation[] = [];
          if (forward) {
            const dest = opened[pages.indexOf(destination.page_id)]!;
            const last =
              dest.outline
                .children(destinationId)
                .filter(child => child !== id)
                .at(-1) ?? null;
            operations.push({
              op: 'move',
              id,
              base_revision: current.revision,
              parent_id: destinationId,
              after: last,
            });
            operations.push(
              deletionId
                ? { op: 'restore', id: referenceId, deletion_id: deletionId, revision: referenceRevision }
                : { op: 'insert', id: referenceId, parent_id: parentId, after, text: referenceText, heading: null },
            );
          } else {
            const reference = await workshop.api.block(referenceId);
            if (
              reference.revision !== referenceRevision ||
              reference.text !== referenceText ||
              reference.parent_id !== parentId
            )
              throw new Error('The journal reference changed. Its current text was kept.');
            operations.push({ op: 'delete', id: referenceId, base_revision: reference.revision });
            operations.push({ op: 'move', id, base_revision: current.revision, parent_id: parentId, after });
          }
          const receipt = await workshop.commit(
            operations,
            forward ? 'Integrate journal atom' : 'Undo integration',
            pages,
            { retainRejection: false },
          );
          referenceRevision = receipt.revisions.find(value => value.id === referenceId)!.revision;
          if (!forward) deletionId = receipt.deletions[0];
          applied = forward;
        } finally {
          for (const doc of opened) doc.release();
        }
      };
      await travel(true);
      return {
        undo: () => serializeSourceChange(workshop, () => travel(false)),
        redo: () => serializeSourceChange(workshop, () => travel(true)),
      };
    } finally {
      for (const doc of docs) doc.release();
    }
  });
}

export async function moveBlocks(
  workshop: SourceActionsHost,
  ids: readonly string[],
  destinationId: string,
): Promise<DocumentChange> {
  return serializeSourceChange(workshop, async () => {
    if (!ids.length) throw new Error('Select atoms to move.');
    const first = await workshop.api.block(ids[0]!);
    if (first.page_id === destinationId) throw new Error('Choose another atom.');
    const pages = [first.page_id, destinationId];
    const opened = pages.map(pageId => workshop.open(pageId) as Document);
    try {
      // A pending move may already own the page's external history boundary.
      await Promise.all(
        opened.map(async doc => {
          if (doc.status() === 'loading') await doc.reload(false);
          await workshop.flushPage(doc.pageId);
        }),
      );
      const source = await workshop.api.page(first.page_id);
      const destination = await workshop.api.block(destinationId);
      if (destination.kind !== 'page') throw new Error('Choose a titled atom.');
      const selected = new Set(ids);
      const blocks = new Map(source.rows.map(row => [row.block.id, row.block]));
      const predecessors = new Map<string, string | null>();
      const previous = new Map<string, string>();
      for (const { block } of source.rows) {
        predecessors.set(block.id, previous.get(block.parent_id!) ?? null);
        previous.set(block.parent_id!, block.id);
      }
      if (ids.some(id => !blocks.has(id))) throw new Error('A selected atom moved or was deleted.');
      const roots = source.rows
        .filter(({ block }) => {
          if (!selected.has(block.id)) return false;
          for (
            let parent = block.parent_id;
            parent && parent !== source.root.id;
            parent = blocks.get(parent)?.parent_id ?? null
          )
            if (selected.has(parent)) return false;
          return true;
        })
        .map(({ block }) => ({ id: block.id, parentId: block.parent_id!, after: predecessors.get(block.id)! }));
      let applied = false;
      const travel = async (forward: boolean) => {
        if (applied === forward) return;
        const docs = pages.map(pageId => workshop.open(pageId) as Document);
        try {
          // This transaction can itself be the page's pending external history entry.
          await Promise.all(
            docs.map(async doc => {
              if (doc.status() === 'loading') await doc.reload(false);
              await workshop.flushPage(doc.pageId);
            }),
          );
          const current = await Promise.all(roots.map(root => workshop.api.block(root.id)));
          if (
            current.some(
              (block, index) =>
                block.parent_id !== (forward ? roots[index]!.parentId : destinationId) ||
                block.page_id !== (forward ? first.page_id : destinationId),
            )
          )
            throw new Error('An atom moved since this change. Its current place was kept.');
          const target = forward ? await workshop.api.page(destinationId) : null;
          let after = target?.rows.filter(row => row.depth === 0).at(-1)?.block.id ?? null;
          const operations: Operation[] = roots.map((root, index) => {
            const operation: Operation = {
              op: 'move',
              id: root.id,
              base_revision: current[index]!.revision,
              parent_id: forward ? destinationId : root.parentId,
              after: forward ? after : root.after,
            };
            after = root.id;
            return operation;
          });
          await workshop.commit(operations, forward ? 'Move atoms' : 'Undo atom move', pages, {
            retainRejection: false,
          });
          applied = forward;
        } finally {
          for (const doc of docs) doc.release();
        }
      };
      await travel(true);
      return {
        undo: () => serializeSourceChange(workshop, () => travel(false)),
        redo: () => serializeSourceChange(workshop, () => travel(true)),
      };
    } finally {
      for (const doc of opened) doc.release();
    }
  });
}

export async function promoteToProject(
  workshop: SourceActionsHost,
  id: string,
  title: string,
): Promise<{ pageId: string; change: DocumentChange }> {
  return serializeSourceChange(workshop, async () => {
    const name = title.trim();
    if (!name) throw new Error('Name the project before making it one.');
    const source = await workshop.api.block(id);
    const journal = workshop.open(source.page_id) as Document;
    try {
      if (journal.status() === 'loading') await journal.reload(false);
      await journal.flush();
      if (journal.root()?.kind !== 'journal' || source.kind !== 'block')
        throw new Error('Promote an atom from a journal day.');
      const row = await workshop.api.block(id);
      if (row.page_id !== source.page_id) throw new Error('The atom moved while making it a project.');
      const children = [...journal.outline.children(id)];
      const found = await workshop.pageByTitle(name, false);
      const existing = found ? await workshop.api.block(found) : null;
      if (existing && existing.kind !== 'page') throw new Error(`“${name}” names a journal day.`);
      const pageId = existing?.id ?? ulid();
      const wasProject = !!existing && (await workshop.api.projects()).some(project => project.block_id === pageId);
      const originalText = row.text;
      const linkText = `[[${pageId}]]`;
      const pages = [source.page_id, pageId];
      const created = !existing;
      let applied = false,
        deletionId: string | undefined,
        pageRevision = 0;
      const travel = async (forward: boolean) => {
        if (applied === forward) return;
        const operations: Operation[] = [];
        const current = await workshop.api.block(id);
        if (forward) {
          if (current.text !== originalText)
            throw new Error('The journal atom changed since this change. Its current text was kept.');
          if (created)
            operations.push(
              deletionId
                ? { op: 'restore', id: pageId, deletion_id: deletionId, revision: pageRevision }
                : { op: 'create_page', id: pageId, title: name },
            );
          if (!wasProject && !deletionId)
            operations.push({
              op: 'set_project',
              id: pageId,
              base_revision: created ? 1 : (await workshop.api.block(pageId)).revision,
              project: { status: 'active', outcome: '', deadline: null },
            });
          if (originalText !== linkText)
            operations.push({ op: 'edit_text', id, base_revision: current.revision, text: linkText });
          // A page this change made holds only the moved rows; an existing one keeps its own writing first.
          let after = created
            ? null
            : ((await workshop.api.page(pageId)).rows
                .filter(row => row.depth === 0 && !children.includes(row.block.id))
                .at(-1)?.block.id ?? null);
          for (const child of children) {
            const block = await workshop.api.block(child);
            if (block.parent_id !== id)
              throw new Error('The project row’s children changed. Their current place was kept.');
            operations.push({ op: 'move', id: child, base_revision: block.revision, parent_id: pageId, after });
            after = child;
          }
        } else {
          if (current.text !== linkText && originalText !== linkText)
            throw new Error('The journal link changed. Its current text was kept.');
          let after: string | null = null;
          for (const child of children) {
            const block = await workshop.api.block(child);
            if (block.parent_id !== pageId)
              throw new Error('The project changed since this change. Its current outline was kept.');
            operations.push({ op: 'move', id: child, base_revision: block.revision, parent_id: id, after });
            after = child;
          }
          if (originalText !== linkText)
            operations.push({ op: 'edit_text', id, base_revision: current.revision, text: originalText });
          const page = await workshop.api.page(pageId);
          if (created) {
            if (page.rows.some(row => !children.includes(row.block.id) && row.depth === 0))
              throw new Error('The project has new writing. It was kept.');
            operations.push({ op: 'delete', id: pageId, base_revision: page.root.revision });
          } else if (!wasProject)
            operations.push({ op: 'set_project', id: pageId, base_revision: page.root.revision, project: null });
        }
        const receipt = await workshop.commit(operations, forward ? 'Make project' : 'Undo project creation', pages, {
          retainRejection: false,
        });
        pageRevision = receipt.revisions.find(value => value.id === pageId)?.revision ?? pageRevision;
        if (!forward && created) deletionId = receipt.deletions[0];
        applied = forward;
      };
      await travel(true);
      return {
        pageId,
        change: {
          undo: () => serializeSourceChange(workshop, () => travel(false)),
          redo: () => serializeSourceChange(workshop, () => travel(true)),
        },
      };
    } finally {
      journal.release();
    }
  });
}
