import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import type { IndexKind, NoteIndex, NoteKind } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { paths, type IconName } from '../ui/glyphs';
import type { OpenTarget } from '../shell/contract';
import { typeQuery } from '../table/query';

/** One glyph per kind, shared by the sidebar, the finding aid and the note header. */
export function noteKindIcon(kind: string | Pick<NoteKind, 'key' | 'icon'>): IconName {
  if (typeof kind !== 'string' && kind.icon) return Object.hasOwn(paths, kind.icon) ? kind.icon as IconName : 'tag';
  const key = typeof kind === 'string' ? kind : kind.key;
  switch (key) {
    case 'all': return 'contents';
    case 'person': case 'group': case 'concept': case 'thesis': return key;
    case 'question': return 'question-open';
    case 'source': return 'library';
    case 'project': return 'flag';
    case 'unfiled': return 'page';
    default: return 'tag';
  }
}

/** A kind whose only members are tagged non-page blocks; an empty built-in kind is not one. */
export function tagOnly(kind: IndexKind): kind is IndexKind & { type_id: string } {
  return kind.count === 0 && kind.tagged_block_count > 0 && kind.type_id !== null;
}

/** A tag-only kind opens its useful member table rather than an empty note index. */
export function indexKindTarget(kind: IndexKind): OpenTarget {
  return tagOnly(kind)
    ? { kind: 'table', typeId: kind.type_id, viewId: null, query: typeQuery(kind.type_id) }
    : { kind: 'index', key: kind.key };
}

/** The sidebar index, refreshed after committed changes like the desk counts. A failed read hides it rather than going stale. */
export function noteIndex(notebook: NotebookClient): Accessor<NoteIndex | undefined> {
  const [index, setIndex] = createSignal<NoteIndex>();
  createEffect(() => {
    notebook.changeSequence(); notebook.lastChange(); notebook.connection();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      notebook.api.noteIndex(controller.signal).then(value => { if (!controller.signal.aborted) setIndex(value); }, () => { if (!controller.signal.aborted) setIndex(undefined); });
    }, 0);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  });
  return index;
}
