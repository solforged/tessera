import { opensBeside } from '../shell/beside';
import { For, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Citation, HighlightRow, Mark, Passage } from '../api/types';
import { linkedCitation, setLinkedCitation } from '../library/highlights';
import { Button } from '../ui/Button';
import { citationRange, passageSegments } from './passages';

export function PassageText(props: {
  passage: Passage;
  citations: Citation[];
  notes: ReadonlyMap<string, HighlightRow>;
  ordinals: ReadonlyMap<string, number>;
  flashId: string | null;
  /** A highlight just made, drawn under its words once. */
  inkId: string | null;
  onLocate(locator: string): void;
  onNote(locator: string, anchor: HTMLElement): void;
  onCitation(citations: Citation[], anchor: HTMLElement, beside: boolean): void;
  onHighlightNote(row: HighlightRow): void;
}) {
  const segments = createMemo(() => passageSegments(props.passage, props.citations.flatMap(citation => citationRange(props.passage, citation, props.ordinals) ?? []), props.flashId));
  const focusSegments = createMemo(() => {
    const targets = new Map<string, number>();
    for (const segment of segments()) for (const citation of segment.citations) {
      if (citation.start.passage_id === props.passage.id && segment.text.trim() && !targets.has(citation.id)) targets.set(citation.id, segment.start);
    }
    return targets;
  });
  const marked = (text: JSX.Element, marks: readonly Mark[], index = 0): JSX.Element => {
    const mark = marks[index];
    if (!mark) return text;
    const content = marked(text, marks, index + 1);
    const kind = mark.kind;
    switch (kind.kind) {
      case 'emphasis': return <em>{content}</em>;
      case 'strong': return <strong>{content}</strong>;
      case 'code': return <code>{content}</code>;
      case 'link': return /^(https?:|mailto:)/i.test(kind.href) ? <a href={kind.href} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}>{content}</a> : content;
      case 'internal': return <Button class="reader-inline-link" onClick={event => { event.stopPropagation(); props.onLocate(kind.locator); }}>{content}</Button>;
      case 'note_ref': return <sup><Button class="reader-inline-link reader-note-ref" data-note-locator={kind.locator} onClick={event => { event.stopPropagation(); props.onNote(kind.locator, event.currentTarget); }}>{content}</Button></sup>;
    }
  };
  return <For each={segments()}>{segment => segment.citations.length ? <>
    <span class={`reader-highlight${segment.citations[0]!.color ? ` reader-highlight-${segment.citations[0]!.color}` : ''}`} classList={{ 'reader-flash': segment.flash, 'reader-highlight-ink': segment.citations.some(citation => citation.id === props.inkId), 'reader-highlight-overlap': segment.citations.length > 1, 'reader-highlight-linked': segment.citations.some(citation => citation.id === linkedCitation()) }} data-citation-id={segment.citations[0]!.id} role={focusSegments().get(segment.citations[0]!.id) === segment.start ? 'button' : undefined} aria-haspopup={focusSegments().get(segment.citations[0]!.id) === segment.start ? 'menu' : undefined} aria-label={focusSegments().get(segment.citations[0]!.id) === segment.start ? `Actions for highlight: ${segment.citations[0]!.quote}` : undefined} tabIndex={focusSegments().get(segment.citations[0]!.id) === segment.start ? 0 : undefined}
      onPointerEnter={() => setLinkedCitation(segment.citations[0]!.id)} onPointerLeave={() => setLinkedCitation(null)}
      onMouseDown={event => { if (event.button === 0) event.currentTarget.focus({ preventScroll: true }); }}
      onClick={event => { if (!window.getSelection()?.isCollapsed) return; event.preventDefault(); event.stopPropagation(); props.onCitation(segment.citations, event.currentTarget, opensBeside(event)); }}
      onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); props.onCitation(segment.citations, event.currentTarget, opensBeside(event)); } }}
    >{marked(segment.text, segment.marks)}</span>
    <For each={segment.citations.flatMap(citation => {
      const row = props.notes.get(citation.id);
      return row && citation.end.passage_id === props.passage.id && citation.end.offset === segment.end ? [row] : [];
    })}>{row => <Button class="reader-highlight-note" icon="note" label="Open atom" title="Open atom" onPointerDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); props.onHighlightNote(row); }} />}</For>
  </> : marked(segment.text, segment.marks)}</For>;
}
