import { For } from 'solid-js';
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
  disabledReason?: string;
  danger?: boolean;
  action(): void;
}
export function Menu(props: { anchor: PopupAnchor; label: string; items: MenuItem[]; onDismiss(): void }) {
  const iconed = () => props.items.some(item => item.icon);
  return <Popup anchor={props.anchor} onDismiss={props.onDismiss} role="menu" label={props.label} class="menu">
    <div onKeyDown={event => {
      if (event.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); event.preventDefault();
    }}>
      <For each={props.items}>{item => <>{item.section && <div class="menu-section">{item.section}</div>}<button type="button" role="menuitem" class={`menu-item ${item.danger ? 'danger' : ''}`} disabled={!!item.disabledReason} title={item.disabledReason} onClick={() => { props.onDismiss(); item.action(); }}>
        {item.icon ? <Icon name={item.icon} /> : iconed() ? <span class="icon" /> : null}<span class="menu-label">{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
      </button></>}</For>
    </div>
  </Popup>;
}
