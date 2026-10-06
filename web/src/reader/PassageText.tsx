import { For, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Citation, Mark, Passage } from '../api/types';
import { Button } from '../ui/Button';
import { citationRange, passageSegments } from './passages';

export function PassageText(props: {
  passage: Passage;
  citations: Citation[];
  ordinals: ReadonlyMap<string, number>;
  flashId: string | null;
  onLocate(locator: string): void;
  onNote(locator: string, anchor: HTMLElement): void;
  onCitation(citations: Citation[], anchor: HTMLElement, beside: boolean): void;
}) {
  const segments = createMemo(() => passageSegments(props.passage, props.citations.flatMap(citation => citationRange(props.passage, citation, props.ordinals) ?? []), props.flashId));
  const marked = (text: JSX.Element, marks: readonly Mark[], linked = true, index = 0): JSX.Element => {
    const mark = marks[index];
    if (!mark) return text;
    const content = marked(text, marks, linked, index + 1);
    const kind = mark.kind;
    switch (kind.kind) {
      case 'emphasis': return <em>{content}</em>;
      case 'strong': return <strong>{content}</strong>;
      case 'code': return <code>{content}</code>;
      case 'link': return linked && /^(https?:|mailto:)/i.test(kind.href) ? <a href={kind.href} target="_blank" rel="noopener noreferrer">{content}</a> : content;
      case 'internal': return linked ? <Button class="reader-inline-link" onClick={() => props.onLocate(kind.locator)}>{content}</Button> : content;
      case 'note_ref': return <sup>{linked ? <Button class="reader-inline-link" onClick={event => props.onNote(kind.locator, event.currentTarget)}>{content}</Button> : content}</sup>;
    }
  };
  return <For each={segments()}>{segment => segment.citations.length ? <span class={`reader-highlight${segment.citations[0]!.color ? ` reader-highlight-${segment.citations[0]!.color}` : ''}`} classList={{ 'reader-flash': segment.flash, 'reader-highlight-overlap': segment.citations.length > 1 }} data-citation-id={segment.citations[0]!.id} role="button" aria-haspopup="menu" tabIndex={0}
    onClick={event => { if (!window.getSelection()?.isCollapsed) return; event.preventDefault(); event.stopPropagation(); props.onCitation(segment.citations, event.currentTarget, event.shiftKey); }}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); props.onCitation(segment.citations, event.currentTarget, event.shiftKey); } }}
  >{marked(segment.text, segment.marks, false)}</span> : marked(segment.text, segment.marks)}</For>;
}
