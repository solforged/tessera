import { Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { Button } from './Button';
import { Icon } from './Icon';
import './section-head.css';

/**
 * The content section head shared by Today's sections and Agenda's groups: the name in Piazzolla, a hairline rule,
 * a mono count or state, then at most one action. A foldable head puts its chevron before the name.
 */
export function SectionHead(props: {
  name: JSX.Element;
  count?: JSX.Element;
  /** Tints only the name, as Overdue does. */
  tone?: 'danger';
  /** Present on foldable heads; a folded head dims its name. */
  open?: boolean;
  onToggle?(): void;
  /** The controlled region, when the head folds one. */
  controls?: string;
  id?: string;
  class?: string;
  /** At most one bordered button or menu trigger. */
  children?: JSX.Element;
}) {
  const title = () => <span class="section-head-name" classList={{ 'section-head-danger': props.tone === 'danger' }}>{props.name}</span>;
  return <h2 id={props.id} class={`section-head${props.class ? ` ${props.class}` : ''}`} classList={{ 'section-head-folded': !!props.onToggle && !props.open }}>
    <Show when={props.onToggle} fallback={title()}>
      <Button class="section-head-toggle" aria-expanded={!!props.open} aria-controls={props.controls} onClick={() => props.onToggle?.()}><Icon name="down" />{title()}</Button>
    </Show>
    <span class="section-rule" />
    <Show when={props.count !== undefined && props.count !== ''}><span class="section-head-count">{props.count}</span></Show>
    <Show when={props.children}><span class="section-head-action">{props.children}</span></Show>
  </h2>;
}

/** A group inside a section, such as one of Upcoming's days: a sans name and a faint qualifier, without a rule. */
export function SectionSubhead(props: { name: JSX.Element; detail?: JSX.Element }) {
  return <h3 class="section-subhead"><span>{props.name}</span><Show when={props.detail}><span class="section-subhead-detail">{props.detail}</span></Show></h3>;
}
