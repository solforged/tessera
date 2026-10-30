import { batch, createMemo, createSignal, createUniqueId, Index, onCleanup, onMount, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { isPhone } from './phone';
import { Popup } from './Popup';
import type { PopupAnchor, PopupPlacement } from './Popup';

/** One icon button of a palette row. */
export interface MenuPaletteButton {
  /** The button's accessible name and tooltip: the glyph carries no text. */
  label: string;
  icon: IconName;
  disabledReason?: string;
  action?(event?: MouseEvent | KeyboardEvent): void;
}
/** A drill-in: its rows replace the menu's in place, under its own title and a header Back. */
export interface MenuPage {
  title: string;
  items: MenuItem[];
  /** One plain line under the rows, for what the whole page does rather than each row. */
  note?: string;
}
export interface MenuItem {
  /** The row's text; for a palette row, the name of the group of buttons. */
  label: string;
  /** Optional heading for a group of adjacent actions; adjacent items with the same section show it once. */
  section?: string;
  /** Draws a hairline above the item, starting an unnamed group. */
  divider?: boolean;
  icon?: IconName;
  shortcut?: string;
  /** A single key that runs the item while the menu has focus, as in a leader menu. */
  key?: string;
  disabledReason?: string;
  secondary?: string;
  /** Draws in the danger colour. Put destructive items last, in a group of their own. */
  danger?: boolean;
  /** The current choice in a set; drawn as a trailing check so the leading icon can name the choice. */
  checked?: boolean;
  /** Opens this page inside the same menu instead of running an action; built when opened. */
  submenu?: () => MenuPage;
  /** Draws the item as a palette row: three to five icon buttons sharing one line (outdent, indent, up, down), each with its
   * own action. The item's own icon, action, submenu, shortcut and checked are ignored. */
  palette?: MenuPaletteButton[];
  action?(event?: MouseEvent | KeyboardEvent): void;
}

const milliseconds = (value: string) => {
  const amount = parseFloat(value);
  return Number.isFinite(amount) ? /\ds\s*$/.test(value) ? amount * 1000 : amount : 0;
};
/** A drill-in glides for the UI motion token; reduced motion (0ms) swaps pages at once. */
function glideTiming(element: HTMLElement) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return { duration: 0, easing: 'linear' };
  const style = getComputedStyle(element);
  return { duration: milliseconds(style.getPropertyValue('--motion-ui')), easing: style.getPropertyValue('--motion-ease').trim() || 'ease' };
}

