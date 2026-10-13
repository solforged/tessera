import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { Accessor, Component } from 'solid-js';
import type { VirtualItem } from '@tanstack/solid-virtual';
import { fieldEntryId, matchFieldEntry } from '../table/query';
import { linkedCitation, setLinkedCitation } from '../library/highlights';
import { cardSubject, parseCardText } from '../review/card-text';
import { TaskStatusButton } from '../tasks/TaskControls';
import { createTaskProjects } from '../projects/task-project';
import { RunningClock } from '../tasks/WorkSessions';
import { isFinished, taskFacts } from '../tasks/task-labels';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { BlockText } from './BlockText';
import { hasCitationDetail, TypePill } from './references';
import { CitationChip } from './SourceHeader';
import { isGistName } from './gloss';
import { CardSummary } from './CardSummary';
import { formatSourceValue } from './source';
import type { OutlineContext } from './context';
import type { FieldSheet } from './field-sheet';
import type { OutlineDrag } from './drag';
import { checkboxValue } from '../fields/kinds';
import { hasValueEditor } from '../fields/value-options';
import { fieldValueProblem } from '../fields/value-reading';
import { KeptCopyActions, KeptCopyLabel } from './KeptCopy';
import { quoteTarget, textTokens } from '../document/text-tokens';
import { Quote, createQuoteStatus } from './Quote';
import { relationLabels } from './relations';
import { AssessmentJournal, QuestionParent, questionLabels } from './Questions';
import { Embed } from './Embed';
import { embedTarget } from './streams';

