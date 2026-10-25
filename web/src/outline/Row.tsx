import { opensBeside } from '../shell/beside';
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { Accessor, Component } from 'solid-js';
import type { VirtualItem } from '@tanstack/solid-virtual';
import type { FieldDefinition } from '../api/types';
import { fieldEntryId, matchFieldEntry } from '../table/query';
import { linkedCitation, setLinkedCitation } from '../library/highlights';
import { highlightProse } from '../library/query';
import { cardSubject, occlusionCards, parseCardText } from '../review/card-text';
import { TaskStatusButton } from '../tasks/TaskControls';
import { createTaskProjects } from '../projects/task-project';
import { RunningClock, workDuration } from '../tasks/WorkSessions';
import { isFinished, taskFacts } from '../tasks/task-labels';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { BlockText } from './BlockText';
import { plainText, tagLabel } from './names';
import { titleKey } from '../document/title-key';
import { TypePill } from './references';
import { isCapabilityTag } from './capabilities';
import { hasCitationDetail } from './source-reads';
import { CitationChip } from './SourceHeader';
import { fieldRole } from '../fields/roles';
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
import { AgentMark } from '../agent/AgentMark';
import { embedTarget } from './streams';
import { ViewEmbed, viewEmbedTarget } from './ViewEmbed';
import { MissingSections, ReadingCreators, SectionCapture } from './journal-sections';
import { requestCreate } from '../create/request';
import type { JournalLayout } from './journal-sections';
import { SectionHead } from '../ui/SectionHead';
import { NotebookImage } from '../ui/NotebookImage';
import './image.css';