export function Menu(props: {
  anchor: PopupAnchor; label: string; items: MenuItem[];
  /** Names the menu in a header with Close; drill-ins replace it with their own title and Back. Desktop only: a phone
   * pull-down has no title, so say what it acts on with `caption`. */
  title?: string;
  /** A short mono line under the title naming what the menu acts on. Desktop only, like `title`. */
  context?: JSX.Element;
  /** A phone-only line above the rows that says what the actions apply to ("Move 2 overdue tasks to"). Use it only when
   * the rows cannot say it themselves; desktop menus ignore it. */
  caption?: JSX.Element;
  header?: JSX.Element; placement?: PopupPlacement; class?: string; onDismiss(): void;
  /** Where focus goes when the menu closes, for an opener that is replaced or re-rendered while it is open. */
  returnFocus?: HTMLElement | (() => HTMLElement | null);
  /** Editors retain the menu until their revision-checked write succeeds. */
  closeOnSelect?: boolean;
  /** Traps focus, makes the page behind inert and takes an outside press whole (see Popup). */
  modal?: boolean;
}) {
  const reasonId = createUniqueId();
  const [pages, setPages] = createSignal<{ page: MenuPage; from: number }[]>([]);
  const page = () => pages().at(-1)?.page;
  const items = () => page()?.items ?? props.items;
  const iconed = () => items().some(item => item.icon);
  // A menu shut for one reason says it once, under the rows, rather than under each of them.
  const sharedReason = () => {
    const [first, ...rest] = items();
    return first?.disabledReason && rest.length && rest.every(item => item.disabledReason === first.disabledReason) ? first.disabledReason : undefined;
  };
  const reasonFor = (index: number) => sharedReason() ? `${reasonId}-shared` : `${reasonId}-${index}`;
  // A phone menu is a glass pull-down at its button; only a caller that asks for a sheet gets one.
  const phone = isPhone();
  const sheet = () => props.placement === 'sheet';
  const pull = () => phone && !sheet();
  // A phone row says its action in plain words: "Add field…" reads "Add field", and a chevron already says there is more.
  const text = (label: string) => pull() ? label.replace(/\s*(…|\.\.\.)$/, '') : label;
  let viewport!: HTMLDivElement;
  let content!: HTMLDivElement;
  // The row a menu opens on and the one tab stop: the current choice in a set, else the first row that works.
  const enabled = (item: MenuItem | undefined) => !!item && !item.disabledReason;
  const initialIndex = () => {
    const list = items();
    const checked = list.findIndex(item => item.checked && enabled(item));
    return checked >= 0 ? checked : Math.max(0, list.findIndex(enabled));
  };
  const [cursor, setCursor] = createSignal(-1);
  const roving = createMemo(() => { const at = cursor(); return at >= 0 && at < items().length ? at : initialIndex(); });
  const rows = () => Array.from(content.querySelectorAll<HTMLElement>('[data-menu-row]'));
  const usable = (row: HTMLElement | undefined) => row && row.getAttribute('aria-disabled') !== 'true' ? row : undefined;
  const [gliding, setGliding] = createSignal(false);
  let glideRun = 0;
  const focusRow = (index: number) => queueMicrotask(() => {
    const list = rows();
    // A page growing into view must not scroll its clipped box to reach the row; the glide's end reveals it.
    const row = usable(list[index]) ?? list.find(row => usable(row));
    (row instanceof HTMLButtonElement ? row : row?.querySelector<HTMLElement>('.menu-palette-button:not([aria-disabled="true"])'))?.focus({ preventScroll: gliding() });
  });
  // Ends every glide in flight: animations, the fading old page, and the width held on the new one.
  const settle = () => {
    for (const animation of viewport.getAnimations({ subtree: true })) animation.cancel();
    for (const ghost of viewport.querySelectorAll('.menu-ghost')) ghost.remove();
    content.style.width = '';
  };
  // Swapping pages glides the box to the new page's size, width and height together (the popup follows it frame by frame),
  // while the old page fades out over the new one fading in. The new page is measured at its final size before anything
  // moves, so the glide ends exactly where the box settles.
  const glide = (change: () => void) => {
    const { duration, easing } = glideTiming(viewport);
    if (!duration || !viewport.isConnected) { glideRun++; settle(); setGliding(false); change(); return; }
    // Read the boxes as they are now, mid-glide included, before a running glide is cancelled.
    const from = viewport.getBoundingClientRect(), fromWidth = content.getBoundingClientRect().width;
    const ghost = content.cloneNode(true) as HTMLElement;
    ghost.classList.add('menu-ghost');
    ghost.removeAttribute('id');
    for (const element of ghost.querySelectorAll('[id]')) element.removeAttribute('id');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.style.width = `${fromWidth}px`;
    settle();
    const token = ++glideRun;
    change();
    // The new page is in the DOM before the next paint; measure it, then start every animation together.
    queueMicrotask(() => {
      if (token !== glideRun || !viewport.isConnected) return;
      const to = viewport.getBoundingClientRect();
      // Held at its final width so the page does not reflow while the box is narrower or wider than it.
      content.style.width = `${to.width}px`;
      viewport.append(ghost);
      setGliding(true);
      const options = { duration, easing };
      const size = (box: DOMRect) => ({ width: `${box.width}px`, height: `${box.height}px` });
      const animations = [
        content.animate([{ opacity: 0 }, { opacity: 1 }], options),
        ghost.animate([{ opacity: 1 }, { opacity: 0 }], { ...options, fill: 'forwards' }),
        ...Math.abs(to.height - from.height) < 0.5 && Math.abs(to.width - from.width) < 0.5 ? [] : [viewport.animate([size(from), size(to)], options)],
      ];
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (token !== glideRun) return;
        settle();
        setGliding(false);
        const active = document.activeElement;
        if (active instanceof HTMLElement && content.contains(active)) active.scrollIntoView({ block: 'nearest' });
      });
    });
  };
  // Focus follows the keyboard; a tap or click that drills in leaves no ring on a row the finger never chose, but keeps
  // focus in the menu (the row it pressed may be gone) so keys and Tab still reach it.
  const open = (item: MenuItem, index: number, focus: boolean) => {
    glide(() => batch(() => { setCursor(-1); setPages(stack => [...stack, { page: item.submenu!(), from: index }]); }));
    if (focus) focusRow(0); else viewport.focus({ preventScroll: true });
  };
  const back = (focus: boolean) => {
    const from = pages().at(-1)?.from ?? 0;
    glide(() => batch(() => { setCursor(-1); setPages(stack => stack.slice(0, -1)); }));
    if (focus) focusRow(from); else viewport.focus({ preventScroll: true });
  };
  // Dismissing unmounts the popup with focus inside it, which is when Popup hands focus back to the opener.
  const run = (item: MenuItem, index: number, event?: MouseEvent | KeyboardEvent) => {
    if (item.disabledReason) return;
    if (item.submenu) { open(item, index, !(event instanceof MouseEvent) || event.detail === 0); return; }
    if (props.closeOnSelect !== false) props.onDismiss();
    item.action?.(event);
  };
  const pick = (button: MenuPaletteButton, event: MouseEvent) => {
    if (button.disabledReason) return;
    if (props.closeOnSelect !== false) props.onDismiss();
    button.action?.(event);
  };
  // The menu focuses its own first row (the current choice in a set): Popup's autofocus would pick a control from a header
  // first. A titled menu's head may carry controls (Copy ID), and touch screens start with no row lit. A phone menu never
  // lights a row: it takes focus itself, so a hardware keyboard's arrows still start it, and a finger chooses by touching.
  // Tab is Popup's: with one row in the tab order (the one that holds focus), Tab leaves the menu, which closes and hands
  // focus back to its opener.
  onMount(() => {
    if (phone) viewport.focus({ preventScroll: true });
    else if (props.title === undefined || !window.matchMedia('(hover: none)').matches) focusRow(initialIndex());
    // Escape in a drilled-in page steps back one level and leaves the menu open; Popup, which closes the whole menu on
    // Escape from its document capture, never sees it. At the first page Escape is Popup's.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !pages().length || !(event.target instanceof Node) || !(viewport.parentElement ?? viewport).contains(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation(); back(true);
    };
    window.addEventListener('keydown', escape, true);
    onCleanup(() => window.removeEventListener('keydown', escape, true));
  });
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const active = document.activeElement;
    // Left and right walk along a palette row; up and down leave it.
    if (plain && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && active instanceof HTMLElement && active.classList.contains('menu-palette-button')) {
      const along = Array.from(active.parentElement!.querySelectorAll<HTMLElement>('.menu-palette-button:not([aria-disabled="true"])'));
      along[(along.indexOf(active) + (event.key === 'ArrowRight' ? 1 : -1) + along.length) % along.length]?.focus();
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (pages().length && plain && (event.key === 'ArrowLeft' || event.key === 'Backspace')) { event.preventDefault(); event.stopPropagation(); back(true); return; }
    if (plain && event.key === 'ArrowRight' && document.activeElement instanceof HTMLButtonElement) {
      const index = rows().indexOf(document.activeElement);
      const item = items()[index];
      if (item?.submenu && !item.disabledReason) { event.preventDefault(); event.stopPropagation(); open(item, index, true); return; }
    }
    const mnemonicIndex = plain ? items().findIndex(item => item.key === event.key && !item.disabledReason) : -1;
    const mnemonic = items()[mnemonicIndex];
    if (mnemonic) { event.preventDefault(); event.stopPropagation(); run(mnemonic, mnemonicIndex, event); return; }
    // Header controls share the menu's mnemonics and arrow-key order.
    const control = plain ? Array.from(content.querySelectorAll<HTMLButtonElement>('button[data-menu-key]:not(:disabled)')).find(button => button.dataset.menuKey === event.key) : undefined;
    if (control) { event.preventDefault(); event.stopPropagation(); control.click(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    // A palette row is one stop: its buttons are reached with left and right.
    const palette = (button: Element) => button.classList.contains('menu-palette-button') ? button.parentElement!.querySelector('.menu-palette-button:not([aria-disabled="true"])') : button;
    const buttons = Array.from(content.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not(.menu-head-control)')).filter(button => palette(button) === button);
    const index = buttons.indexOf((active instanceof Element ? palette(active) : active) as HTMLButtonElement);
    const down = event.key === 'ArrowDown';
    // Focus can rest on the menu itself after a tap drilled in; Down then enters at the top and Up at the bottom.
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index < 0 ? down ? 0 : buttons.length - 1 : (index + (down ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus(); event.preventDefault();
  };
  return <Popup anchor={props.anchor} onDismiss={props.onDismiss} returnFocus={props.returnFocus} modal={props.modal} role="menu" label={page()?.title ?? props.label} autofocus={false} placement={sheet() ? 'sheet' : props.placement} class={`menu ${sheet() ? 'menu-sheet' : ''} ${pull() ? 'menu-pull' : ''} ${gliding() ? 'menu-gliding' : ''} ${props.class ?? ''}`}>
    <div ref={viewport} class="menu-viewport" tabIndex={-1} onKeyDown={keydown}>
      <div ref={content} class="menu-content">
        <Show when={props.title !== undefined && !pull()}>
          <header class="menu-head">
            <h2>{page()?.title ?? props.title}</h2>
            <Show when={pages().length} fallback={<Show when={!sheet()}><button type="button" class="menu-head-control" tabIndex={-1} onClick={() => props.onDismiss()}>Close</button></Show>}>
              <button type="button" class="menu-head-control" tabIndex={-1} onClick={event => back(event.detail === 0)}><Icon name="left" />Back</button>
            </Show>
            <Show when={props.context}><div class="menu-context">{props.context}</div></Show>
          </header>
        </Show>
        {/* A drilled-in phone page names itself on its way back: one row, the chevron and the page's title. */}
        <Show when={pull() && pages().length}>
          <button type="button" class="menu-back" onClick={event => back(event.detail === 0)}><Icon name="left" /><span>{text(page()!.title)}</span></button>
        </Show>
        <Show when={pull() && !pages().length && props.caption}>{caption => <div class="menu-caption">{caption()}</div>}</Show>
        <Show when={!pages().length}>{props.header}</Show>
        {/* Rows are keyed by position: callers rebuild their item objects as page state settles, and a recreated button would drop keyboard focus. */}
        <Index each={items()}>{(item, index) => <>
          {item().section && item().section !== items()[index - 1]?.section && <div class="menu-section">{item().section}</div>}
          {item().divider && index > 0 && <hr class="menu-divider" />}
          <Show when={item().palette} fallback={
            <button type="button" data-menu-row role={item().checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item().checked} aria-haspopup={item().submenu ? 'menu' : undefined} class={`menu-item ${item().danger ? 'danger' : ''} ${item().submenu ? 'menu-item-drill' : ''}`} tabIndex={index === roving() ? 0 : -1} aria-disabled={!!item().disabledReason} aria-describedby={item().disabledReason ? reasonFor(index) : undefined} title={item().disabledReason} onFocus={() => setCursor(index)} onClick={event => run(item(), index, event)}>
              {item().icon ? <Icon name={item().icon!} /> : iconed() ? <span class="icon" /> : null}<span class="menu-label">{text(item().label)}{(item().disabledReason && !sharedReason() || item().secondary) && <span class="menu-disabled-reason" id={`${reasonId}-${index}`}>{sharedReason() ? item().secondary : item().disabledReason || item().secondary}</span>}</span>{item().shortcut && <kbd>{item().shortcut}</kbd>}{item().checked && <Icon name="check" class="menu-check" />}{item().submenu && <Icon name="right" class="menu-drill" />}
            </button>}>{buttons =>
            <div data-menu-row class="menu-palette" role="group" aria-label={item().label}>
              <Index each={buttons()}>{(button, at) =>
                <button type="button" role="menuitem" class="menu-palette-button" aria-label={button().label} title={button().disabledReason ?? button().label} aria-disabled={!!button().disabledReason} tabIndex={index === roving() && at === buttons().findIndex(first => !first.disabledReason) ? 0 : -1} onFocus={() => setCursor(index)} onClick={event => pick(button(), event)}><Icon name={button().icon} /></button>}</Index>
            </div>}</Show>
        </>}</Index>
        <Show when={sharedReason()}>{reason => <p class="menu-note" id={`${reasonId}-shared`}>{reason()}</p>}</Show>
        <Show when={page()?.note}>{note => <p class="menu-note">{note()}</p>}</Show>
      </div>
    </div>
  </Popup>;
}