export function createOutlineRows(context: Pick<OutlineContext,
  | 'doc' | 'capabilities' | 'setMenu' | 'investigationItems' | 'definitionsById' | 'contextDate'
  | 'inlineFields' | 'baseDepth' | 'positionSource' | 'sourceDetails' | 'virtualizer'
  | 'hosts' | 'props' | 'folds' | 'selectedSet' | 'editing'
  | 'coveredSet' | 'glossId' | 'margin' | 'sigla' | 'blockMenu' | 'fieldMenu' | 'openRelation'
  | 'fold' | 'zoomTo' | 'editAt' | 'restoreFocus' | 'pointerStart' | 'attach'
  | 'referenceMenu' | 'selectedOffsets' | 'ids' | 'indices' | 'setMessage' | 'apply'
  | 'setConflicts' | 'conflicts' | 'editedConflicts' | 'setEditedConflicts'
>, sheet: FieldSheet, drag: OutlineDrag, ReferenceCount: Component<{ id: string }>, RowRelations: Component<{ id: string }>, openValueEditor: (id: string, anchor?: HTMLElement) => boolean, RowPrelude: Component<{ id: string }>) {
  const {
    doc, capabilities, setMenu, investigationItems, definitionsById, contextDate, inlineFields,
    baseDepth, positionSource, sourceDetails, virtualizer, hosts, props,
    folds, selectedSet, editing, coveredSet, glossId, margin,
    sigla, blockMenu, fold, zoomTo, editAt, restoreFocus, pointerStart,
    attach, referenceMenu, selectedOffsets, ids, indices, setMessage, apply,
    setConflicts, conflicts, editedConflicts, setEditedConflicts,
  } = context;
  const quoteStatus = createQuoteStatus(doc, props.notebook);
  const taskProjects = createTaskProjects(doc, props.notebook);
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
      <Show when={taskProjects.project(propsTask.id)}>{id => <Show when={id() !== doc.pageId}><span class="outline-task-facts"><BlockText text={props.notebook.lookup(id())()?.text ?? ''} notebook={props.notebook} interactive={false} /></span></Show>}</Show>
      <Show when={advanced()}><span class="visually-hidden" role="status">{advanced()}</span></Show>
    </>}</Show>;
  }

  /** A question's state as one control: its glyph, its state and any review date. Clicking opens the question menu. */
  function QuestionSummary(propsQuestion: { id: string }) {
    return <Show when={doc.block(propsQuestion.id)?.question}>{question => <Button class="outline-planning outline-question" data-question-status={question().status} label="Question" aria-haspopup="menu" disabled={capabilities.busy(propsQuestion.id)}
      onClick={event => setMenu({ anchor: event.currentTarget, label: 'Question', items: investigationItems(propsQuestion.id) })}>
      <Icon name={question().status === 'answered' ? 'question-settled' : 'question-open'} />{questionLabels[question().status]}
      <Show when={question().state.review_on}>{date => <span>Revisit {date()}</span>}</Show>
    </Button>}</Show>;
  }

  /** An assessment's date, whether it is current, and any authored aporia. */
  function AnswerSummary(propsAnswer: { id: string }) {
    return <Show when={doc.block(propsAnswer.id)?.assessment}>{answer => <Button class="outline-planning outline-answer" data-accepted={String(answer().accepted)} label="Assessment" aria-haspopup="menu" disabled={capabilities.busy(propsAnswer.id)}
      onClick={event => setMenu({ anchor: event.currentTarget, label: 'Assessment', items: investigationItems(propsAnswer.id) })}>
      {answer().accepted ? 'Current reading' : 'Assessment'} {answer().state.assessed_on}<Show when={answer().state.aporia}><span>Aporia</span></Show>
    </Button>}</Show>;
  }

  function Row(propsRow: { id: string; item: Accessor<VirtualItem> }) {
    const id = () => propsRow.id;
    const block = () => doc.block(id());
    const children = () => doc.outline.children(id()).length > 0;
    const target = createMemo(() => quoteTarget(block()?.text ?? ''));
    const field = createMemo(() => definitionsById().get(fieldEntryId(block()?.text ?? '') ?? ''));
    const parent = () => doc.outline.parentOf(id());
    const valueField = createMemo(() => definitionsById().get(fieldEntryId(doc.block(parent())?.text ?? '') ?? ''));
    const inline = () => inlineFields().has(parent());
    // Field entries are whole-row links to their definition, and values belong to their field; neither is an embed.
    const embed = createMemo(() => field() || inline() ? undefined : embedTarget(block()?.text ?? ''));
    // Values of one entry line up in one column; only the first carries the field's name.
    const labelled = () => { const index = indices().get(id()) ?? 0; return !index || doc.outline.parentOf(ids()[index - 1]!) !== parent(); };
    // A known entry with no live values reads as its label and an empty slot until it is edited.
    const emptyEntry = () => { doc.archivedVersion(); return !!field() && editing() !== id() && !doc.outline.children(id()).some(child => !doc.isArchived(child)); };
    const checked = () => inline() && valueField()?.kind === 'checkbox' && editing() !== id() ? checkboxValue(block()?.text ?? '') : null;
    const depth = () => (inline() ? doc.outline.depth(parent()) : doc.outline.depth(id())) - baseDepth();
    const pill = () => valueField()?.kind === 'choice' || valueField()?.kind === 'instance';
    const controlledValue = () => hasValueEditor(valueField(), block()?.text ?? '', contextDate());
    const valueProblem = createMemo(() => fieldValueProblem(valueField(), block()?.text ?? ''));
    const valueTarget = createMemo(() => /^\[\[([^\]]+)\]\]$/.exec(block()?.text.trim() ?? '')?.[1]);
    const openValueTarget = async (beside: boolean) => {
      const targetId = valueTarget();
      if (!targetId) return;
      try {
        const target = props.notebook.lookup(targetId)() ?? await props.notebook.api.block(targetId);
        props.onOpen({ kind: 'page', pageId: target.page_id, ...(target.kind === 'block' ? { blockId: target.id } : {}) }, beside);
      } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    };
    const rowSources = createMemo(() => [...new Set([
      ...textTokens(block()?.text ?? '').filter(token => hasCitationDetail(token) && sigla().has(token.id!)).map(token => token.id!),
      ...(block()?.citations.map(citation => citation.source_id) ?? []),
      ...(block()?.position && positionSource(id()) ? [positionSource(id())!] : []),
    ])].filter(source => sigla().has(source)));
    const localCitation = createMemo(() => doc.root()?.source ? block()?.citations.find(citation => citation.source_id === props.pageId) : undefined);
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
    // A descriptor's front names its parent, so the core derives no card under an empty parent.
    const orphanDescriptor = createMemo(() => {
      if (!cards().cards.some(card => card.kind === 'descriptor')) return false;
      const parentText = doc.block(parent())?.text;
      return parentText !== undefined && !cardSubject(parentText);
    });
    const derivedCards = createMemo(() => orphanDescriptor() ? [] : cards().cards);
    const cardProblems = createMemo(() => orphanDescriptor() ? [{ message: 'A descriptor needs a parent with text.' }] : cards().problems);
    const cardCount = () => derivedCards().length + (block()?.templateCards ?? 0);
    const cardMark = () => !block()?.task && cardCount() > 0;
    let cardControl: { open(anchor: HTMLElement): void } | undefined;
    const [cardTextSettled, setCardTextSettled] = createSignal(false);
    createEffect(on([cardText, () => editing() === id()], ([, active]) => {
      setCardTextSettled(false);
      if (!active) return;
      const timer = window.setTimeout(() => setCardTextSettled(true), 1500);
      onCleanup(() => window.clearTimeout(timer));
    }));
    let row!: HTMLDivElement;
    onMount(() => virtualizer.measureElement(row));
    onCleanup(() => { const host = hosts.get(id()); if (host && row.contains(host)) hosts.delete(id()); });
    function StaticText() {
      return <div class="static-text"><span classList={{ 'outline-value-pill': pill() && !!block()?.text, 'outline-reading-problem': !!valueProblem() }} title={valueProblem()}><BlockText text={displayText()} blockId={id()} onError={setMessage} cards field={field()} notebook={props.notebook} onOpen={props.onOpen} onReferenceClick={(token, anchor) => { if (!block()?.position || token.id !== block()?.position?.holder_id || token.start !== textTokens(block()?.text ?? '').find(value => value.kind === 'reference')?.start) return false; context.openRelation(id(), 'holder', anchor); return true; }} onReferenceMenu={referenceMenu} selection={selectedOffsets(id())} /></span><Show when={!block()?.text && inline()}><button type="button" class="field-empty-value" aria-label={`Add ${valueField()?.name} value`} onMouseDown={event => event.stopPropagation()} onClick={() => editAt(id(), 0, true)} /></Show><Show when={!block()?.text && !inline() && ids().length === 1}><span class="empty-block">Start writing</span></Show></div>;
    }
    return <div ref={row} id={`outline-${props.pane}-${id()}`} data-index={propsRow.item().index} data-block-id={id()} role="treeitem" aria-level={depth() + 1}
      aria-expanded={children() ? !folds().has(id()) : undefined} aria-selected={selectedSet().has(id())}
      class="outline-row" classList={{ 'row-position': !!block()?.position, 'row-gist': gist(), 'row-question': !!block()?.question, 'row-assessment': !!block()?.assessment, 'row-selected': selectedSet().has(id()) && editing() !== id(), 'row-covered': coveredSet().has(id()), 'row-editing': editing() === id(), 'row-archived': block()?.archived ?? false, 'field-entry': !!field(), 'inline-field-value': inline(), 'row-gloss': inline() && parent() === glossId(), 'choice-value': pill(), 'source-highlight': !!localCitation(), 'source-highlights-start': sourceDetails().chapters.has(id()), 'outline-row-linked': block()?.citations.some(citation => citation.id === linkedCitation()) ?? false }}
      data-task-status={block()?.task?.status}
      data-holder={block()?.position?.holder_id ?? undefined}
      data-question-status={block()?.question?.status} data-accepted={block()?.assessment ? String(block()!.assessment!.accepted) : undefined} data-aporia={block()?.assessment?.state.aporia ? 'true' : undefined}
      onPointerEnter={() => { setLinkedCitation(block()?.citations[0]?.id ?? null); sheet.hover(id()); }} onPointerLeave={() => { setLinkedCitation(null); sheet.hover(null); }}
      style={{ transform: `translateY(${propsRow.item().start - margin()}px)`, '--depth': depth(), '--quote-color': localCitation()?.color ? `var(--highlight-${localCitation()!.color})` : 'var(--faint)' }}>
      <RowPrelude id={id()} />
      <Show when={sourceDetails().chapters.get(id())}>{title => <div class="outline-chapter-label">{title()}</div>}</Show>
      <Show when={rowSources().length}><span class="row-sigla"><For each={rowSources()}>{source => <span class="row-siglum" title={props.notebook.lookup(source)()?.text}>{sigla().get(source)}</span>}</For></span></Show>
      <button type="button" class="row-menu icon-button" aria-label="Block actions" onPointerDown={event => drag.start(event, id())} onClick={event => blockMenu(id(), event.currentTarget)}><Icon name="more" /></button>
      <button type="button" class="row-fold icon-button" classList={{ 'fold-empty': !children(), folded: folds().has(id()) }} aria-label={folds().has(id()) ? 'Unfold children' : 'Fold children'} disabled={!children()} onClick={() => fold(id())}><Icon name="down" /></button>
      <Show when={!inline() && !emptyEntry()}><button type="button" class="row-bullet icon-button" classList={{ 'bullet-collapsed': children() && folds().has(id()), 'row-card-mark': cardMark() }} aria-label={cardMark() ? `Cards: ${cardCount()}` : 'Zoom into block'} aria-haspopup={cardMark() ? 'dialog' : undefined} onPointerDown={event => drag.start(event, id())} onMouseDown={event => { if (cardMark()) event.preventDefault(); }} onClick={event => cardMark() ? cardControl?.open(event.currentTarget) : zoomTo(id())}><Icon name={cardMark() ? 'card' : 'bullet'} /></button></Show>
      <Show when={inline()}><Show when={labelled()} fallback={<span class="outline-field-label" aria-hidden="true" />}><button type="button" class="outline-field-label" title={valueField()?.name} onClick={event => context.fieldMenu(id(), event.currentTarget)}><Icon name="field" /><span>{valueField()?.name}</span></button></Show></Show>
      <Show when={emptyEntry()}><button type="button" class="outline-field-label" title={field()?.name} onClick={event => context.fieldMenu(id(), event.currentTarget)}><Icon name="field" /><span>{field()?.name}</span></button></Show>
      <Show when={block()?.task}><TaskStatusButton task={block()?.task ?? null} disabled={capabilities.busy(id())} onRestoreFocus={restoreFocus} onChange={status => capabilities.status(id(), status)} /></Show>
      <div class="outline-body" classList={{ 'heading-1': block()?.heading === 1, 'heading-2': block()?.heading === 2, 'heading-3': block()?.heading === 3 }} onMouseDown={event => {
        if (controlledValue() && !(event.target as Element).closest('button, .outline-capability-metadata')) { event.preventDefault(); event.stopPropagation(); }
        else pointerStart(event, id(), event.currentTarget);
      }} onClick={event => {
        if (controlledValue() && !(event.target as Element).closest('button, .outline-capability-metadata')) { event.stopPropagation(); openValueEditor(id(), event.currentTarget); }
      }}>
        <Show when={block()?.keptCopy}>{copy => <KeptCopyLabel copy={copy()} />}</Show>
        <div class="outline-source-line">
        <Show when={block()?.relation}>{relation => <span class="relation-label">{relationLabels[relation().kind]}<Show when={relation().problem}>{problem => <span class="relation-problem" role="img" aria-label={problem()} title={problem()}><Icon name="warning" /></span>}</Show></span>}</Show>
        <div class="outline-source">
        <div class="editor-host" classList={{ 'host-active': editing() === id() }} ref={host => attach(id(), host)} />
        <Show when={editing() !== id()}><Switch>
          <Match when={target()}><Quote id={id()} target={target()!} doc={doc} notebook={props.notebook} status={quoteStatus().get(id())} onOpen={props.onOpen} /></Match>
          <Match when={checked() !== null || emptyEntry() && field()?.kind === 'checkbox'}>
            <button type="button" role="checkbox" class="field-checkbox" aria-checked={!!checked()} aria-label={(valueField() ?? field())?.name} onMouseDown={event => event.stopPropagation()} onClick={() => checked() === null ? sheet.fill(id()) : sheet.toggle(id(), checked()!)}><Show when={checked()}><Icon name="check" /></Show></button>
          </Match>
          <Match when={emptyEntry()}><button type="button" class="field-empty-value" aria-label={`Add ${field()?.name} value`} onMouseDown={event => event.stopPropagation()} onClick={() => sheet.fill(id())} /></Match>
          <Match when={controlledValue()}>
            <div class="static-text"><button type="button" class={!block()?.text ? 'field-empty-value' : pill() ? 'outline-value-pill text-button' : 'outline-value-text'} classList={{ 'outline-reading-problem': !!valueProblem() }} title={valueProblem()} aria-label={`Edit ${valueField()?.name} value`} aria-haspopup={valueField()?.kind !== 'instance' ? 'dialog' : undefined}
              onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
              onClick={event => { event.stopPropagation(); if (valueTarget() && (valueField()?.kind === 'instance' || event.shiftKey)) void openValueTarget(event.shiftKey); else openValueEditor(id(), event.currentTarget); }}>
              <Show when={block()?.text}><BlockText text={displayText()} notebook={props.notebook} interactive={false} /></Show>
            </button></div>
          </Match>
          <Match when={embed()}><Show keyed when={embed()}>{target => <Embed target={target} notebook={props.notebook} onOpen={props.onOpen} fallback={<StaticText />} />}</Show></Match>
          <Match when><StaticText /></Match>
        </Switch></Show>
        <For each={block()?.manual_types ?? []}>{title => <TypePill title={title} notebook={props.notebook} onOpen={props.onOpen} onRestoreFocus={restoreFocus} onRemove={() => { const result = doc.removeType(id(), title); if (!result.ok) setMessage(result.reason); }} />}</For>
        </div>
        <Show when={block()?.task || block()?.project || block()?.question || block()?.assessment || derivedCards().length || block()?.templateCards || block()?.citations.length}><span class="outline-capability-metadata" onMouseDown={event => { if ((event.target as Element).closest('button')) { event.preventDefault(); event.stopPropagation(); } }}>
          <TaskSummary id={id()} />
          <Show when={block()?.project}><Button class="outline-planning" label="Project" aria-haspopup="dialog" onClick={event => capabilities.open(id(), 'project', event.currentTarget)}>Project</Button></Show>
          <QuestionSummary id={id()} />
          <AnswerSummary id={id()} />
          <Show when={cardCount()}><CardSummary blockId={id()} cards={derivedCards()} templateCount={block()?.templateCards ?? 0} notebook={props.notebook} onOpen={props.onOpen} register={control => { cardControl = control; }} /></Show>
          <For each={block()?.citations}>{citation => <CitationChip citation={citation} pageId={props.pageId} notebook={props.notebook} onOpen={props.onOpen} />}</For>
        </span></Show>
        </div>
        <QuestionParent info={block()?.question} notebook={props.notebook} onOpen={props.onOpen} disabled={capabilities.busy(id())} onChange={anchor => capabilities.open(id(), 'question-parent', anchor)}
          onRemove={() => { const question = block()?.question; if (question) { const { parent: _, ...value } = question.state; capabilities.invoke(capabilities.edit(id(), { kind: 'question', id: id(), value })); } }} />
        <Show when={block()?.question}><AssessmentJournal questionId={id()} doc={doc} notebook={props.notebook} onOpen={props.onOpen}
          onWrite={() => apply({ kind: 'writeAssessment', parentId: id(), assessedOn: props.notebook.todayDate() }, true)} /></Show>
        <RowRelations id={id()} />
        <Show when={block()?.keptCopy}><KeptCopyActions id={id()} apply={edit => apply(edit, false)} /></Show>
        <For each={block()?.citations}>{citation => <Show when={block()?.text.trim() !== citation.quote.trim()}>
          <p class="outline-citation-quote" title={citation.quote}>{citation.quote}</p>
        </Show>}</For>
        <Show when={editing() !== id() || cardTextSettled()}><For each={cardProblems()}>{problem => <p class="outline-card-problem" role="status">{problem.message}</p>}</For></Show>
        <Show when={capabilities.error(id())}><p class="outline-capability-error" role="alert">{capabilities.error(id())}</p></Show>
        <Show when={block()?.archived}><span class="archive-badge">Archived</span> <button class="text-button" type="button" onClick={() => apply({ kind: 'archive', id: id(), archived: false }, false)}>Unarchive</button></Show>
        <Show when={block()?.conflict}><button type="button" class="conflict-label" onClick={() => setConflicts(previous => { const next = new Set(previous); next.has(id()) ? next.delete(id()) : next.add(id()); return next; })}><Icon name="warning" />Conflict</button></Show>
        <Show when={block()?.conflict && conflicts().has(id())}><div class="conflict-panel">
          <strong>Your version</strong><pre>{block()?.text}</pre><strong>Notebook version</strong><pre>{block()?.conflict?.remoteText}</pre>
          <div class="conflict-actions"><button type="button" onClick={() => doc.resolveConflict(id(), 'mine')}>Use yours</button><button type="button" onClick={() => doc.resolveConflict(id(), 'theirs')}>Use notebook</button>
            <Show when={!editedConflicts().has(id())} fallback={<button type="button" onClick={() => doc.resolveConflict(id(), 'mine')}>Use edited text</button>}><button type="button" onClick={() => { setEditedConflicts(previous => new Set([...previous, id()])); editAt(id(), 0, true); }}>Edit merged text</button></Show></div>
        </div></Show>
      </div>
      <ReferenceCount id={id()} />
      <sheet.FieldSlots id={id()} />
    </div>;
  }
  return { Row, TaskSummary, QuestionSummary };
}
