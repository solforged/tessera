import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { glide } from '../ui/pane-motion';
import type { NotebookClient } from '../document/contract';
import type { OutlinePaneProps } from '../shell/contract';
import { MetadataInspector } from '../library/MetadataInspector';
import { Popup } from '../ui/Popup';
import './source-details.css';

export function SourceDetails(props: { notebook: NotebookClient; pageId: string; onOpen: OutlinePaneProps['onOpen']; onClose(): void }) {
  let marker!: HTMLSpanElement;
  const [wide, setWide] = createSignal<boolean>();
  // The page keeps its column until the card can show, glides aside in the frame the card appears, and glides back
  // when the card closes.
  const [shown, setShown] = createSignal(false);
  // Read from the pane captured at mount: closing detaches this component before the glide measures where the page went.
  let page: HTMLElement | null = null;
  const pageParts = () => [...(page?.querySelectorAll<HTMLElement>(':scope > :is(.outline-heading, .outline-list, .related-sections, .add-first-block)') ?? [])];
  const show = (value: boolean) => { if (value && !shown()) glide(pageParts, () => setShown(true)); };
  const close = () => glide(pageParts, props.onClose);
  onMount(() => {
    const pane = page = marker.closest<HTMLElement>('.outline-pane')!;
    const observer = new ResizeObserver(entries => setWide((entries[0]?.contentRect.width ?? 0) >= 1096));
    observer.observe(pane);
    const keydown = (event: KeyboardEvent) => {
      if (!wide() || event.defaultPrevented || event.isComposing || event.key !== 'Escape' || document.querySelector('.popup')) return;
      if (!pane.closest('.pane')?.classList.contains('active')) return;
      event.preventDefault(); event.stopPropagation(); close(); pane.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', keydown, true);
    onCleanup(() => { observer.disconnect(); document.removeEventListener('keydown', keydown, true); });
  });
  return <><span ref={marker} hidden /><Show when={wide() !== undefined}><Show when={wide()} fallback={
    <Popup anchor={marker} placement="sheet" label="Source details" class="source-details-sheet" onDismiss={props.onClose}>
      <MetadataInspector notebook={props.notebook} sourceIds={[props.pageId]} onOpen={props.onOpen} onClose={props.onClose} phone />
    </Popup>
  }>
    <aside class="source-details-column" classList={{ 'source-details-pending': !shown() }} aria-label="Source details" onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
      <MetadataInspector notebook={props.notebook} sourceIds={[props.pageId]} onOpen={props.onOpen} onClose={close} onShown={show} />
    </aside>
  </Show></Show></>;
}
