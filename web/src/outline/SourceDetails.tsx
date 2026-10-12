import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import type { OutlinePaneProps } from '../shell/contract';
import { MetadataInspector } from '../library/MetadataInspector';
import { Popup } from '../ui/Popup';
import './source-details.css';

export function SourceDetails(props: { notebook: NotebookClient; pageId: string; onOpen: OutlinePaneProps['onOpen']; onClose(): void }) {
  let marker!: HTMLSpanElement;
  const [wide, setWide] = createSignal<boolean>();
  onMount(() => {
    const pane = marker.closest<HTMLElement>('.outline-pane')!;
    const observer = new ResizeObserver(entries => setWide((entries[0]?.contentRect.width ?? 0) >= 1096));
    observer.observe(pane);
    const keydown = (event: KeyboardEvent) => {
      if (!wide() || event.defaultPrevented || event.isComposing || event.key !== 'Escape' || document.querySelector('.popup')) return;
      if (!pane.closest('.pane')?.classList.contains('active')) return;
      event.preventDefault(); event.stopPropagation(); props.onClose(); pane.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', keydown, true);
    onCleanup(() => { observer.disconnect(); document.removeEventListener('keydown', keydown, true); });
  });
  return <><span ref={marker} hidden /><Show when={wide() !== undefined}><Show when={wide()} fallback={
    <Popup anchor={marker} placement="sheet" label="Source details" class="source-details-sheet" onDismiss={props.onClose}>
      <MetadataInspector notebook={props.notebook} sourceIds={[props.pageId]} onOpen={props.onOpen} onClose={props.onClose} phone />
    </Popup>
  }>
    <aside class="source-details-column" aria-label="Source details" onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
      <MetadataInspector notebook={props.notebook} sourceIds={[props.pageId]} onOpen={props.onOpen} onClose={props.onClose} />
    </aside>
  </Show></Show></>;
}
