import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { glide } from '../ui/pane-motion';
import type { NotebookClient } from '../document/contract';
import type { OutlinePaneProps } from '../shell/contract';
import { MetadataInspector } from '../library/MetadataInspector';
import { Popup } from '../ui/Popup';
import './source-details.css';

export function SourceDetails(props: { notebook: NotebookClient; pageId: string; onOpen: OutlinePaneProps['onOpen']; opener?: HTMLElement; onClose(): void }) {
  let marker!: HTMLSpanElement;
  let column: HTMLElement | undefined;
  const [wide, setWide] = createSignal<boolean>();
  // The page keeps its column until the card can show, glides aside in the frame the card appears, and glides back
  // when the card closes.
  const [shown, setShown] = createSignal(false);
  // The card leaves while the page glides back: it fades out where it stands, then unmounts.
  const [leaving, setLeaving] = createSignal(false);
  // Read from the pane captured at mount: closing detaches this component before the glide measures where the page went.
  let page: HTMLElement | null = null;
  const pageParts = () => [...(page?.querySelectorAll<HTMLElement>(':scope > :is(.outline-heading, .outline-list, .related-sections, .add-first-block)') ?? [])];
  const show = (value: boolean) => {
    if (!value || shown()) return;
    glide(pageParts, () => setShown(true));
    // Focus moves to the card once it can be seen, unless the person has already gone elsewhere.
    queueMicrotask(() => {
      const active = document.activeElement;
      if (leaving() || (active && active !== document.body && !page?.contains(active) && !active.closest('.popup'))) return;
      column?.querySelector<HTMLElement>('.metadata-inspector')?.focus({ preventScroll: true });
    });
  };
  const restoreFocus = () => {
    // Focus goes back at once, not after the exit, so the keyboard is never stranded on a retiring card.
    const target = props.opener?.isConnected ? props.opener : page;
    target?.focus({ preventScroll: true });
  };
  const close = () => {
    if (leaving()) return;
    const retiring = column;
    restoreFocus();
    glide(pageParts, () => setLeaving(true));
    if (!retiring) { props.onClose(); return; }
    retiring.inert = true;
    // `getAnimations` reads the exit just started; with no motion it is empty or instant, and the card unmounts now.
    void Promise.allSettled(retiring.getAnimations().map(animation => animation.finished)).then(() => props.onClose());
  };
  onMount(() => {
    const pane = page = marker.closest<HTMLElement>('.outline-pane')!;
    const observer = new ResizeObserver(entries => setWide((entries[0]?.contentRect.width ?? 0) >= 1096));
    observer.observe(pane);
    const keydown = (event: KeyboardEvent) => {
      if (!wide() || event.defaultPrevented || event.isComposing || event.key !== 'Escape' || document.querySelector('.popup')) return;
      if (!pane.closest('.pane')?.classList.contains('active')) return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    document.addEventListener('keydown', keydown);
    onCleanup(() => { observer.disconnect(); document.removeEventListener('keydown', keydown); });
  });
  return <><span ref={marker} hidden /><Show when={wide() !== undefined}><Show when={wide()} fallback={
    <Popup anchor={marker} placement="sheet" label="Source details" class="source-details-sheet" returnFocus={() => props.opener ?? null} onDismiss={props.onClose}>
      <MetadataInspector notebook={props.notebook} sourceIds={[props.pageId]} onOpen={props.onOpen} onClose={props.onClose} phone />
    </Popup>
  }>
    <aside ref={element => { column = element; }} class="source-details-column" classList={{ 'source-details-pending': !shown(), 'source-details-leaving': leaving() }} aria-label="Source details" onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
      <MetadataInspector notebook={props.notebook} sourceIds={[props.pageId]} onOpen={props.onOpen} onClose={close} onShown={show} />
    </aside>
  </Show></Show></>;
}
