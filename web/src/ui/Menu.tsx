import { createSignal, createUniqueId, Index, onMount, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { Popup } from './Popup';
import type { PopupAnchor, PopupPlacement } from './Popup';

/** A drill-in: its rows replace the menu's in place, under its own title and a header Back. */
export interface MenuPage {
  title: string;
  items: MenuItem[];
  /** One plain line under the rows, for what the whole page does rather than each row. */
  note?: string;
}
export interface MenuItem {
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
  danger?: boolean;
  /** The current choice in a set; drawn as a trailing check so the leading icon can name the choice. */
  checked?: boolean;
  /** Opens this page inside the same menu instead of running an action; built when opened. */
  submenu?: () => MenuPage;
  action?(event?: MouseEvent | KeyboardEvent): void;
}
/** A titled menu becomes a bottom sheet on a phone-sized touch screen. */
const phoneSheet = () => window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches;

export function Menu(props: {
  anchor: PopupAnchor; label: string; items: MenuItem[];
  /** Names the menu in a header with Close; drill-ins replace it with their own title and Back. */
  title?: string;
  /** A short mono line under the title naming what the menu acts on. */
  context?: JSX.Element;
  header?: JSX.Element; placement?: PopupPlacement; class?: string; onDismiss(): void;
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
  const sheet = () => props.placement === undefined && props.title !== undefined && phoneSheet();
  let body!: HTMLDivElement;
  const focusRow = (index: number) => queueMicrotask(() => {
    const rows = Array.from(body.querySelectorAll<HTMLButtonElement>('.menu-item'));
    (rows[index] && rows[index].getAttribute('aria-disabled') !== 'true' ? rows[index] : rows.find(row => row.getAttribute('aria-disabled') !== 'true'))?.focus();
  });
  // Focus follows the keyboard; a tap or click that drills in leaves no ring on a row the finger never chose.
  const open = (item: MenuItem, index: number, focus: boolean) => { setPages(stack => [...stack, { page: item.submenu!(), from: index }]); if (focus) focusRow(0); };
  const back = (focus: boolean) => { const from = pages().at(-1)?.from ?? 0; setPages(stack => stack.slice(0, -1)); if (focus) focusRow(from); };
  const run = (item: MenuItem, index: number, event?: MouseEvent | KeyboardEvent) => {
    if (item.disabledReason) return;
    if (item.submenu) { open(item, index, !(event instanceof MouseEvent) || event.detail === 0); return; }
    props.onDismiss(); item.action?.(event);
  };
  // A titled menu's head may carry controls (Copy ID); keyboard focus still starts on the first row. Touch screens start
  // with none, so the sheet doesn't open with a row already lit.
  onMount(() => { if (props.title !== undefined && !window.matchMedia('(hover: none)').matches) focusRow(0); });
  return <Popup anchor={props.anchor} onDismiss={props.onDismiss} role="menu" label={page()?.title ?? props.label} autofocus={props.title === undefined} placement={sheet() ? 'sheet' : props.placement} class={`menu ${sheet() ? 'menu-sheet' : ''} ${props.class ?? ''}`}>
    <div ref={body} onKeyDown={event => {
      if (event.isComposing) return;
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (pages().length && plain && (event.key === 'ArrowLeft' || event.key === 'Backspace')) { event.preventDefault(); event.stopPropagation(); back(true); return; }
      if (plain && event.key === 'ArrowRight' && document.activeElement instanceof HTMLButtonElement) {
        const index = Array.from(body.querySelectorAll('.menu-item')).indexOf(document.activeElement);
        const item = items()[index];
        if (item?.submenu && !item.disabledReason) { event.preventDefault(); event.stopPropagation(); open(item, index, true); return; }
      }
      const mnemonicIndex = plain ? items().findIndex(item => item.key === event.key && !item.disabledReason) : -1;
      const mnemonic = items()[mnemonicIndex];
      if (mnemonic) { event.preventDefault(); event.stopPropagation(); run(mnemonic, mnemonicIndex, event); return; }
      // Header controls share the menu's mnemonics and arrow-key order.
      const control = plain ? Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-menu-key]:not(:disabled)')).find(button => button.dataset.menuKey === event.key) : undefined;
      if (control) { event.preventDefault(); event.stopPropagation(); control.click(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not(.menu-head-control)'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); event.preventDefault();
    }}>
      <Show when={props.title !== undefined}>
        <header class="menu-head">
          <h2>{page()?.title ?? props.title}</h2>
          <Show when={pages().length} fallback={<button type="button" class="menu-head-control" tabIndex={-1} onClick={() => props.onDismiss()}>Close</button>}>
            <button type="button" class="menu-head-control" tabIndex={-1} onClick={event => back(event.detail === 0)}><Icon name="left" />Back</button>
          </Show>
          <Show when={props.context}><div class="menu-context">{props.context}</div></Show>
        </header>
      </Show>
      <Show when={!pages().length}>{props.header}</Show>
      {/* Rows are keyed by position: callers rebuild their item objects as page state settles, and a recreated button would drop keyboard focus. */}
      <Index each={items()}>{(item, index) => <>
        {item().section && item().section !== items()[index - 1]?.section && <div class="menu-section">{item().section}</div>}
        {item().divider && index > 0 && <hr class="menu-divider" />}
        <button type="button" role={item().checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item().checked} aria-haspopup={item().submenu ? 'menu' : undefined} class={`menu-item ${item().danger ? 'danger' : ''}`} aria-disabled={!!item().disabledReason} aria-describedby={item().disabledReason ? reasonFor(index) : undefined} title={item().disabledReason} onClick={event => run(item(), index, event)}>
          {item().icon ? <Icon name={item().icon!} /> : iconed() ? <span class="icon" /> : null}<span class="menu-label">{item().label}{(item().disabledReason && !sharedReason() || item().secondary) && <span class="menu-disabled-reason" id={`${reasonId}-${index}`}>{sharedReason() ? item().secondary : item().disabledReason || item().secondary}</span>}</span>{item().shortcut && <kbd>{item().shortcut}</kbd>}{item().checked && <Icon name="check" class="menu-check" />}{item().submenu && <Icon name="right" class="menu-drill" />}
        </button>
      </>}</Index>
      <Show when={sharedReason()}>{reason => <p class="menu-note" id={`${reasonId}-shared`}>{reason()}</p>}</Show>
      <Show when={page()?.note}>{note => <p class="menu-note">{note()}</p>}</Show>
    </div>
  </Popup>;
}
