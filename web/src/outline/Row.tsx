import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { VirtualItem } from '@tanstack/solid-virtual';
import type { QuestionStatus } from '../api/types';
import { fieldEntryId, matchFieldEntry } from '../table/query';
import { linkedCitation, setLinkedCitation } from '../library/highlights';
import { parseCardText } from '../review/card-text';
import { TaskStatusButton } from '../tasks/TaskControls';
import { RunningClock } from '../tasks/WorkSessions';
import { isFinished, taskFacts } from '../tasks/task-labels';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { BlockText } from './BlockText';
import { TypePill } from './references';
import { CitationChip } from './SourceHeader';
import { isGistName } from './gloss';
import { CardSummary } from './CardSummary';
import { formatSourceValue } from './source';
import type { OutlineContext } from './context';
import type { FieldSheet } from './field-sheet';
import { checkboxValue } from '../fields/kinds';

const questionLabels: Record<QuestionStatus, string> = { open: 'Open', answered: 'Answered', parked: 'Parked', unsettled: 'Unsettled' };
export function createOutlineRows(context: Pick<OutlineContext,
  | 'doc' | 'capabilities' | 'setMenu' | 'investigationItems' | 'definitionsById' | 'contextDate'
  | 'inlineFields' | 'baseDepth' | 'positionSource' | 'sourceDetails' | 'virtualizer'
  | 'hosts' | 'props' | 'folds' | 'selectedSet' | 'editing'
  | 'coveredSet' | 'glossId' | 'margin' | 'sigla' | 'blockMenu'
  | 'fold' | 'zoomTo' | 'editAt' | 'pointerStart' | 'attach'
  | 'referenceMenu' | 'selectedOffsets' | 'ids' | 'indices' | 'setMessage' | 'apply'
  | 'setConflicts' | 'conflicts' | 'editedConflicts' | 'setEditedConflicts'
>, sheet: FieldSheet) {
  const {
    doc, capabilities, setMenu, investigationItems, definitionsById, contextDate, inlineFields,
    baseDepth, positionSource, sourceDetails, virtualizer, hosts, props,
    folds, selectedSet, editing, coveredSet, glossId, margin,
    sigla, blockMenu, fold, zoomTo, editAt, pointerStart,
    attach, referenceMenu, selectedOffsets, ids, indices, setMessage, apply,
    setConflicts, conflicts, editedConflicts, setEditedConflicts,
  } = context;
  /**
   * A task's trailing facts: subtask progress, a running clock, then planning in mono, which opens the planning slip.
   * An open task with no plan offers Plan only while its row is hovered or selected; a finished one says when it was done.
   */
  function TaskSummary(propsTask: { id: string }) {
    const task = () => doc.block(propsTask.id)?.task;
    const facts = createMemo(() => { const value = task(); return value ? taskFacts(value, { date: contextDate(), today: props.notebook.todayDate() }) : []; });
    const progress = createMemo(() => {
      let done = 0, total = 0;
      for (const child of doc.outline.children(propsTask.id)) {
        const status = doc.block(child)?.task?.status;
        if (!status || status === 'cancelled') continue;
        total++;
        if (status === 'done') done++;
      }
      return total ? { done, total } : null;
    });
    const running = createMemo(() => { const work = props.notebook.runningWork(); return work?.block_id === propsTask.id ? work : undefined; });
    // Completing a repeating task moves its dates forward; the facts glow once so the move is seen.
    const [advanced, setAdvanced] = createSignal('');
    let glow = 0;
    onCleanup(() => clearTimeout(glow));
    createEffect(on(() => task()?.scheduled ?? task()?.deadline, (next, previous) => {
      if (!task()?.repeater || !next || !previous || next <= previous) return;
      clearTimeout(glow);
      setAdvanced(`Repeats. Next: ${facts()[0]?.label ?? next}`);
      glow = window.setTimeout(() => setAdvanced(''), 1600);
    }, { defer: true }));
    return <Show when={task()}>{value => <>
      <Show when={progress()}>{count => <span class="outline-task-progress" title={`${count().done} of ${count().total} subtasks done`}>{count().done}/{count().total}</span>}</Show>
      <Show when={running()}>{work => <RunningClock session={work()} onOpen={anchor => capabilities.open(propsTask.id, 'work', anchor)} />}</Show>
      <Show when={!isFinished(value())} fallback={<For each={facts()}>{fact => <span class="outline-task-facts" title={fact.label}>{fact.text}</span>}</For>}>
        <Button class={`outline-planning outline-task-facts${facts().length ? '' : ' outline-plan-empty'}${advanced() ? ' outline-task-advanced' : ''}`} label={facts().length ? `Plan task: ${facts().map(fact => fact.label).join(', ')}` : 'Plan task'} disabled={capabilities.busy(propsTask.id)} aria-haspopup="dialog" onClick={event => capabilities.open(propsTask.id, 'task', event.currentTarget)}>
          <Show when={facts().length} fallback="Plan">
            <For each={facts()}>{fact => <span classList={{ 'outline-task-late': !!fact.late }} title={fact.label}>{fact.text}</span>}</For>
          </Show>
        </Button>
      </Show>
      <Show when={advanced()}><span class="visually-hidden" role="status">{advanced()}</span></Show>
    </>}</Show>;
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
    // Values of one entry line up in one column; only the first carries the field's name.
    const labelled = () => { const index = indices().get(id()) ?? 0; return !index || doc.outline.parentOf(ids()[index - 1]!) !== parent(); };
    // A known entry with no live values reads as its label and an empty slot until it is edited.
    const emptyEntry = () => { doc.archivedVersion(); return !!field() && editing() !== id() && !doc.outline.children(id()).some(child => !doc.isArchived(child)); };
    const checked = () => inline() && valueField()?.kind === 'checkbox' && editing() !== id() ? checkboxValue(block()?.text ?? '') : null;
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
      class="outline-row" classList={{ 'row-position': !!block()?.position, 'row-gist': gist(), 'row-question': !!block()?.question, 'row-assessment': !!block()?.assessment, 'row-selected': selectedSet().has(id()) && editing() !== id(), 'row-covered': coveredSet().has(id()), 'row-editing': editing() === id(), 'row-archived': block()?.archived ?? false, 'field-entry': !!field(), 'inline-field-value': inline(), 'row-gloss': inline() && parent() === glossId(), 'choice-value': pill(), 'source-detail': !!sourceField(), 'source-highlights-start': sourceDetails().firstHighlight === id() || sourceDetails().chapters.has(id()), 'outline-row-linked': block()?.citations.some(citation => citation.id === linkedCitation()) ?? false }}
      data-task-status={block()?.task?.status}
      data-holder={block()?.position?.holder_id ?? undefined}
      data-question-status={block()?.question?.status} data-accepted={block()?.assessment ? String(block()!.assessment!.accepted) : undefined} data-aporia={block()?.assessment?.state.aporia ? 'true' : undefined}
      onPointerEnter={() => setLinkedCitation(block()?.citations[0]?.id ?? null)} onPointerLeave={() => setLinkedCitation(null)}
      style={{ transform: `translateY(${propsRow.item().start - margin()}px)`, '--depth': depth() }}>
      <Show when={sourceDetails().firstHighlight === id()}><div class="outline-highlights-label">Highlights <span>{sourceDetails().highlightCount}</span></div></Show>
      <Show when={sourceDetails().chapters.get(id())}>{title => <div class="outline-chapter-label">{title()}</div>}</Show>
      <Show when={rowSource() && sigla().get(rowSource()!)}>{mark => <span class="row-siglum" title={props.notebook.lookup(rowSource()!)()?.text}>{mark()}</span>}</Show>
      <button type="button" class="row-menu icon-button" aria-label="Block actions" onClick={event => blockMenu(id(), event.currentTarget)}><Icon name="more" /></button>
      <button type="button" class="row-fold icon-button" classList={{ 'fold-empty': !children(), folded: folds().has(id()) }} aria-label={folds().has(id()) ? 'Unfold children' : 'Fold children'} disabled={!children()} onClick={() => fold(id())}><Icon name="down" /></button>
      <Show when={!inline() && !emptyEntry()}><button type="button" class="row-bullet icon-button" classList={{ 'bullet-collapsed': children() && folds().has(id()) }} aria-label="Zoom into block" onClick={() => zoomTo(id())}><Icon name="bullet" /></button></Show>
      <Show when={inline()}><Show when={labelled()} fallback={<span class="outline-field-label" aria-hidden="true" />}><button type="button" class="outline-field-label" title={valueField()?.name} onClick={() => editAt(id(), block()?.text.length ?? 0, true)}><Icon name="field" /><span>{valueField()?.name}</span></button></Show></Show>
      <Show when={emptyEntry()}><button type="button" class="outline-field-label" title={field()?.name} onClick={() => editAt(id(), block()?.text.length ?? 0, true)}><Icon name="field" /><span>{field()?.name}</span></button></Show>
      <Show when={block()?.task}><TaskStatusButton task={block()?.task ?? null} disabled={capabilities.busy(id())} onChange={status => capabilities.status(id(), status)} /></Show>
      <div class="outline-body" classList={{ 'heading-1': block()?.heading === 1, 'heading-2': block()?.heading === 2, 'heading-3': block()?.heading === 3 }} onMouseDown={event => pointerStart(event, id(), event.currentTarget)}>
        <div class="outline-source-line"><div class="outline-source">
        <div class="editor-host" classList={{ 'host-active': editing() === id() }} ref={host => attach(id(), host)} />
        <Show when={editing() !== id()}><Switch>
          <Match when={checked() !== null || emptyEntry() && field()?.kind === 'checkbox'}>
            <button type="button" role="checkbox" class="field-checkbox" aria-checked={!!checked()} aria-label={(valueField() ?? field())?.name} onMouseDown={event => event.stopPropagation()} onClick={() => checked() === null ? sheet.fill(id()) : sheet.toggle(id(), checked()!)}><Show when={checked()}><Icon name="check" /></Show></button>
          </Match>
          <Match when={emptyEntry()}><button type="button" class="field-empty-value" onMouseDown={event => event.stopPropagation()} onClick={() => sheet.fill(id())}>Empty</button></Match>
          <Match when>
            <div class="static-text"><span classList={{ 'outline-value-pill': pill() && !!block()?.text }}><BlockText text={displayText()} cards field={field()} notebook={props.notebook} onOpen={props.onOpen} onReferenceMenu={referenceMenu} selection={selectedOffsets(id())} /></span><Show when={!block()?.text && (ids().length === 1 || inline())}><span class="empty-block">{inline() && parent() === glossId() ? 'One or two sentences on what this is' : inline() ? 'Empty' : 'Start writing'}</span></Show></div>
          </Match>
        </Switch></Show>
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
      <sheet.FieldSlots id={id()} />
    </div>;
  }
  return { Row, TaskSummary, QuestionSummary };
}
