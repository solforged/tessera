import { For } from 'solid-js';
import type { JSX } from 'solid-js';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { Popup } from './Popup';
import type { PopupAnchor } from './Popup';

export interface MenuItem {
  label: string;
  /** Optional heading for a group of adjacent actions. */
  section?: string;
  icon?: IconName;
  shortcut?: string;
  /** A single key that runs the item while the menu has focus, as in a leader menu. */
  key?: string;
  disabledReason?: string;
  danger?: boolean;
  /** The current choice in a set; drawn as a trailing check so the leading icon can name the choice. */
  checked?: boolean;
  action(): void;
}
export function Menu(props: { anchor: PopupAnchor; label: string; items: MenuItem[]; header?: JSX.Element; onDismiss(): void }) {
  const iconed = () => props.items.some(item => item.icon);
  return <Popup anchor={props.anchor} onDismiss={props.onDismiss} role="menu" label={props.label} class="menu">
    <div onKeyDown={event => {
      if (event.isComposing) return;
      const mnemonic = !event.metaKey && !event.ctrlKey && !event.altKey ? props.items.find(item => item.key === event.key && !item.disabledReason) : undefined;
      if (mnemonic) { event.preventDefault(); event.stopPropagation(); props.onDismiss(); mnemonic.action(); return; }
      // Header controls share the menu's mnemonics and arrow-key order.
      const control = !event.metaKey && !event.ctrlKey && !event.altKey ? Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-menu-key]:not(:disabled)')).find(button => button.dataset.menuKey === event.key) : undefined;
      if (control) { event.preventDefault(); event.stopPropagation(); control.click(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); event.preventDefault();
    }}>
      {props.header}
      <For each={props.items}>{item => <>{item.section && <div class="menu-section">{item.section}</div>}<button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked} class={`menu-item ${item.danger ? 'danger' : ''}`} disabled={!!item.disabledReason} title={item.disabledReason} onClick={() => { props.onDismiss(); item.action(); }}>
        {item.icon ? <Icon name={item.icon} /> : iconed() ? <span class="icon" /> : null}<span class="menu-label">{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}{item.checked && <Icon name="check" class="menu-check" />}
      </button></>}</For>
    </div>
  </Popup>;
}
