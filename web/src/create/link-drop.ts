import { inferKind, type CreateRequest } from './request';

/** URI lists may contain comments; never reinterpret a file drag's incidental text. */
export function droppedSource(data: Pick<DataTransfer, 'types' | 'files' | 'getData'>): string | null {
  if (data.types.includes('Files') || data.files.length) return null;
  const uri = data.getData('text/uri-list').split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
  if (uri) return uri;
  const text = data.getData('text/plain').trim();
  return inferKind(text) === 'source' ? text : null;
}

/** Bubble after local handlers so the outline, editors and Library retain ownership of their drops. */
export function installLinkDrop(openCreate: (request: CreateRequest) => void): () => void {
  const ownsDrop = (event: DragEvent) => event.defaultPrevented || event.target instanceof Element
    && !!event.target.closest('.outline-pane, .outline-list, .library-pane, .library-add, .cm-editor, input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
  const dragover = (event: DragEvent) => {
    const data = event.dataTransfer;
    if (ownsDrop(event) || !data || data.types.includes('Files') || data.files.length
      || !data.types.some(type => type === 'text/uri-list' || type === 'text/plain')) return;
    // Browsers hide the data until drop, so negotiate text here and infer only at drop time.
    event.preventDefault(); data.dropEffect = 'copy';
  };
  const drop = (event: DragEvent) => {
    if (ownsDrop(event) || !event.dataTransfer) return;
    const text = droppedSource(event.dataTransfer);
    if (!text) return;
    event.preventDefault();
    openCreate({ kind: 'source', text });
  };
  window.addEventListener('dragover', dragover);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragover', dragover);
    window.removeEventListener('drop', drop);
  };
}
