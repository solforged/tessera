import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ImageRef } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OutlineContext } from './context';
import type { OutlineDropIndicator } from './drag';
import { NotebookImage } from '../ui/NotebookImage';
import { Button } from '../ui/Button';
import { BlockText } from './BlockText';
import { OcclusionEditor } from '../review/OcclusionEditor';
import './image.css';

/** The whole image at the largest size the screen allows, with its caption beneath; Escape or Close returns to the outline. */
export function ImageViewer(props: { image: ImageRef; caption: string; notebook: NotebookClient; onClose(): void; onEditMasks(): void }) {
  let root!: HTMLDialogElement;
  onMount(() => root.showModal());
  return <Portal><dialog ref={root} class="image-viewer" aria-label={props.caption || 'Image'} onCancel={event => { event.preventDefault(); props.onClose(); }}
    onClick={event => { if (event.target === event.currentTarget || (event.target as Element).classList.contains('image-viewer-stage')) props.onClose(); }}>
    <header class="image-viewer-header">
      <p class="image-viewer-caption"><Show when={props.caption} fallback="Image"><BlockText text={props.caption} notebook={props.notebook} interactive={false} /></Show></p>
      <Button onClick={() => props.onEditMasks()}>Edit masks</Button>
      <Button onClick={() => props.onClose()}>Close</Button>
    </header>
    <div class="image-viewer-stage"><NotebookImage image={props.image} api={props.notebook.api} alt={props.caption} /></div>
  </dialog></Portal>;
}


const accepted = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export function createOutlineImages(context: Pick<OutlineContext, 'doc' | 'props' | 'apply' | 'setMessage' | 'disposed' | 'scroll' | 'zoom' | 'rowAnchor' | 'restoreFocus'>) {
  let input!: HTMLInputElement;
  let choice: { id: string; replace: boolean } | undefined;
  const [viewer, setViewer] = createSignal<string>();
  const [editor, setEditor] = createSignal<string>();
  const [indicator, setIndicator] = createSignal<OutlineDropIndicator | null>(null);
  const failure = (error: unknown) => { if (!context.disposed) context.setMessage(error instanceof Error ? error.message : String(error)); };
  async function uploadImages(files: readonly File[], targetId?: string, replace = false) {
    if (!files.length) return;
    if (files.some(file => !accepted.includes(file.type))) { context.setMessage('Only PNG, JPEG, WebP and GIF images can be added.'); return; }
    try {
      const images: ImageRef[] = await Promise.all((replace ? files.slice(0, 1) : files).map(file => context.props.notebook.api.uploadImage(file)));
      if (context.disposed) return;
      if (replace && targetId) context.apply({ kind: 'image', id: targetId, image: images[0]! }, false);
      else if (targetId) context.apply({ kind: 'placeImages', targetId, images }, false);
      else {
        const parentId = context.zoom() ?? context.doc.pageId;
        context.apply({ kind: 'insertImages', parentId, after: context.doc.outline.children(parentId).at(-1) ?? null, images }, false);
      }
    } catch (error) { failure(error); }
  }
  function chooseImage(id: string, replace = false) { choice = { id, replace }; input.value = ''; input.click(); }
  function openImage(id: string) { if (context.doc.block(id)?.image) setViewer(id); }
  function editOcclusion(id: string) { if (context.doc.block(id)?.image) { setViewer(undefined); setEditor(id); } }
  let requested: string | undefined;
  createEffect(() => {
    const id = context.props.view.editOcclusion;
    if (id && id !== requested && context.doc.block(id)?.image) { requested = id; editOcclusion(id); }
  });
  const target = (event: DragEvent) => (event.target instanceof Element ? event.target.closest<HTMLElement>('[data-block-id]') : null)?.dataset.blockId;
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
  function dragOver(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const id = target(event), row = id ? context.rowAnchor(id) : null;
    const list = context.scroll.querySelector<HTMLElement>('.outline-list');
    if (!list) return;
    const bounds = list.getBoundingClientRect(), root = context.zoom() ?? context.doc.pageId;
    setIndicator({ parentId: id ? context.doc.outline.parentOf(id) : root, after: id ?? context.doc.outline.children(root).at(-1) ?? null,
      anchorId: id ?? root, edge: 'after', depth: id ? context.doc.outline.depth(id) : context.zoom() ? context.doc.outline.depth(root) + 1 : 0,
      top: row ? row.getBoundingClientRect().bottom - bounds.top : list.offsetHeight, left: row ? row.getBoundingClientRect().left - bounds.left : 0 });
  }
  function drop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault(); event.stopPropagation(); setIndicator(null);
    void uploadImages(Array.from(event.dataTransfer!.files), target(event));
  }
  function leave(event: DragEvent) { if (!context.scroll.contains(event.relatedTarget as Node | null)) setIndicator(null); }
  onMount(() => {
    context.scroll.addEventListener('dragover', dragOver);
    context.scroll.addEventListener('drop', drop);
    context.scroll.addEventListener('dragleave', leave);
  });
  onCleanup(() => {
    context.scroll.removeEventListener('dragover', dragOver);
    context.scroll.removeEventListener('drop', drop);
    context.scroll.removeEventListener('dragleave', leave);
  });
  function ImagePopups() {
    const block = () => context.doc.block(viewer() ?? '');
    const close = () => { setViewer(undefined); context.restoreFocus(); };
    const editing = () => context.doc.block(editor() ?? '');
    return <>
      <input ref={input} hidden type="file" aria-label="Insert image" accept={accepted.join(',')} multiple onChange={event => {
        const selected = choice; choice = undefined;
        if (selected) void uploadImages(Array.from(event.currentTarget.files ?? []), selected.id, selected.replace);
      }} />
      <Show when={block()?.image}>{image => <ImageViewer image={image()} caption={block()!.text} notebook={context.props.notebook} onClose={close} onEditMasks={() => editOcclusion(viewer()!)} />}</Show>
      <Show keyed when={editing()}>{block => <Show when={block.image}>{image => <OcclusionEditor id={block.id} image={image()} caption={block.text} state={block.occlusion} notebook={context.props.notebook} doc={context.doc} onClose={() => { setEditor(undefined); context.restoreFocus(); }} />}</Show>}</Show>
    </>;
  }
  return { uploadImages, chooseImage, openImage, editOcclusion, indicator, ImagePopups };
}