export function createOutlineRows(context: Pick<OutlineContext,
  | 'doc' | 'capabilities' | 'setMenu' | 'investigationItems' | 'definitionsById' | 'contextDate'
  | 'inlineFields' | 'baseDepth' | 'positionSource' | 'sourceDetails' | 'virtualizer'
  | 'hosts' | 'props' | 'folds' | 'selectedSet' | 'editing'
  | 'coveredSet' | 'openRelation' | 'fileAll' | 'openPlanning' | 'glossId' | 'margin' | 'sigla' | 'blockMenu' | 'holderMenu' | 'fieldMenu'
  | 'fold' | 'zoomTo' | 'editAt' | 'restoreFocus' | 'pointerStart' | 'attach' | 'setSelected'
  | 'referenceMenu' | 'selectedOffsets' | 'ids' | 'indices' | 'setMessage' | 'apply'
  | 'setConflicts' | 'conflicts' | 'editedConflicts' | 'setEditedConflicts'
  | 'openImage'
>, sheet: FieldSheet, drag: OutlineDrag, ReferenceCount: Component<{ id: string }>, RowRelations: Component<{ id: string }>, openValueEditor: (id: string, anchor?: HTMLElement) => boolean, RowPrelude: Component<{ id: string }>, DiscoveryHints: Component<{ id: string }>, journal: Accessor<JournalLayout | null>) {
  const {
    doc, capabilities, setMenu, investigationItems, definitionsById, contextDate, inlineFields,
    baseDepth, positionSource, sourceDetails, virtualizer, hosts, props,
    folds, selectedSet, editing, coveredSet, glossId, margin,
    sigla, blockMenu, holderMenu, fold, zoomTo, editAt, restoreFocus, pointerStart,
    attach, referenceMenu, selectedOffsets, ids, indices, setMessage, apply,
    setConflicts, conflicts, editedConflicts, setEditedConflicts,
  } = context;
  const quoteStatus = createQuoteStatus(doc, props.notebook);
  const taskProjects = createTaskProjects(doc, props.notebook);
  /**
   * A task's trailing facts: subtask progress, running or logged work, then planning in mono, which opens its field bed.
   * An open task with no plan offers Plan only while its row is hovered or selected; a finished one says when it was done.
   */
  function TaskSummary(propsTask: { id: string }) {
    const task = () => doc.block(propsTask.id)?.task;
    const logged = () => doc.block(propsTask.id)?.loggedWorkMs ?? 0;
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
      <Show when={!running() && logged() > 0}><Button class="outline-planning outline-task-logged" label={`${workDuration(logged()).slice(0, -3)} logged · open work sessions`} disabled={capabilities.busy(propsTask.id)} aria-haspopup="dialog" onClick={event => capabilities.open(propsTask.id, 'work', event.currentTarget)}>{workDuration(logged()).slice(0, -3)} logged</Button></Show>
      <Show when={!isFinished(value())} fallback={<For each={facts()}>{fact => <span class="outline-task-facts" title={fact.label}>{fact.text}</span>}</For>}>
        <Button class={`outline-planning outline-task-facts${facts().length ? '' : ' outline-plan-empty'}${advanced() ? ' outline-task-advanced' : ''}`} label={facts().length ? `Plan task: ${facts().map(fact => fact.label).join(', ')}` : 'Plan task'} disabled={capabilities.busy(propsTask.id)} aria-haspopup="dialog" onClick={event => capabilities.open(propsTask.id, 'task', event.currentTarget)}>
          <Show when={facts().length} fallback={<><Icon name="calendar" />Plan</>}>
            <For each={facts()}>{fact => <span onClick={event => { event.stopPropagation(); capabilities.open(propsTask.id, fact.field, event.currentTarget); }}><Show when={fact.priority} fallback={<span classList={{ 'outline-task-late': !!fact.late, 'outline-task-warning': !!fact.warning }} title={fact.label}>{fact.text}</span>}>{priority => <span class="outline-task-priority" data-priority={priority()} title={fact.label}>{fact.text}</span>}</Show></span>}</For>
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
      onClick={event => setMenu({ anchor: event.currentTarget, label: 'Question', title: 'Question', context: plainText(doc.block(propsQuestion.id)?.text ?? '', target => props.notebook.lookup(target)), items: investigationItems(propsQuestion.id, true) })}>
      <Icon name={question().status === 'answered' ? 'question-settled' : 'question-open'} />{questionLabels[question().status]}
      <Show when={question().state.review_on}>{date => <span>Revisit {date()}</span>}</Show>
    </Button>}</Show>;
  }

  /** An assessment's date, whether it is current, and any authored aporia. */
  function AnswerSummary(propsAnswer: { id: string }) {
    return <Show when={doc.block(propsAnswer.id)?.assessment}>{answer => <Button class="outline-planning outline-answer" data-accepted={String(answer().accepted)} label="Assessment" aria-haspopup="menu" disabled={capabilities.busy(propsAnswer.id)}
      onClick={event => setMenu({ anchor: event.currentTarget, label: 'Assessment', title: 'Assessment', context: plainText(doc.block(propsAnswer.id)?.text ?? '', target => props.notebook.lookup(target)), items: investigationItems(propsAnswer.id, true) })}>
      {answer().accepted ? 'Current answer' : 'Assessment'} {answer().state.assessed_on}<Show when={answer().state.aporia}><span>Aporia</span></Show>
    </Button>}</Show>;
  }

  /** A relation's link and edit action are distinct; every value keeps its actual block identity. */
  function FieldValue(valueProps: { id: string; field: FieldDefinition }) {
    const block = () => doc.block(valueProps.id);
    const text = () => block()?.text ?? '';
    const target = createMemo(() => valueProps.field.kind === 'instance' ? /^\[\[([^\]]+)\]\]$/.exec(text().trim())?.[1] : undefined);
    const label = () => target() ? plainText(props.notebook.lookup(target()!)()?.text ?? text(), id => props.notebook.lookup(id)) : '';
    const problem = createMemo(() => fieldValueProblem(valueProps.field, text()));
    const edit = (anchor: HTMLElement) => {
      context.setSelected(valueProps.id);
      if (!openValueEditor(valueProps.id, anchor)) editAt(valueProps.id, text().length, true);
    };
    const open = async (beside: boolean) => {
      const targetId = target();
      if (!targetId) return;
      try {
        const target = props.notebook.lookup(targetId)() ?? await props.notebook.api.block(targetId);
        props.onOpen({ kind: 'page', pageId: target.page_id, ...(target.kind === 'block' ? { blockId: target.id } : {}) }, beside);
      } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    };
    const checked = () => valueProps.field.kind === 'checkbox' && text().trim() ? checkboxValue(text()) : null;
    return <span class="outline-value-cell" data-value-kind={valueProps.field.kind}>
      <Show when={checked() !== null} fallback={<>
        <button type="button" class={!text().trim() ? 'field-empty-value' : valueProps.field.kind === 'choice' || valueProps.field.kind === 'instance' ? 'outline-value-pill text-button' : 'outline-value-text'}
          classList={{ 'outline-reading-problem': !!problem() }} title={problem()} aria-label={target() ? `Open ${label()}` : `${text().trim() ? 'Edit' : 'Add'} ${valueProps.field.name} value`}
          aria-haspopup={!target() && hasValueEditor(valueProps.field, text(), contextDate()) ? 'dialog' : undefined}
          onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
          onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); edit(event.currentTarget); } }}
          onClick={event => { event.stopPropagation(); if (target()) void open(opensBeside(event)); else edit(event.currentTarget); }}>
          <Show when={text().trim()} fallback={<span class="field-slot-add">Add…</span>}><BlockText text={text()} notebook={props.notebook} citationApparatus={fieldRole(valueProps.field) === 'citation'} interactive={false} /></Show>
        </button>
        <Show when={target()}><button type="button" class="outline-value-edit icon-button" aria-label={`Edit ${valueProps.field.name} value`} title={`Edit ${valueProps.field.name} value (F2)`} aria-haspopup="dialog"
          onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); edit(event.currentTarget); }}><Icon name="edit" /></button></Show>
      </>}>
        <button type="button" role="checkbox" class="field-checkbox" aria-checked={!!checked()} aria-label={valueProps.field.name}
          onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); sheet.toggle(valueProps.id, checked()!); }}><Show when={checked()}><Icon name="check" /></Show></button>
      </Show>
    </span>;
  }

  function Row(propsRow: { id: string; item?: Accessor<VirtualItem>; natural?: boolean; placeholder?: string }) {
    const id = () => propsRow.id;
    const block = () => doc.block(id());
    const children = () => doc.outline.children(id()).length > 0;
    // Today draws its written sections' headings as section heads, Notes before its first row, and Inbox clocks.
    const sectionHead = () => journal()?.heads.get(id());
    const notesHead = () => { const head = journal()?.notesHead; return head?.id === id() ? head.name : undefined; };
    const missingBefore = () => journal()?.missing.before.get(id());
    const captureTime = () => journal()?.times.get(id());
    const inboxRow = () => !!journal()?.inbox.has(id());
    const readingSource = () => journal()?.reading.get(id());
    // A captured link reads as a link: one bare or titled web address.
    const linkRow = () => /^(?:https?:\/\/\S+|\[[^\]\r\n]+\]\(https?:\/\/[^\s)]+\))$/i.test(block()?.text.trim() ?? '');
    /** An Inbox link's site, shown after its title. */
    const linkSite = () => {
      if (!inboxRow() || !linkRow()) return undefined;
      try { return new URL(/\((https?:[^\s)]+)\)$/.exec(block()!.text.trim())?.[1] ?? block()!.text.trim()).hostname.replace(/^www\./, ''); } catch { return undefined; }
    };
    const target = createMemo(() => quoteTarget(block()?.text ?? ''));
    const field = createMemo(() => definitionsById().get(fieldEntryId(block()?.text ?? '') ?? ''));
    const parent = () => doc.outline.parentOf(id());
    const valueField = createMemo(() => definitionsById().get(fieldEntryId(doc.block(parent())?.text ?? '') ?? ''));
    const inline = () => inlineFields().has(parent());
    // Field entries are whole-row links to their definition, and values belong to their field; neither is an embed.
    const embed = createMemo(() => field() || inline() ? undefined : embedTarget(block()?.text ?? ''));
    const viewEmbed = createMemo(() => field() || inline() ? undefined : viewEmbedTarget(block()?.text ?? ''));
    // Values of one entry line up in one column; only the first carries the field's name.
    const labelled = () => { const index = indices().get(id()) ?? 0; return !index || doc.outline.parentOf(ids()[index - 1]!) !== parent(); };
    // A known entry with no live values reads as its label and an empty slot until it is edited.
    const emptyEntry = () => { doc.archivedVersion(); return !!field() && editing() !== id() && !doc.outline.children(id()).some(child => !doc.isArchived(child)); };
    const checked = () => inline() && valueField()?.kind === 'checkbox' && block()?.text.trim() && editing() !== id() ? checkboxValue(block()?.text ?? '') : null;
    const depth = () => (inline() ? doc.outline.depth(parent()) : doc.outline.depth(id())) - baseDepth();
    const pill = () => valueField()?.kind === 'choice' || valueField()?.kind === 'instance';
    const controlledValue = () => hasValueEditor(valueField(), block()?.text ?? '', contextDate());
    const valueProblem = createMemo(() => fieldValueProblem(valueField(), block()?.text ?? ''));
    const groupedValues = createMemo(() => {
      if (!inline()) return [];
      doc.archivedVersion();
      const values = doc.outline.children(parent()).filter(value => !doc.isArchived(value));
      return values.length > 1 && values[0] === id() && values.slice(1).every(value => !indices().has(value)) ? values : [];
    });
    const fieldEnd = () => {
      const next = ids()[(indices().get(id()) ?? -1) + 1];
      return !next || doc.outline.parentOf(next) !== parent();
    };
    const rowSources = createMemo(() => {
      // A row inside a reading leaves the source mark to the reading's holder line, and no row repeats a mark.
      const marks = new Set<string>();
      if (!block()?.position) for (let at = parent(); at && at !== doc.pageId; at = doc.outline.parentOf(at)) {
        if (!doc.block(at)?.position) continue;
        const held = positionSource(at);
        if (held && sigla().has(held)) marks.add(sigla().get(held)!);
        break;
      }
      return [...new Set([
        ...textTokens(block()?.text ?? '').filter(token => hasCitationDetail(token) && sigla().has(token.id!)).map(token => token.id!),
        ...(block()?.citations.map(citation => citation.source_id) ?? []),
        ...(block()?.position && positionSource(id()) ? [positionSource(id())!] : []),
      ])].filter(source => { const mark = sigla().get(source); if (!mark || marks.has(mark)) return false; marks.add(mark); return true; });
    });
    const localCitation = createMemo(() => doc.root()?.source ? block()?.citations.find(citation => citation.source_id === props.pageId) : undefined);
    const gist = () => inline() && fieldRole(valueField()) === 'standfirst';
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
    const derivedCards = createMemo(() => [...(orphanDescriptor() ? [] : cards().cards), ...occlusionCards(block()?.image, block()?.occlusion)]);
    const cardProblems = createMemo(() => orphanDescriptor() ? [{ message: 'A descriptor needs a parent with text.' }] : cards().problems);
    const cardCount = () => derivedCards().length + (block()?.templateCards ?? 0);
    const cardDecks = createMemo(() => {
      if (!cardCount()) return [];
      const decks: { id?: string; name: string }[] = [];
      const seen = new Set<string>();
      const value = block();
      const tags = [
        ...textTokens(value?.text ?? '').filter(token => token.kind === 'tag').map(token => ({ id: token.id, name: tagLabel(token, id => props.notebook.lookup(id)) })),
        ...(value?.manual_types ?? []).map(name => ({ id: props.notebook.roots().find(page => titleKey(page.text) === titleKey(name))?.id, name })),
      ];
      for (const tag of tags) {
        const key = tag.id ?? titleKey(tag.name.trim());
        if (!key || seen.has(key) || tag.id && props.notebook.lookup(tag.id)() === null) continue;
        seen.add(key);
        decks.push(tag);
      }
      return decks;
    });
    const cardMark = () => !block()?.task?.status && cardCount() > 0;
    let cardControl: { open(anchor: HTMLElement): void } | undefined;
    const [cardTextSettled, setCardTextSettled] = createSignal(false);
    createEffect(on([cardText, () => editing() === id()], ([, active]) => {
      setCardTextSettled(false);
      if (!active) return;
      const timer = window.setTimeout(() => setCardTextSettled(true), 1500);
      onCleanup(() => window.clearTimeout(timer));
    }));
    let row!: HTMLDivElement;
    let holdTimer = 0;
    let holding: { pointer: number; x: number; y: number } | undefined;
    let held = false;
    const cancelHold = () => { clearTimeout(holdTimer); holding = undefined; };
    const touchStart = (event: PointerEvent) => {
      cancelHold();
      held = false;
      if (event.pointerType !== 'touch' || !event.isPrimary || editing() === id()
        || (event.target as Element).closest('button, a, input, textarea, [role="button"], [contenteditable], [data-block-id]') !== row) return;
      holding = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
      holdTimer = window.setTimeout(() => {
        if (!holding || editing() === id()) return;
        held = true;
        cancelHold();
        blockMenu(id(), row);
      }, 500);
    };
    const touchMove = (event: PointerEvent) => {
      if (holding?.pointer === event.pointerId && Math.hypot(event.clientX - holding.x, event.clientY - holding.y) > 10) cancelHold();
    };
    onCleanup(cancelHold);
    onMount(() => { if (!propsRow.natural) virtualizer.measureElement(row); });
    onCleanup(() => { const host = hosts.get(id()); if (host && row.contains(host)) hosts.delete(id()); });
    function StaticText() {
      return <div class="static-text"><span classList={{ 'outline-value-pill': pill() && !!block()?.text, 'outline-reading-problem': !!valueProblem() }} title={valueProblem()}><BlockText text={displayText()} blockId={id()} onError={setMessage} cards field={field()} deletedHolder={block()?.position?.deleted_holder} citationApparatus={fieldRole(valueField()) === 'citation'} notebook={props.notebook} onOpen={props.onOpen} onReferenceMenu={referenceMenu} selection={selectedOffsets(id())} /></span><Show when={!block()?.text.trim() && inline()}><button type="button" class="field-empty-value" aria-label={`Add ${valueField()?.name} value`} onMouseDown={event => event.stopPropagation()} onClick={() => editAt(id(), 0, true)}><span class="field-slot-add">Add…</span></button></Show></div>;
    }
    return <div ref={row} id={`outline-${props.pane}-${id()}`} data-index={propsRow.natural ? undefined : propsRow.item!().index} data-block-id={id()} role="treeitem" aria-level={propsRow.natural ? 1 : depth() + 1}
      aria-expanded={children() ? !folds().has(id()) : undefined} aria-selected={selectedSet().has(id())}
      class="outline-row" classList={{ 'row-section-head': !!sectionHead(), 'row-banner': !!notesHead() || !!missingBefore(), 'row-captured': !!captureTime(), 'row-inbox': inboxRow(), 'row-link': !!linkSite(), 'row-reading-source': !!readingSource(), 'row-position': !!block()?.position, 'row-gist': gist(), 'row-question': !!block()?.question, 'row-assessment': !!block()?.assessment, 'row-selected': selectedSet().has(id()) && editing() !== id(), 'row-covered': coveredSet().has(id()), 'row-editing': editing() === id(), 'row-archived': block()?.archived ?? false, 'field-entry': !!field(), 'inline-field-value': inline() || emptyEntry(), 'row-gloss': inline() && parent() === glossId(), 'choice-value': pill(), 'source-highlight': !!localCitation(), 'source-highlights-start': sourceDetails().chapters.has(id()), 'outline-row-linked': block()?.citations.some(citation => citation.id === linkedCitation()) ?? false }}
      data-task-status={block()?.task?.status}
      data-holder={block()?.position?.holder_id ?? undefined}
      data-field-role={inline() ? fieldRole(valueField()) : field() ? fieldRole(field()) : undefined}
      data-value-kind={(inline() ? valueField() : field())?.kind}
      data-field-end={inline() ? String(fieldEnd()) : undefined}
      data-value-editor={inline() && editing() === id() ? '' : undefined}
      data-question-status={block()?.question?.status} data-accepted={block()?.assessment ? String(block()!.assessment!.accepted) : undefined} data-aporia={block()?.assessment?.state.aporia ? 'true' : undefined}
      onPointerDown={touchStart} onPointerMove={touchMove} onPointerUp={cancelHold} onPointerCancel={cancelHold}
      on:touchend={{ passive: false, handleEvent: event => { if (held) { event.preventDefault(); held = false; } } }}
      on:mousedown={{ capture: true, handleEvent: event => { if (held) { event.preventDefault(); event.stopPropagation(); } } }}
      on:click={{ capture: true, handleEvent: event => { if (held) { event.preventDefault(); event.stopPropagation(); held = false; } } }}
      onContextMenu={event => { if (editing() !== id() && (holding || held)) event.preventDefault(); }}
      onPointerEnter={() => { setLinkedCitation(block()?.citations[0]?.id ?? null); if (!propsRow.natural) sheet.hover(id()); }} onPointerLeave={() => { setLinkedCitation(null); sheet.hover(null); }}
      style={{ transform: propsRow.natural ? undefined : `translateY(${propsRow.item!().start - margin()}px)`, '--depth': propsRow.natural ? 0 : depth(), '--quote-color': localCitation()?.color ? `var(--highlight-${localCitation()!.color})` : 'var(--faint)' }}>
      <Show when={missingBefore() || notesHead()}><div class="row-section-banner">
        <Show when={missingBefore()}>{sections => <MissingSections notebook={props.notebook} sections={sections()} />}</Show>
        <Show when={notesHead()}>{name => <SectionHead class="row-notes-head" name={name()} />}</Show>
      </div></Show>
      <Show when={captureTime()}>{time => <span class="row-capture-time" aria-hidden="true">{time()}</span>}</Show>
      <RowPrelude id={id()} />
      <Show when={!propsRow.natural && depth() > 4}><span class="row-depth" aria-hidden="true" title={`Nesting depth ${depth()}`}>{depth()}</span></Show>
      <Show when={sourceDetails().chapters.get(id())}>{title => <div class="outline-chapter-label">{title()}</div>}</Show>
      <Show when={rowSources().length}><span class="row-sigla"><For each={rowSources()}>{source => <span class="row-siglum" title={props.notebook.lookup(source)()?.text}>{sigla().get(source)}</span>}</For></span></Show>
      <button type="button" class="row-menu icon-button" aria-label="Atom actions" onPointerDown={event => drag.start(event, id())} onClick={event => blockMenu(id(), event.currentTarget)}><Icon name="more" /></button>
      <button type="button" class="row-fold icon-button" classList={{ 'fold-empty': !children(), folded: folds().has(id()) }} aria-label={folds().has(id()) ? 'Unfold children' : 'Fold children'} disabled={!children()} onClick={() => fold(id())}><Icon name="down" /></button>
      <Show when={!inline() && !emptyEntry() && !block()?.task?.status}><button type="button" class="row-bullet icon-button" classList={{ 'bullet-collapsed': children() && folds().has(id()), 'row-card-mark': cardMark() }} aria-label={cardMark() ? `Cards: ${cardCount()}` : 'Zoom into atom'} aria-haspopup={cardMark() ? 'dialog' : undefined} onPointerDown={event => drag.start(event, id())} onMouseDown={event => { if (cardMark()) event.preventDefault(); }} onClick={event => cardMark() ? cardControl?.open(event.currentTarget) : zoomTo(id())}><Icon name={cardMark() ? 'card' : block()?.question ? 'question-open' : block()?.project ? 'flag' : block()?.source || readingSource() ? 'library' : linkRow() ? 'link' : 'bullet'} /></button></Show>
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
        <Show when={block()?.image}>{image => <figure class="outline-image">
          <button type="button" aria-label="Open image" onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); context.openImage(id()); }}>
            <NotebookImage image={image()} api={props.notebook.api} alt={block()?.text ?? ''} />
          </button>
        </figure>}</Show>
        <div class="outline-source-line">
        <Show when={block()?.relation}>{relation => <span class="relation-label">{relationLabels[relation().kind]}<Show when={relation().problem}>{problem => <span class="relation-problem" role="img" aria-label={problem()} title={problem()}><Icon name="warning" /></span>}</Show></span>}</Show>
        <div class="outline-source" data-placeholder={propsRow.placeholder}>
        <div class="editor-host" classList={{ 'host-active': editing() === id() }} ref={host => attach(id(), host)} />
        <Show when={editing() !== id() && (!block()?.image || !!block()?.text)}><Switch>
          <Match when={target()}><Quote id={id()} target={target()!} doc={doc} notebook={props.notebook} status={quoteStatus().get(id())} onOpen={props.onOpen} /></Match>
          <Match when={groupedValues().length}><div class="outline-field-values"><For each={groupedValues()}>{value => <FieldValue id={value} field={valueField()!} />}</For></div></Match>
          <Match when={emptyEntry()}><button type="button" class="field-empty-value" aria-label={`Add ${field()?.name} value`} onMouseDown={event => event.stopPropagation()} onClick={() => sheet.fill(id())}><span class="field-slot-add">Add…</span></button></Match>
          <Match when={checked() !== null}>
            <button type="button" role="checkbox" class="field-checkbox" aria-checked={!!checked()} aria-label={valueField()?.name} onMouseDown={event => event.stopPropagation()} onClick={() => sheet.toggle(id(), checked()!)}><Show when={checked()}><Icon name="check" /></Show></button>
          </Match>
          <Match when={controlledValue()}><div class="static-text"><FieldValue id={id()} field={valueField()!} /></div></Match>
          <Match when={viewEmbed()}><ViewEmbed reference={viewEmbed()!} notebook={props.notebook} onOpen={props.onOpen} onReplace={text => apply({ kind: 'text', id: id(), text }, false)} onRemove={() => apply({ kind: 'delete', ids: [id()] }, false)} /></Match>
          <Match when={embed()}><Show keyed when={embed()}>{target => <Embed target={target} notebook={props.notebook} onOpen={props.onOpen} fallback={<StaticText />} />}</Show></Match>
          <Match when><StaticText /></Match>
        </Switch></Show>
        <For each={(block()?.manual_types ?? []).filter(title => !isCapabilityTag(title))}>{title => <TypePill title={title} notebook={props.notebook} onOpen={props.onOpen} onRestoreFocus={restoreFocus} onRemove={() => { const result = doc.removeType(id(), title); if (!result.ok) setMessage(result.reason); }} />}</For>
        </div>
        <Show when={block()?.position?.problem}>{problem => <button type="button" class="relation-problem position-problem" aria-label={problem()} title={problem()} aria-haspopup="menu" onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); holderMenu(id(), event.currentTarget); }}><Icon name="warning" /></button>}</Show>
        <Show when={block()?.task || block()?.project || block()?.question || block()?.assessment || derivedCards().length || block()?.templateCards || block()?.citations.length}><span class="outline-capability-metadata" onMouseDown={event => { if ((event.target as Element).closest('button')) { event.preventDefault(); event.stopPropagation(); } }}>
          <TaskSummary id={id()} />
          <Show when={block()?.project}><Button class="outline-planning" label="Project" aria-haspopup="dialog" onClick={event => capabilities.open(id(), 'project', event.currentTarget)}>Project</Button></Show>
          <QuestionSummary id={id()} />
          <AnswerSummary id={id()} />
          <Show when={cardCount()}><CardSummary blockId={id()} cards={derivedCards()} decks={cardDecks()} templateCount={block()?.templateCards ?? 0} notebook={props.notebook} onOpen={props.onOpen} register={control => { cardControl = control; }} /></Show>
          <For each={block()?.citations}>{citation => <CitationChip citation={citation} pageId={props.pageId} notebook={props.notebook} onOpen={props.onOpen} />}</For>
        </span></Show>
        </div>
        <DiscoveryHints id={id()} />
        <QuestionParent info={block()?.question} notebook={props.notebook} onOpen={props.onOpen} disabled={capabilities.busy(id())} onChange={anchor => capabilities.open(id(), 'question-parent', anchor)}
          onRemove={() => { const question = block()?.question; if (question) { const { parent: _, ...value } = question.state; capabilities.invoke(capabilities.edit(id(), { kind: 'question', id: id(), value })); } }} />
        <Show when={block()?.question}><AssessmentJournal questionId={id()} doc={doc} notebook={props.notebook} onOpen={props.onOpen}
          onWrite={() => apply({ kind: 'writeAssessment', parentId: id(), assessedOn: props.notebook.todayDate() }, true)} /></Show>
        <RowRelations id={id()} />
        <Show when={block()?.keptCopy}><KeptCopyActions id={id()} apply={edit => apply(edit, false)} /></Show>
        <For each={block()?.citations}>{citation => <Show when={highlightProse(block()?.text ?? '') !== highlightProse(citation.quote)}>
          <p class="outline-citation-quote" title={citation.quote}>{citation.quote}</p>
        </Show>}</For>
        <Show when={editing() !== id() || cardTextSettled()}><For each={cardProblems()}>{problem => <p class="outline-card-problem" role="status">{problem.message}</p>}</For></Show>
        <Show when={capabilities.error(id())}><p class="outline-capability-error" role="alert">{capabilities.error(id())}</p></Show>
        <Show when={block()?.archived}><span class="archive-badge">Archived</span> <button class="text-button" type="button" onClick={() => apply({ kind: 'archive', id: id(), archived: false }, false)}>Unarchive</button></Show>
        <Show when={block()?.conflict}><button type="button" class="conflict-label" onClick={() => setConflicts(previous => { const next = new Set(previous); next.has(id()) ? next.delete(id()) : next.add(id()); return next; })}><Icon name="warning" />Conflict</button></Show>
        <Show when={block()?.conflict && conflicts().has(id())}><div class="conflict-panel">
          <strong>Your version</strong><pre>{block()?.text}</pre><strong>Workshop version</strong><pre>{block()?.conflict?.remoteText}</pre>
          <div class="conflict-actions"><button type="button" onClick={() => doc.resolveConflict(id(), 'mine')}>Use yours</button><button type="button" onClick={() => doc.resolveConflict(id(), 'theirs')}>Use workshop</button>
            <Show when={!editedConflicts().has(id())} fallback={<button type="button" onClick={() => doc.resolveConflict(id(), 'mine')}>Use edited text</button>}><button type="button" onClick={() => { setEditedConflicts(previous => new Set([...previous, id()])); editAt(id(), 0, true); }}>Edit merged text</button></Show></div>
        </div></Show>
      </div>
      <Show when={sectionHead()}>{head => <span class="row-section-tail"><span class="section-rule" /><span class="section-head-count">{head().count}</span>
        <Show when={head().section.id === 'inbox' && journal()?.toFile.length}><span class="section-head-action"><Button onClick={event => context.fileAll(journal()!.toFile, event.currentTarget)}>File all…</Button></span></Show>
        <Show when={head().section.id === 'reading' && head().today}><span class="section-head-action"><Button onClick={() => requestCreate({ kind: 'note', text: '', into: { kind: 'journal', section: head().section.id } })}>+ Note on…</Button></span></Show>
      </span>}</Show>
      <Show when={editing() !== id() ? readingSource() : undefined}>{source => <ReadingCreators notebook={props.notebook} sourceId={source()} text={block()?.text ?? ''} />}</Show>
      <Show when={linkSite() && editing() !== id()}><span class="row-link-site">{linkSite()}</span></Show>
      <Show when={inboxRow() && editing() !== id()}><span class="row-inbox-actions">
        <Show when={journal()?.toFile.includes(id())}>
          <Button class="bordered" onClick={() => {
            if (!block()?.task?.status) capabilities.invoke(capabilities.status(id(), 'todo'));
            context.openPlanning(id(), 'schedule');
          }}>Plan</Button>
          <Button class="bordered" aria-haspopup="listbox" onClick={event => context.openRelation(id(), 'integrate', event.currentTarget)}>File to…</Button>
        </Show>
        <Button class="bordered" icon="more" label="More" aria-haspopup="menu" onClick={event => blockMenu(id(), event.currentTarget)} />
      </span></Show>
      <AgentMark id={id()} />
      <ReferenceCount id={id()} />
      <sheet.FieldSlots id={id()} />
      <Show when={sectionHead()?.capture ? sectionHead()!.section : undefined}>{section => <SectionCapture notebook={props.notebook} section={section()} />}</Show>
    </div>;
  }
  return { Row, TaskSummary, QuestionSummary };
}
