import { For, Show, createMemo, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { VirtualItem } from '@tanstack/solid-virtual';
import type { QuestionStatus } from '../api/types';
import { fieldEntryId, matchFieldEntry } from '../table/query';
import { linkedCitation, setLinkedCitation } from '../library/highlights';
import { parseCardText } from '../review/card-text';
import { TaskStatusButton } from '../tasks/TaskControls';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { BlockText } from './BlockText';
import { TypePill } from './references';
import { CitationChip } from './SourceHeader';
import { isGistName } from './gloss';
import { CardSummary } from './CardSummary';
import { formatSourceValue } from './source';
import type { OutlineContext } from './context';

const questionLabels: Record<QuestionStatus, string> = { open: 'Open', answered: 'Answered', parked: 'Parked', unsettled: 'Unsettled' };
export function createOutlineRows(context: Pick<OutlineContext,
  | 'doc' | 'capabilities' | 'setMenu' | 'investigationItems' | 'definitionsById'
  | 'inlineFields' | 'baseDepth' | 'positionSource' | 'sourceDetails' | 'virtualizer'
  | 'hosts' | 'props' | 'folds' | 'selectedSet' | 'editing'
  | 'coveredSet' | 'glossId' | 'margin' | 'sigla' | 'blockMenu'
  | 'fold' | 'zoomTo' | 'editAt' | 'pointerStart' | 'attach'
  | 'referenceMenu' | 'selectedOffsets' | 'ids' | 'setMessage' | 'apply'
  | 'setConflicts' | 'conflicts' | 'editedConflicts' | 'setEditedConflicts'
>) {
  const {
    doc, capabilities, setMenu, investigationItems, definitionsById, inlineFields,
    baseDepth, positionSource, sourceDetails, virtualizer, hosts, props,
    folds, selectedSet, editing, coveredSet, glossId, margin,
    sigla, blockMenu, fold, zoomTo, editAt, pointerStart,
    attach, referenceMenu, selectedOffsets, ids, setMessage, apply,
    setConflicts, conflicts, editedConflicts, setEditedConflicts,
  } = context;
  function TaskSummary(propsTask: { id: string }) {
    return <Show when={doc.block(propsTask.id)?.task}>{task => <Button class="outline-planning" label="Plan task" disabled={capabilities.busy(propsTask.id)} aria-haspopup="dialog" onClick={event => capabilities.open(propsTask.id, 'task', event.currentTarget)}>
      <Show when={task().scheduled}><span aria-label={`Scheduled: ${task().scheduled}${task().scheduled_time ? ` ${task().scheduled_time}` : ''}`}>Scheduled {task().scheduled} {task().scheduled_time}</span></Show>
      <Show when={task().deadline}><span aria-label={`Deadline: ${task().deadline}${task().deadline_time ? ` ${task().deadline_time}` : ''}`}>Deadline {task().deadline} {task().deadline_time}</span></Show>
      <Show when={task().priority}><span>Priority: {task().priority}</span></Show>
      <Show when={task().repeater}>{repeat => <span aria-label={`Repeat: ${repeat().mode}, every ${repeat().every} ${repeat().unit}`}>Repeat {repeat().every} {repeat().unit}</span>}</Show>
      <Show when={!task().scheduled && !task().deadline && !task().priority && !task().repeater}>Plan task</Show>
    </Button>}</Show>;
  }

  /** A question's state as one control: its glyph, its state and any review date. Clicking opens the question menu. */
  function QuestionSummary(propsQuestion: { id: string }) {
    return <Show when={doc.block(propsQuestion.id)?.question}>{question => <Button class="outline-planning outline-question" data-question-status={question().status} label="Question" aria-haspopup="menu" disabled={capabilities.busy(propsQuestion.id)}
      onClick={event => setMenu({ anchor: event.currentTarget, label: 'Question', items: investigationItems(propsQuestion.id) })}>
      <Icon name={question().status === 'answered' ? 'question-settled' : 'question-open'} />{questionLabels[question().status]}
      <Show when={question().state.review_on}>{date => <span>Review {date()}</span>}</Show>
    </Button>}</Show>;
  }

  /** An answer's date, whether its question accepted it, and aporia when it records that no answer holds. */
  function AnswerSummary(propsAnswer: { id: string }) {
    return <Show when={doc.block(propsAnswer.id)?.assessment}>{answer => <Button class="outline-planning outline-answer" data-accepted={String(answer().accepted)} label="Answer" aria-haspopup="menu" disabled={capabilities.busy(propsAnswer.id)}
      onClick={event => setMenu({ anchor: event.currentTarget, label: 'Answer', items: investigationItems(propsAnswer.id) })}>
      {answer().accepted ? 'Accepted' : 'Answer'} {answer().state.assessed_on}<Show when={answer().state.aporia}><span>Aporia</span></Show>
    </Button>}</Show>;
  }

  function Row(propsRow: { id: string; item: Accessor<VirtualItem> }) {
    const id = () => propsRow.id;
    const block = () => doc.block(id());
    const children = () => doc.outline.children(id()).length > 0;
    const field = createMemo(() => definitionsById().get(fieldEntryId(block()?.text ?? '') ?? ''));
    const parent = () => doc.outline.parentOf(id());
    const valueField = createMemo(() => definitionsById().get(fieldEntryId(doc.block(parent())?.text ?? '') ?? ''));
    const inline = () => inlineFields().has(parent());
    const depth = () => (inline() ? doc.outline.depth(parent()) : doc.outline.depth(id())) - baseDepth();
    const pill = () => valueField()?.kind === 'choice' || valueField()?.kind === 'instance';
    const rowSource = createMemo(() => block()?.citations[0]?.source_id ?? (block()?.position ? positionSource(id()) : null));
    const gist = () => inline() && isGistName(valueField()?.name) && !!doc.block(doc.outline.parentOf(parent()))?.position;
    const sourceField = createMemo(() => sourceDetails().fields.get(id()) ?? sourceDetails().fields.get(parent()));
    const displayText = createMemo(() => {
      const text = block()?.text ?? '';
      const name = sourceField();
      if (!name) return text;
      if (sourceDetails().fields.has(parent())) return formatSourceValue(name, text);
      const entry = matchFieldEntry(text);
      return entry ? `${entry.name}:: ${formatSourceValue(name, entry.value)}` : text;
    });
    const cardText = createMemo(() => block()?.text ?? '');
    const cards = createMemo(() => parseCardText(cardText()));
    let row!: HTMLDivElement;
    onMount(() => virtualizer.measureElement(row));
    onCleanup(() => { const host = hosts.get(id()); if (host && row.contains(host)) hosts.delete(id()); });
    return <div ref={row} id={`outline-${props.pane}-${id()}`} data-index={propsRow.item().index} data-block-id={id()} role="treeitem" aria-level={depth() + 1}
      aria-expanded={children() ? !folds().has(id()) : undefined} aria-selected={selectedSet().has(id())}
      class="outline-row" classList={{ 'row-position': !!block()?.position, 'row-gist': gist(), 'row-question': !!block()?.question, 'row-assessment': !!block()?.assessment, 'row-selected': selectedSet().has(id()) && editing() !== id(), 'row-covered': coveredSet().has(id()), 'row-editing': editing() === id(), 'row-archived': block()?.archived ?? false, 'field-entry': !!field(), 'inline-field-value': inline(), 'row-gloss': inline() && parent() === glossId(), 'choice-value': pill(), 'source-detail': !!sourceField(), 'source-highlights-start': sourceDetails().firstHighlight === id(), 'outline-row-linked': block()?.citations.some(citation => citation.id === linkedCitation()) ?? false }}
      data-holder={block()?.position?.holder_id ?? undefined}
      data-question-status={block()?.question?.status} data-accepted={block()?.assessment ? String(block()!.assessment!.accepted) : undefined} data-aporia={block()?.assessment?.state.aporia ? 'true' : undefined}
      onPointerEnter={() => setLinkedCitation(block()?.citations[0]?.id ?? null)} onPointerLeave={() => setLinkedCitation(null)}
      style={{ transform: `translateY(${propsRow.item().start - margin()}px)`, '--depth': depth() }}>
      <Show when={sourceDetails().firstHighlight === id()}><div class="outline-highlights-label">Highlights <span>{sourceDetails().highlightCount}</span></div></Show>
      <Show when={rowSource() && sigla().get(rowSource()!)}>{mark => <span class="row-siglum" title={props.notebook.lookup(rowSource()!)()?.text}>{mark()}</span>}</Show>
      <button type="button" class="row-menu icon-button" aria-label="Block actions" onClick={event => blockMenu(id(), event.currentTarget)}><Icon name="more" /></button>
      <button type="button" class="row-fold icon-button" classList={{ 'fold-empty': !children(), folded: folds().has(id()) }} aria-label={folds().has(id()) ? 'Unfold children' : 'Fold children'} disabled={!children()} onClick={() => fold(id())}><Icon name="down" /></button>
      <Show when={!inline()}><button type="button" class="row-bullet icon-button" classList={{ 'bullet-collapsed': children() && folds().has(id()) }} aria-label="Zoom into block" onClick={() => zoomTo(id())}><Icon name="bullet" /></button></Show>
      <Show when={inline()}><button type="button" class="outline-field-label" title={valueField()?.name} onClick={() => editAt(id(), block()?.text.length ?? 0, true)}><Icon name="field" /><span>{valueField()?.name}</span></button></Show>
      <Show when={block()?.task}><TaskStatusButton task={block()?.task ?? null} disabled={capabilities.busy(id())} onChange={status => capabilities.status(id(), status)} /></Show>
      <div class="outline-body" classList={{ 'heading-1': block()?.heading === 1, 'heading-2': block()?.heading === 2, 'heading-3': block()?.heading === 3 }} onMouseDown={event => pointerStart(event, id(), event.currentTarget)}>
        <div class="outline-source-line"><div class="outline-source">
        <div class="editor-host" classList={{ 'host-active': editing() === id() }} ref={host => attach(id(), host)} />
        <Show when={editing() !== id()}><div class="static-text"><span classList={{ 'outline-value-pill': pill() }}><BlockText text={displayText()} cards field={field()} notebook={props.notebook} onOpen={props.onOpen} onReferenceMenu={referenceMenu} selection={selectedOffsets(id())} /></span><Show when={!block()?.text && (ids().length === 1 || (inline() && parent() === glossId()))}><span class="empty-block">{inline() && parent() === glossId() ? 'One or two sentences on what this is' : 'Start writing'}</span></Show></div></Show>
        <For each={block()?.manual_types ?? []}>{title => <TypePill title={title} notebook={props.notebook} onOpen={props.onOpen} onRemove={() => { const result = doc.removeType(id(), title); if (!result.ok) setMessage(result.reason); }} />}</For>
        </div>
        <Show when={block()?.task || block()?.project || block()?.question || block()?.assessment || cards().cards.length || block()?.citations.length}><span class="outline-capability-metadata">
          <TaskSummary id={id()} />
          <Show when={block()?.project}><Button class="outline-planning" label="Project" aria-haspopup="dialog" onClick={event => capabilities.open(id(), 'project', event.currentTarget)}>Project</Button></Show>
          <QuestionSummary id={id()} />
          <AnswerSummary id={id()} />
          <Show when={cards().cards.length}><CardSummary blockId={id()} cards={cards().cards} notebook={props.notebook} onOpen={props.onOpen} /></Show>
          <For each={block()?.citations}>{citation => <CitationChip citation={citation} pageId={props.pageId} notebook={props.notebook} onOpen={props.onOpen} />}</For>
        </span></Show>
        </div>
        <For each={block()?.citations}>{citation => <Show when={block()?.text.trim() !== citation.quote.trim()}>
          <p class="outline-citation-quote" title={citation.quote}>{citation.quote}</p>
        </Show>}</For>
        <For each={cards().problems}>{problem => <p class="outline-card-problem" role="alert">{problem.message}</p>}</For>
        <Show when={capabilities.error(id())}><p class="outline-capability-error" role="alert">{capabilities.error(id())}</p></Show>
        <Show when={block()?.archived}><span class="archive-badge">Archived</span> <button class="text-button" type="button" onClick={() => apply({ kind: 'archive', id: id(), archived: false }, false)}>Unarchive</button></Show>
        <Show when={block()?.conflict}><button type="button" class="conflict-label" onClick={() => setConflicts(previous => { const next = new Set(previous); next.has(id()) ? next.delete(id()) : next.add(id()); return next; })}><Icon name="warning" />Conflict</button></Show>
        <Show when={block()?.conflict && conflicts().has(id())}><div class="conflict-panel">
          <strong>Your version</strong><pre>{block()?.text}</pre><strong>Notebook version</strong><pre>{block()?.conflict?.remoteText}</pre>
          <div class="conflict-actions"><button type="button" onClick={() => doc.resolveConflict(id(), 'mine')}>Use yours</button><button type="button" onClick={() => doc.resolveConflict(id(), 'theirs')}>Use notebook</button>
            <Show when={!editedConflicts().has(id())} fallback={<button type="button" onClick={() => doc.resolveConflict(id(), 'mine')}>Use edited text</button>}><button type="button" onClick={() => { setEditedConflicts(previous => new Set([...previous, id()])); editAt(id(), 0, true); }}>Edit merged text</button></Show></div>
        </div></Show>
      </div>
    </div>;
  }
  return { Row, TaskSummary, QuestionSummary };
}
