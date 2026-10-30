import { createContext, createEffect, onCleanup, Show, splitProps, useContext } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Button } from './Button';
import type { ButtonProps } from './Button';

/**
 * What a phone's nav bar says once a page's large title has scrolled under it: prose, never ISO (`Thursday`, with
 * `October 29` beneath). `glass` sets the title in its own glass capsule, for screens whose text runs under the bar.
 * `detail` may carry figures set in mono; `onClick` makes the capsule a button that opens the thing the title measures
 * (the reader's progress card), handed the capsule as its anchor.
 */
export interface BarTitle { title: string; detail?: JSX.Element; glass?: boolean; onClick?(anchor: HTMLElement): void }

/** A pane's nav bar, as its surfaces see it. Pane (shell/App.tsx) provides one to everything it renders. */
export interface PaneChrome {
  /** The slot for a surface's own controls at the right of the bar; undefined except on a phone. */
  end: Accessor<HTMLElement | undefined>;
  /** Replace the inline title the pane derives from its target; undefined puts the derived one back. */
  title(value: BarTitle | undefined): void;
}
export const PaneChromeContext = createContext<PaneChrome>();

/**
 * Controls a surface adds to its pane's phone nav bar, left of the pane's own + and ···. Put NavButton or one NavGroup
 * inside. Renders nothing off a phone, so a surface keeps its desktop controls where they were and shows these instead
 * on a phone.
 */
export function NavEnd(props: { children: JSX.Element }) {
  const chrome = useContext(PaneChromeContext);
  return <Show keyed when={chrome?.end()}>{host => <Portal mount={host} ref={container => container.classList.add('pane-bar-portal')}>{props.children}</Portal>}</Show>;
}

/**
 * The inline title for this surface's pane, shown in the nav bar once the surface's first h1 (or the element marked
 * `data-large-title`) has scrolled under it. Without one the bar shows the pane's own name.
 */
export function NavTitle(props: BarTitle) {
  const chrome = useContext(PaneChromeContext);
  createEffect(() => {
    chrome?.title({ title: props.title, detail: props.detail, glass: props.glass, onClick: props.onClick });
    onCleanup(() => chrome?.title(undefined));
  });
  return null;
}

/** A nav-bar control: a 44 pt glass circle with only an icon, a glass capsule with a label. */
export function NavButton(props: ButtonProps) {
  const [local, rest] = splitProps(props, ['class']);
  return <Button {...rest} class={`nav-button${local.class ? ` ${local.class}` : ''}`} />;
}

/** Two or more NavButtons share one glass capsule, as Today's + and ··· do. */
export function NavGroup(props: { children: JSX.Element; label?: string }) {
  return <div class="nav-group" role="group" aria-label={props.label}>{props.children}</div>;
}
