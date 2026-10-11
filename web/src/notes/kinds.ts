import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import type { NoteIndex } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { IconName } from '../ui/glyphs';

/** One glyph per kind, shared by the sidebar, the finding aid and the note header. */
export function noteKindIcon(key: string): IconName {
  switch (key) {
    case 'person': case 'group': case 'concept': case 'thesis': return key;
    case 'question': return 'question-open';
    case 'source': return 'library';
    case 'project': return 'flag';
    case 'unfiled': return 'page';
    default: return 'tag';
  }
}

/** The sidebar index, refreshed after committed changes like the desk counts. A failed read hides it rather than going stale. */
export function noteIndex(notebook: NotebookClient): Accessor<NoteIndex | undefined> {
  const [index, setIndex] = createSignal<NoteIndex>();
  createEffect(() => {
    notebook.changeSequence(); notebook.lastChange();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      notebook.api.noteIndex(controller.signal).then(value => { if (!controller.signal.aborted) setIndex(value); }, () => { if (!controller.signal.aborted) setIndex(undefined); });
    }, 0);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  });
  return index;
}
