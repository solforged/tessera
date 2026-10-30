import { autoPlural } from '../fields/presentation';
import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import type { IndexKind, NoteIndex, NoteKind, Shelf } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { paths, type IconName } from '../ui/glyphs';
import type { OpenTarget } from '../shell/contract';
import { typeQuery } from '../table/query';

/** One glyph per registry kind, with shell-only kinds and page capabilities resolved here. */
export function noteKindIcon(kind: string | Pick<NoteKind, 'key' | 'icon'>): IconName {
  if (typeof kind === 'string') {
    switch (kind) {
      case 'all': return 'contents';
      case 'question': return 'question-open';
      case 'project': return 'flag';
      default: return 'tag';
    }
  }
  return kind.icon && Object.hasOwn(paths, kind.icon) ? kind.icon as IconName : 'tag';
}

/** A kind whose only members are tagged non-page blocks; an empty built-in kind is not one. */
export function tagOnly(kind: IndexKind): kind is IndexKind & { type_id: string } {
  return kind.count === 0 && kind.tagged_block_count > 0 && kind.type_id !== null;
}

/** A tag that only marks blocks keeps the spelling you wrote. An explicit plural still wins, and a kind with notes keeps its plural. */
export function kindLabel(kind: IndexKind): string {
  return kind.key.startsWith('type:') && tagOnly(kind) && kind.plural === autoPlural(kind.name) ? kind.name : kind.plural;
}

/** Built-in kinds that can start from their finding aid. Sources come from the Library instead. */
export const startableKinds: Readonly<Record<string, 'type' | 'task' | 'question' | 'project'>> = { person: 'type', group: 'type', concept: 'type', thesis: 'type', task: 'task', question: 'question', project: 'project' };

/** Built-in kinds read as common nouns (`no people yet`); a type's own name keeps the capitals it was given. */
export function kindPlural(kind: Pick<NoteKind, 'key' | 'plural'>): string {
  return kind.key in startableKinds || kind.key === 'source' ? kind.plural.toLocaleLowerCase() : kind.plural;
}

/** A kind's member count in its own noun: tasks, questions, sources and projects count themselves, the rest count atoms. */
export function kindTally(count: number, key: string): string {
  const noun = ['task', 'question', 'source', 'project'].includes(key) ? key : 'atom';
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

/** The noun after a count on a phone's eyebrow, where the figure is set apart in mono: `people`, `concept`, `tasks`. */
export function censusNoun(count: number, key: string, kind?: Pick<NoteKind, 'key' | 'name' | 'plural'>): string {
  if (!kind || ['task', 'question', 'source', 'project'].includes(key)) return kindTally(count, key).replace(/^\S+ /, '');
  return count === 1 ? kind.key in startableKinds ? kind.name.toLocaleLowerCase() : kind.name : kindPlural(kind);
}

/** A tag-only kind opens its useful member table rather than an empty note index. */
export function indexKindTarget(kind: IndexKind): OpenTarget {
  return tagOnly(kind)
    ? { kind: 'table', typeId: kind.type_id, viewId: null, query: typeQuery(kind.type_id) }
    : { kind: 'index', key: kind.key };
}

/** The Index's finding-aid heads, in order; spreads follow under their own head. */
export const shelves: readonly (readonly [Shelf, string])[] = [['notes', 'Atoms'], ['sources', 'Sources'], ['work', 'Work'], ['tags', 'Tags'], ['loose', 'Loose']];

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
