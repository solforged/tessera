import { opensBeside } from '../shell/beside';
import { createEffect, onCleanup } from 'solid-js';
import { plainText } from './names';
import { entityKinds, entityLabel, fileAsEntity } from './holders';
import type { Edit } from '../document/contract';
import { depthStops } from '../shell/contract';
import type { Command } from '../shell/contract';
import { parseCardText } from '../review/card-text';
import { newTask } from '../tasks/quick-date';
import { priorities, priorityLabel, statusMenuItems } from '../tasks/TaskControls';
import { isFinished } from '../tasks/task-labels';
import type { MenuItem } from '../ui/Menu';
import { textTokens } from '../document/text-tokens';
import type { OutlineContext } from './context';
import { insertCard, makeCloze as wrapCloze } from './card-insert';
import type { InsertCardKind } from './card-insert';
import { createFieldMenu } from '../fields/FieldMenu';
import type { RelationKind } from '../api/types';
import { addRelationReason, relationKinds, relationLabels, relationReason } from './relations';
import { currentReading } from '../document/types';
import { questionDescriptions, questionVerbs } from './question-verbs';
import { deskTarget } from '../desk/query';

export function createOutlineCommands(context: Pick<OutlineContext,
  | 'doc' | 'editing' | 'commitFieldEntry' | 'props' | 'selected'
  | 'setMessage' | 'setMenu' | 'capabilities' | 'rename' | 'addGloss' | 'addAlias'
  | 'localPositions' | 'depthTitles' | 'depthReason' | 'setStop' | 'depth'
  | 'stepDepth' | 'heading' | 'adjacent' | 'horizontal' | 'ids'
  | 'rowFocus' | 'editAt' | 'caret' | 'editor' | 'split'
  | 'replaceSelection' | 'apply' | 'roots' | 'setRowRange' | 'fold'
  | 'zoomTo' | 'zoom' | 'zoomOut' | 'anchored' | 'setShowArchived'
  | 'scheduleReport' | 'undo' | 'setConflicts' | 'indices' | 'setFolds'
  | 'setZoom' | 'selectedSet' | 'sourceResets' | 'setCompletionIndex' | 'setCompletion'
  | 'rowAnchor' | 'rewriteEditing' | 'activeRange'
  | 'fields' | 'definitionsById' | 'pickField' | 'showNotice' | 'openRelation' | 'positionReason' | 'placeReason' | 'usePlace'
>) {
  const {
    doc, editing, commitFieldEntry, props, selected, setMessage,
    setMenu, capabilities, rename, addGloss, addAlias, localPositions, depthTitles,
    depthReason, setStop, depth, stepDepth, adjacent, horizontal,
    ids, rowFocus, editAt, caret, split, replaceSelection,
    apply, roots, setRowRange, fold, zoomTo, zoom,
    zoomOut, anchored, setShowArchived, scheduleReport, undo, setConflicts,
    indices, setFolds, setZoom, selectedSet, sourceResets, setCompletionIndex,
    setCompletion, rowAnchor, rewriteEditing, pickField,
  } = context;
  const { fieldEntry, fieldMenu } = createFieldMenu(context);
  function openTable(beside: boolean) {
    if (doc.root()?.kind !== 'page') return;
    if (editing()) commitFieldEntry(editing()!, false);
    props.onOpen({ kind: 'table', typeId: props.pageId, viewId: null, query: { type: props.pageId, text: null, filters: [], sort: [], limit: null } }, beside);
  }
  function openSelected(beside: boolean, id = selected()) {
    if (!id) return;
    const reference = textTokens(doc.block(id)?.text ?? '').find(token => token.kind === 'reference');
    const target = reference?.id ? props.notebook.lookup(reference.id)() : null;
    props.onOpen(target ? { kind: 'page', pageId: target.page_id, blockId: target.kind === 'block' ? target.id : undefined } : { kind: 'page', pageId: props.pageId, blockId: id }, beside);
  }
  function copy(text: string) { void navigator.clipboard.writeText(text).catch(error => setMessage(`Couldn't copy: ${String(error)}`)); }
  function referenceMenu(id: string, anchor: HTMLElement) {
    const block = props.notebook.lookup(id)();
    const open = (beside: boolean) => block && props.onOpen({ kind: 'page', pageId: block.page_id, blockId: block.kind === 'block' ? id : undefined }, beside);
    setMenu({ anchor, label: 'Reference actions', items: [
      { label: 'Open', icon: 'link', disabledReason: block ? undefined : 'The reference is unresolved.', action: event => open(opensBeside(event)) },
      { label: 'Open beside', icon: 'panes', disabledReason: block ? undefined : 'The reference is unresolved.', action: () => open(true) },
      { label: 'Copy reference', icon: 'copy', action: () => copy(`[[${id}]]`) },
    ] });
  }
  function markRelation(id: string, kind: RelationKind | null, text?: string) {
    const block = doc.block(id);
    if (!block) return;
    const empty = kind !== null && !(text ?? block.text).trim();
    const next = empty ? '[[]]' : text;
    const result = apply({ kind: 'relation', id, value: kind, text: next });
    if (!result?.ok) return;
    if (next !== undefined && context.editor?.id === id) context.editor.sync(next);
    if (empty) requestAnimationFrame(() => {
      editAt(id, 2, true);
      setCompletionIndex(0);
      setCompletion({ from: 0, to: 2, query: '' });
    });
    void doc.flush().catch(reason => capabilities.failure(id, reason));
  }
  function relationItems(id: string, add = false, text?: string, anchor = rowAnchor(id) ?? context.heading): MenuItem[] {
    return relationKinds.map(kind => ({
      label: relationLabels[kind],
      checked: !add && doc.block(id)?.relation?.kind === kind,
      action: () => {
        if (!add) { markRelation(id, kind, text); return; }
        if (!anchor) return;
        setCompletionIndex(0);
        setCompletion({ from: 0, to: 0, query: '', relationTarget: { parentId: id, kind, anchor, sourceText: text } });
      },
    }));
  }
  function relationMenu(id: string, add = false, text?: string) {
    const anchor = rowAnchor(id) ?? context.heading;
    if (!anchor) return;
    const title = add ? 'Add argument' : 'Argument kind';
    setMenu({ anchor, label: title, title, items: relationItems(id, add, text, anchor) });
  }
  function investigationItems(id: string, manager = false): MenuItem[] {
    const block = doc.block(id);
    if (!block) return [];
    const question = block.question?.state;
    const assessment = block.assessment;
    let ownerId = block.parentId;
    while (ownerId && !doc.block(ownerId)?.question) ownerId = doc.block(ownerId)?.parentId ?? null;
    const owner = ownerId ? doc.block(ownerId)?.question : null;
    const edit = (intent: Extract<Edit, { kind: 'question' | 'assessment' }>) => capabilities.invoke(capabilities.edit(intent.id, intent));
    const items: MenuItem[] = [
      ...(question ? [
        { label: 'Open in desk', action: () => props.onOpen(deskTarget(id), false) },
        { label: question.parked ? 'Resume' : 'Park', secondary: questionVerbs[question.parked ? 'Resume' : 'Park'], action: () => edit({ kind: 'question', id, value: { ...question, parked: !question.parked } }) },
        { label: question.unsettled ? 'Allow resolution' : 'Make recurrent', secondary: questionVerbs[question.unsettled ? 'Allow resolution' : 'Make recurrent'], action: () => edit({ kind: 'question', id, value: { ...question, unsettled: !question.unsettled } }) },
        { label: 'Write assessment', secondary: questionVerbs['Write assessment'], disabledReason: question.parked ? 'Resume the question before writing an assessment.' : undefined, action: () => apply({ kind: 'writeAssessment', parentId: id, assessedOn: props.notebook.todayDate() }, true) },
        { label: 'Add branch question', secondary: questionVerbs['Add branch question'], action: () => apply({ kind: 'addBranchQuestion', parentId: id }, true) },
        { label: 'Withdraw current answer', secondary: questionVerbs['Withdraw current answer'], disabledReason: !question.accepted ? 'There is no current answer.' : undefined, action: () => edit({ kind: 'question', id, value: currentReading(question, null, props.notebook.todayDate()) }) },
        { label: 'Set revisit date…', secondary: questionDescriptions['Set revisit date…'], action: () => capabilities.open(id, 'review-date') },
        { label: 'Set parent question…', secondary: questionDescriptions['Set parent question…'], action: () => capabilities.open(id, 'question-parent') },
        ...(question.parent ? [{ label: 'Remove parent', secondary: questionDescriptions['Remove parent'], action: () => { const { parent: _, ...value } = question; edit({ kind: 'question', id, value }); } }] : []),
        { label: 'Remove question', secondary: questionDescriptions['Remove question'], danger: true, action: () => edit({ kind: 'question', id, value: null }) },
      ] : [{ label: 'Make question', secondary: questionDescriptions['Make question'], disabledReason: block.relation ? 'Remove the relation first.' : assessment ? 'Remove the assessment first.' : block.kind === 'journal' ? 'Make an ordinary block or page a question.' : undefined,
        action: () => edit({ kind: 'question', id, value: { unsettled: false, parked: false, accepted: null, review_on: null } }) }]),
      ...(assessment ? [
        { label: 'Accept current answer', secondary: questionVerbs['Accept current answer'], disabledReason: !owner ? 'Put the assessment under a question first.' : owner.state.parked ? 'Resume the question before accepting an answer.' : assessment.accepted ? 'This is already the current answer.' : undefined,
          action: () => { if (ownerId && owner) edit({ kind: 'question', id: ownerId, value: currentReading(owner.state, id, props.notebook.todayDate()) }); } },
        { label: assessment.state.aporia ? 'Clear aporia' : 'Record aporia', action: () => edit({ kind: 'assessment', id, value: { ...assessment.state, aporia: !assessment.state.aporia } }) },
        { label: 'Remove assessment', secondary: questionDescriptions['Remove assessment'], danger: true, action: () => edit({ kind: 'assessment', id, value: null }) },
      ] : !question ? [{ label: 'Make assessment', secondary: questionDescriptions['Make assessment'], disabledReason: block.relation ? 'Remove the relation first.' : !owner ? 'Put the assessment under a question first.' : owner.state.parked ? 'Resume the question before writing an assessment.' : undefined,
        action: () => edit({ kind: 'assessment', id, value: { assessed_on: props.notebook.todayDate(), aporia: false } }) }] : []),
      ...(!addRelationReason(block) ? [{ label: 'Add argument…', submenu: () => ({ title: 'Add argument', items: relationItems(id, true) }) }] : []),
    ];
    if (!manager) return items;
    const concise = (label: string) => {
      const item = items.find(item => item.label === label)!;
      return { ...item, secondary: undefined };
    };
    if (assessment) return [
      concise('Accept current answer'),
      concise(assessment.state.aporia ? 'Clear aporia' : 'Record aporia'),
      ...items.filter(item => item.label === 'Add argument…'),
      { ...concise('Remove assessment'), divider: true },
    ];
    if (!question) return [];
    return [
      concise('Open in desk'), concise('Write assessment'), concise('Add branch question'),
      concise('Set revisit date…'),
      ...items.filter(item => item.label === 'Add argument…'),
      { label: 'Question settings…', submenu: () => ({ title: 'Question settings', items: [
        concise(question.parked ? 'Resume' : 'Park'),
        concise(question.unsettled ? 'Allow resolution' : 'Make recurrent'),
        concise('Withdraw current answer'), concise('Set parent question…'),
        ...(question.parent ? [concise('Remove parent')] : []),
      ] }) },
      { ...concise('Remove question'), divider: true },
    ];
  }
  function addPageType() {
    if (!context.heading) return;
    setCompletionIndex(0);
    setCompletion({ from: 0, to: 0, query: '', manual: { blockId: props.pageId, anchor: context.heading } });
  }
  function pageTypes(removeOnly = false) {
    if (!context.heading) return;
    const types = doc.root()?.manual_types ?? [];
    setMenu({ anchor: context.heading, label: removeOnly ? 'Remove page type' : 'Page types', title: removeOnly ? 'Remove page type' : 'Page types', context: doc.root()?.text, items: [
      ...(!removeOnly ? [{ label: 'Add type…', icon: 'plus' as const, action: addPageType }] : []),
      ...types.map((title, index): MenuItem => ({ label: `Remove ${title}`, icon: 'tag', divider: !removeOnly && index === 0, action: () => {
        const result = doc.removeType(props.pageId, title);
        if (!result.ok) setMessage(result.reason);
      } })),
    ] });
  }
  const commandsFor = (selected = context.selected): Command[] => [
    { id: 'copy-page-reference', title: 'Copy page reference', section: 'Page', disabledReason: () => doc.status() !== 'ready' ? 'Page is unavailable.' : undefined, run: () => copy(`[[${props.pageId}]]`) },
    { id: 'rename', title: 'Rename page', section: 'Page', disabledReason: () => doc.root()?.kind === 'page' ? undefined : 'Journal dates cannot be renamed.', run: rename },
    { id: 'open-table', title: 'Open as table', section: 'Page', keys: ['⌘⇧T'], disabledReason: () => doc.root()?.kind === 'page' ? undefined : 'Journal days cannot be opened as tables.', run: () => openTable(false) },
    { id: 'add-field-root', title: 'Add field…', section: selected() ? 'Block' : 'Page', disabledReason: () => doc.status() !== 'ready' ? 'Page is unavailable.' : undefined, run: () => { const owner = selected() ?? props.pageId; pickField(owner, rowAnchor(owner) ?? context.heading); } },
    { id: 'types-root', title: 'Page types…', section: 'Page', disabledReason: () => doc.status() !== 'ready' ? 'Page is unavailable.' : undefined, run: () => pageTypes() },
    { id: 'add-type-root', title: 'Add page type…', section: 'Page', disabledReason: () => doc.status() !== 'ready' ? 'Page is unavailable.' : undefined, run: addPageType },
    { id: 'remove-type-root', title: 'Remove page type…', section: 'Page', disabledReason: () => !doc.root()?.manual_types.length ? 'This page has no manual types.' : undefined, run: () => pageTypes(true) },
    { id: 'task-root', title: 'Task', section: 'Page', disabledReason: () => doc.status() !== 'ready' || capabilities.busy(props.pageId) ? 'Page is unavailable.' : undefined, run: () => {
      if (!doc.root()?.task) capabilities.invoke(capabilities.status(props.pageId, 'todo'));
      capabilities.open(props.pageId, 'task');
    } },
    { id: 'project-root', title: 'Project', section: 'Page', disabledReason: () => doc.status() !== 'ready' || capabilities.busy(props.pageId) ? 'Page is unavailable.' : undefined, run: () => {
      if (!doc.root()?.project) capabilities.invoke(capabilities.edit(props.pageId, { kind: 'project', id: props.pageId, value: { status: 'active', outcome: '', deadline: null } }));
      capabilities.open(props.pageId, 'project');
    } },
    // A stream page collects notes written under journal lines that link it; the Stream type marks it and lists it in the Index.
    { id: 'stream-root', title: 'Make or remove stream', section: 'Page', disabledReason: () => doc.status() !== 'ready' ? 'Page is unavailable.' : doc.root()?.kind !== 'page' ? 'Journal days cannot be streams.' : undefined, run: () => {
      const current = doc.root()?.manual_types.find(title => title.toLocaleLowerCase() === 'stream');
      const result = current ? doc.removeType(props.pageId, current) : doc.addType(props.pageId, 'Stream');
      if (!result.ok) setMessage(result.reason);
    } },
    { id: 'gloss', title: 'Add or edit gloss', section: 'Page', disabledReason: () => doc.status() !== 'ready' ? 'Page is unavailable.' : doc.root()?.kind !== 'page' ? 'Journal days have no gloss.' : undefined, run: addGloss },
    { id: 'alias', title: 'Add alias', section: 'Page', disabledReason: () => doc.status() !== 'ready' ? 'Page is unavailable.' : doc.root()?.kind !== 'page' ? 'Journal days have no aliases.' : undefined, run: addAlias },
    { id: 'read', title: 'Read', section: 'Page', disabledReason: () => props.projectionReason ? props.projectionReason('read') : doc.root()?.kind === 'page' ? undefined : 'Only titled pages have projections.', run: () => props.onProjection?.('read') },
    { id: 'outline', title: 'Outline', section: 'Page', disabledReason: () => doc.root()?.kind === 'page' ? undefined : 'Only titled pages have projections.', run: () => props.onProjection?.('outline') },
    { id: 'compare', title: 'Compare perspectives', section: 'Page', disabledReason: () => doc.status() !== 'ready' ? 'Page is unavailable.' : localPositions() < 2 ? 'Compare needs two perspectives on this page.' : undefined, run: () => props.onProjection?.('compare') },
    { id: 'add-reading', title: 'Add perspective', section: 'Page', disabledReason: () => doc.root()?.source ? 'Add perspectives on the concept or question they are about.' : doc.root()?.kind === 'page' ? undefined : 'Add perspectives on a titled page.', run: () => context.openRelation(props.pageId, 'reading', context.heading) },
    ...depthStops.map((stop): Command => ({ id: `depth-${stop}`, title: depthTitles[stop], section: 'Page', disabledReason: depthReason, run: () => setStop(stop) })),
    { id: 'depth-less', title: 'Show less of the page', section: 'Page', keys: ['['], disabledReason: () => depthReason() ?? (depth() === 'gloss' ? 'Only the gloss is showing.' : undefined), run: () => stepDepth(-1) },
    { id: 'depth-more', title: 'Show more of the page', section: 'Page', keys: [']'], disabledReason: () => depthReason() ?? (depth() === 'full' ? 'The whole page is showing.' : undefined), run: () => stepDepth(1) },
    { id: 'question-root', title: 'Question', section: 'Page', disabledReason: () => !doc.root()?.question ? 'Make the page a question first.' : capabilities.busy(props.pageId) ? 'Page is unavailable.' : undefined, run: () => {
      if (context.heading) setMenu({ anchor: context.heading, label: 'Question', title: 'Question', context: doc.root()?.text, items: investigationItems(props.pageId, true) });
    } },
    { id: 'add-relation-root', title: 'Add argument…', section: 'Page', disabledReason: () => addRelationReason(doc.root()), run: () => relationMenu(props.pageId, true) },
    { id: 'question-parent', title: 'Set parent question…', description: questionDescriptions['Set parent question…'], section: 'Page', disabledReason: () => doc.block(selected() ?? '')?.question || doc.root()?.question ? undefined : 'Select a question.', run: () => {
      const id = selected() && doc.block(selected()!)?.question ? selected()! : props.pageId;
      capabilities.open(id, 'question-parent', id === props.pageId ? context.heading : undefined);
    } },
    { id: 'previous-row', title: 'Select previous block', section: 'Navigation', keys: ['↑', 'k'], run: () => adjacent(-1) },
    { id: 'next-row', title: 'Select next block', section: 'Navigation', keys: ['↓', 'j'], run: () => adjacent(1) },
    { id: 'parent', title: 'Fold children / select parent', section: 'Navigation', keys: ['←', 'h'], run: () => horizontal('left') },
    { id: 'child', title: 'Unfold children / select first child', section: 'Navigation', keys: ['→', 'l'], run: () => horizontal('right') },
    { id: 'first-row', title: 'Select first block', section: 'Navigation', keys: ['gg'], run: () => ids()[0] && rowFocus(ids()[0]!) },
    { id: 'last-row', title: 'Select last block', section: 'Navigation', keys: ['G'], run: () => ids().at(-1) && rowFocus(ids().at(-1)!) },
    { id: 'extend-up', title: 'Extend block selection up', section: 'Outline', keys: ['⇧↑'], run: () => adjacent(-1, true) },
    { id: 'extend-down', title: 'Extend block selection down', section: 'Outline', keys: ['⇧↓'], run: () => adjacent(1, true) },
    { id: 'edit', title: 'Edit block', section: 'Editing', keys: ['Enter', 'i'], run: () => selected() && editAt(selected()!, caret()?.id === selected() ? caret()!.offset : 0, true) },
    { id: 'split', title: 'Split block', section: 'Editing', keys: ['Enter'], disabledReason: () => editing() ? undefined : 'Edit a block first.', run: () => editing() && context.editor && split(context.editor.view) },
    { id: 'newline', title: 'Insert newline', section: 'Editing', keys: ['⇧Enter'], disabledReason: () => editing() ? undefined : 'Edit a block first.', run: () => editing() && context.editor?.view.dispatch(context.editor.view.state.replaceSelection('\n')) },
    { id: 'insert-below', title: 'Insert block below', section: 'Editing', keys: ['o'], run: () => selected() && apply({ kind: 'insert', parentId: doc.outline.parentOf(selected()!), after: selected() }, true) },
    { id: 'insert-above', title: 'Insert block above', section: 'Editing', keys: ['O'], run: () => { const id = selected(); if (!id) return; const parentId = doc.outline.parentOf(id); const siblings = doc.outline.children(parentId); apply({ kind: 'insert', parentId, after: siblings[siblings.indexOf(id) - 1] ?? null }, true); } },
    { id: 'indent', title: 'Indent blocks', section: 'Outline', keys: ['Tab', '>>'], run: () => apply({ kind: 'indent', ids: roots() }) },
    { id: 'outdent', title: 'Outdent blocks', section: 'Outline', keys: ['⇧Tab', '<<'], run: () => apply({ kind: 'outdent', ids: roots() }) },
    { id: 'move-up', title: 'Move blocks up', section: 'Outline', keys: ['⌥↑'], run: () => apply({ kind: 'move', ids: roots(), direction: 'up' }) },
    { id: 'move-down', title: 'Move blocks down', section: 'Outline', keys: ['⌥↓'], run: () => apply({ kind: 'move', ids: roots(), direction: 'down' }) },
    { id: 'select', title: 'Select blocks', section: 'Outline', keys: ['V', '⇧↑/↓'], run: () => selected() && rowFocus(selected()!, true) },
    { id: 'select-all', title: 'Select all visible blocks', section: 'Outline', run: () => { const first = ids()[0]; const last = ids().at(-1); if (first && last) { rowFocus(last); setRowRange({ anchor: first, head: last }); } } },
    { id: 'fold', title: 'Fold / unfold children', section: 'View', keys: ['←/→', 'h/l'], run: () => fold(selected() ?? undefined) },
    { id: 'zoom', title: 'Zoom into block', section: 'Navigation', keys: ['⌘.', 'Space z'], run: () => selected() && zoomTo(selected()) },
    { id: 'zoom-out', title: 'Zoom out', section: 'Navigation', keys: ['⌘⇧.'], disabledReason: () => zoom() ? undefined : 'Already at the page root.', run: zoomOut },
    { id: 'open-beside', title: 'Open selected target beside', section: 'Navigation', keys: ['⌃⇧O'], run: () => openSelected(true, selected()) },
    { id: 'copy-reference', title: 'Copy block reference', section: 'Editing', run: () => selected() && copy(`[[${selected()}]]`) },
    { id: 'make-task', title: 'Make task', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.task ? 'Already a task.' : undefined, run: () => selected() && capabilities.invoke(capabilities.status(selected()!, 'todo')) },
    { id: 'remove-task', title: 'Remove task', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.task ? undefined : 'Select a task.', run: () => selected() && capabilities.invoke(capabilities.status(selected()!, null)) },
    { id: 'toggle-task', title: 'Complete or reopen task', section: 'Outline', keys: ['⌘Enter'], run: () => selected() && capabilities.invoke(capabilities.toggle(selected()!)) },
    { id: 'task-status', title: 'Set task status…', section: 'Outline', keys: ['⌘⇧Enter', 'Space t'], run: () => selected() && statusMenu(selected()!) },
    { id: 'plan-task', title: 'Plan task', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.task ? undefined : 'Select a task.', run: () => selected() && capabilities.open(selected()!, 'task') },
    { id: 'schedule-task', title: 'Schedule task', section: 'Outline', keys: ['Space s', '@'], run: () => selected() && openPlanning(selected()!, 'schedule') },
    { id: 'deadline-task', title: 'Set deadline', section: 'Outline', keys: ['Space d', '@due'], run: () => selected() && openPlanning(selected()!, 'deadline') },
    { id: 'priority-task', title: 'Set priority', section: 'Outline', keys: ['Space p'], run: () => selected() && priorityMenu(selected()!) },
    { id: 'repeat-task', title: 'Repeat task', section: 'Outline', keys: ['Space r'], run: () => selected() && openPlanning(selected()!, 'repeat') },
    { id: 'clock', title: 'Clock in / out', section: 'Outline', keys: ['Space w'], run: () => selected() && capabilities.invoke(capabilities.clock(selected()!)) },
    { id: 'work-sessions', title: 'Work sessions', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.task ? undefined : 'Select a task.', run: () => selected() && capabilities.open(selected()!, 'work') },
    { id: 'add-card', title: 'Add card', section: 'Editing', keys: ['Space c c', '>>'], run: () => selected() && addCard(selected()!) },
    { id: 'make-cloze', title: 'Make cloze', section: 'Editing', keys: ['⌘⇧C'], run: makeCloze },
    { id: 'leader', title: 'Show leader keys', section: 'Editing', keys: ['Space'], run: () => selected() && leaderMenu(selected()!) },
    { id: 'make-project', title: 'Make project', section: 'Outline', keys: ['Space o'], disabledReason: () => selected() && doc.block(selected()!)?.project ? 'Already a project.' : undefined, run: () => selected() && openProject(selected()!) },
    { id: 'make-perspective', title: 'Make perspective', section: 'Block', keys: ['Space v'], disabledReason: () => doc.block(selected() ?? '')?.kind !== 'block' ? 'Select an ordinary block.' : doc.block(selected()!)?.relation ? 'Remove the relation first.' : doc.block(selected()!)?.position ? 'Already a perspective.' : undefined, run: () => selected() && capabilities.invoke(capabilities.edit(selected()!, { kind: 'position', id: selected()!, value: true })) },
    { id: 'remove-perspective', title: 'Remove perspective', section: 'Block', keys: ['Space v'], disabledReason: () => doc.block(selected() ?? '')?.kind !== 'block' ? 'Select an ordinary block.' : !doc.block(selected()!)?.position ? 'Select a perspective.' : undefined, run: () => selected() && capabilities.invoke(capabilities.edit(selected()!, { kind: 'position', id: selected()!, value: false })) },
    { id: 'change-holder', title: 'Change holder…', section: 'Block', disabledReason: () => context.positionReason(selected() ?? ''), run: () => selected() && context.openRelation(selected()!, 'holder') },
    { id: 'file-under', title: 'File under…', section: 'Block', disabledReason: () => context.positionReason(selected() ?? '') ?? (!textTokens(doc.block(selected() ?? '')?.text ?? '').some(token => token.kind === 'reference') ? 'Choose a holder before filing this perspective.' : undefined), run: () => selected() && context.openRelation(selected()!, 'subject') },
    { id: 'use-place', title: 'Use place', section: 'Block', disabledReason: () => context.placeReason(selected() ?? ''), run: () => selected() && context.usePlace(selected()!) },
    ...(doc.root()?.kind === 'journal' ? [{ id: 'integrate', title: 'Integrate…', section: 'Block' as const, disabledReason: () => doc.block(selected() ?? '')?.kind !== 'block' ? 'Select a journal block.' : undefined, run: () => selected() && context.openRelation(selected()!, 'integrate') }] : []),
    ...relationKinds.map((kind): Command => ({
      id: `relation-${kind}`, title: `${relationLabels[kind]}…`, section: 'Block',
      disabledReason: () => relationReason(doc.block(selected() ?? '')),
      run: () => { const id = selected(); if (id) markRelation(id, kind); },
    })),
    { id: 'relation-kind', title: 'Change kind', section: 'Block', disabledReason: () => doc.block(selected() ?? '')?.relation ? undefined : 'Select a relation.', run: () => { const id = selected(); if (id) relationMenu(id); } },
    { id: 'remove-relation', title: 'Remove argument', section: 'Block', disabledReason: () => doc.block(selected() ?? '')?.relation ? undefined : 'Select a relation.', run: () => { const id = selected(); if (id) markRelation(id, null); } },
    { id: 'add-relation', title: 'Add argument…', section: 'Block', disabledReason: () => addRelationReason(doc.block(selected() ?? '')), run: () => { const id = selected(); if (id) relationMenu(id, true); } },
    ...['Make question', 'Make assessment', ...Object.keys(questionVerbs), 'Record aporia', 'Clear aporia', 'Set revisit date…', 'Remove parent', 'Remove question', 'Remove assessment'].map((title): Command => ({
      id: title.toLowerCase().replaceAll(' ', '-'), title, description: questionDescriptions[title], section: selected() ? 'Outline' : 'Page', keys: title === 'Make question' || title === 'Make assessment' ? ['Space q'] : undefined,
      disabledReason: () => {
        const item = investigationItems(selected() ?? props.pageId).find(item => item.label === title);
        return item ? item.disabledReason : 'Select a matching question or answer.';
      },
      run: () => {
        const item = investigationItems(selected() ?? props.pageId).find(item => item.label === title);
        if (item && !item.disabledReason) item.action?.();
      },
    })),
    { id: 'project', title: 'Project', section: 'Outline', keys: ['Space o'], disabledReason: () => selected() && doc.block(selected()!)?.project ? undefined : 'Select a project.', run: () => selected() && capabilities.open(selected()!, 'project') },
    { id: 'project-actions', title: 'Show actions', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.project ? undefined : 'Select a project.', run: () => selected() && capabilities.showActions(selected()!) },
    { id: 'review-cards', title: 'Review cards', section: 'View', run: () => props.onOpen({ kind: 'review' }, false) },
    { id: 'card-source', title: 'Show card source', section: 'Navigation', run: () => selected() && capabilities.source(selected()!) },
    { id: 'archive', title: 'Archive / unarchive block', section: 'Outline', run: () => selected() && apply({ kind: 'archive', id: selected()!, archived: !doc.block(selected()!)?.archived }, false) },
    { id: 'show-archived', title: 'Show / hide archived blocks', section: 'View', run: () => { anchored(() => setShowArchived(value => !value)); scheduleReport(); } },
    { id: 'delete', title: 'Delete selected subtrees', section: 'Outline', keys: ['Backspace', 'dd'], run: () => {
      const definition = roots().find(id => context.definitionsById().has(id));
      if (definition) { props.onOpen({ kind: 'field', fieldId: definition }, false); setMessage('Review the impact with Delete definition.'); return; }
      apply({ kind: 'delete', ids: roots() }, false);
    } },
    { id: 'undo', title: 'Undo', section: 'Editing', keys: ['⌘Z', 'u'], disabledReason: () => doc.canUndo() ? undefined : 'Nothing to undo.', run: () => undo() },
    { id: 'redo', title: 'Redo', section: 'Editing', keys: ['⌘⇧Z', '⌃R'], disabledReason: () => doc.canRedo() ? undefined : 'Nothing to redo.', run: () => undo(true) },
    { id: 'review-conflict', title: 'Review conflict', section: 'Editing', disabledReason: () => {
      doc.outline.version();
      for (let index = 0; index < doc.outline.size(); index++) if (doc.block(doc.outline.idAt(index))?.conflict) return undefined;
      return 'No conflicting blocks.';
    }, run: () => {
      for (let index = 0; index < doc.outline.size(); index++) {
        const id = doc.outline.idAt(index);
        if (!doc.block(id)?.conflict) continue;
        setConflicts(previous => new Set([...previous, id]));
        if (!indices().has(id)) { setFolds(new Set<string>()); setShowArchived(true); setZoom(null); }
        editAt(id, 0, false);
        break;
      }
    } },
    ...([null, 1, 2, 3] as const).map(level => ({ id: `heading-${level ?? 'normal'}`, title: level ? `Heading ${level}` : 'Normal text', section: 'Editing' as const, run: () => selected() && apply({ kind: 'heading', id: selected()!, level }) })),
  ];
  const commandDefinitions = commandsFor();
  let unregister = () => {};
  createEffect(() => {
    const commands = commandsFor().map(command => ({
      ...command,
      id: `outline.${props.pane}.${command.id}`,
      disabledReason: () => !props.active ? 'This pane is not active.' : command.disabledReason?.() ?? (command.section !== 'Page' && !['first-row', 'zoom-out', 'show-archived', 'undo', 'redo'].includes(command.id) && !selected() ? 'Select a block first.' : undefined),
      ...(['add-field-root', 'change-holder', 'file-under', 'use-place', 'integrate'].includes(command.id) ? { capture: (): Command => {
        const id = selected();
        const bound = commandsFor(() => id).find(candidate => candidate.id === command.id)!;
        const label = id ? plainText(doc.block(id)?.text ?? '', target => props.notebook.lookup(target)) : '';
        const reason = !props.active ? 'This pane is not active.' : bound.disabledReason?.();
        return { ...bound, id: `outline.${props.pane}.${command.id}`, title: `${bound.title}${label ? ` · ${label}` : ''}`, disabledReason: () => reason };
      } } : {}),
    }));
    unregister();
    unregister = props.commands.register(commands);
    onCleanup(unregister);
  });
  /** A perspective whose holder is not a person or group keeps working; these file the holder or change it. */
  function holderFixes(id: string): MenuItem[] {
    const holder = doc.block(id)?.position?.problem ? doc.block(id)?.position?.holder_id : undefined;
    if (!holder) return [];
    const name = plainText(props.notebook.lookup(holder)()?.text ?? '', target => props.notebook.lookup(target)) || 'the holder';
    return entityKinds.map(kind => ({ label: `File ${name} as ${entityLabel(kind)}`, action: () => {
      void fileAsEntity(props.notebook, holder, kind, [props.pageId]).catch(reason => setMessage(reason instanceof Error ? reason.message : String(reason)));
    } }));
  }
  function holderMenu(id: string, anchor: HTMLElement) {
    const problem = doc.block(id)?.position?.problem;
    if (!problem) return;
    if (!selectedSet().has(id)) rowFocus(id);
    setMenu({ anchor, label: 'Holder', title: 'Holder', context: problem, items: [...holderFixes(id), { label: 'Change holder…', action: () => context.openRelation(id, 'holder', anchor) }] });
  }
  /** Keep routine work in one short menu; transformations and capabilities stay one step away. */
  function blockMenu(id: string, anchor: HTMLElement) {
    if (!selectedSet().has(id)) rowFocus(id);
    const rowCommands = commandsFor(() => id);
    const item = (commandId: string, label?: string): MenuItem => {
      const command = rowCommands.find(candidate => candidate.id === commandId)!;
      return { label: label ?? command.title, shortcut: command.keys?.[0], disabledReason: command.disabledReason?.(), action: () => command.run() };
    };
    const group = (label: string, title: string, items: () => MenuItem[]): MenuItem => ({ label, submenu: () => ({ title, items: items() }) });
    const entry = doc.block(id);
    if (!entry) return;
    const investigation = investigationItems(id);
    const makeInvestigation = (kind: 'question' | 'assessment'): MenuItem | undefined => {
      const choice = investigation.find(item => item.label === `Make ${kind}`);
      return choice && { ...choice, label: kind === 'question' ? 'Question' : 'Assessment', secondary: undefined };
    };
    const hasCards = parseCardText(entry.text).cards.length > 0;
    const sourceItems = [
      ...sourceResets(id),
      ...(entry.citations.length ? [{ label: 'Remove citation', divider: true, danger: true, action: () => apply({ kind: 'uncite', id, citationIds: entry.citations.map(citation => citation.id) }, false) }] : []),
    ];
    const managers: MenuItem[] = [
      ...(fieldEntry(id) ? [{ label: 'Field…', action: () => fieldMenu(id, anchor) }] : []),
      ...(entry.task ? [group('Task…', 'Task', () => [
        item('toggle-task', isFinished(entry.task!) ? 'Reopen' : 'Complete'),
        group('Status…', 'Task status', () => statusMenuItems(entry.task, status => capabilities.invoke(capabilities.status(id, status)))),
        { label: 'Plan', action: () => capabilities.open(id, 'task', anchor) },
        { label: 'Work sessions', action: () => capabilities.open(id, 'work', anchor) },
        { ...item('remove-task'), divider: true, danger: true },
      ])] : []),
      ...(entry.project ? [group('Project…', 'Project', () => [
        { label: 'Project', action: () => capabilities.open(id, 'project', anchor) },
        { label: 'Show actions', action: () => capabilities.showActions(id) },
      ])] : []),
      ...(entry.position ? [group('Perspective…', 'Perspective', () => [
        ...holderFixes(id), item('change-holder'), item('file-under'), item('use-place'),
        ...(!addRelationReason(entry) ? [group('Add argument…', 'Add argument', () => relationItems(id, true, undefined, anchor))] : []),
        { ...item('remove-perspective'), divider: true, danger: true },
      ])] : []),
      ...(entry.question ? [group('Question…', 'Question', () => investigationItems(id, true))] : []),
      ...(entry.assessment ? [group('Assessment…', 'Assessment', () => investigationItems(id, true))] : []),
      ...(entry.relation ? [group('Argument…', 'Argument', () => [
        group('Change kind…', 'Argument kind', () => relationItems(id)),
        { ...item('remove-relation'), divider: true, danger: true },
      ])] : []),
      ...(hasCards ? [group('Cards…', 'Cards', () => [
        { label: 'Review cards', action: () => props.onOpen({ kind: 'review', blockId: id }, false) },
        { label: 'Show card source', action: () => capabilities.source(id) },
      ])] : []),
      ...(sourceItems.length ? [group('Citation…', 'Citation', () => sourceItems)] : []),
    ];
    const makeItems: MenuItem[] = [
      { label: 'Type…', action: () => { setCompletionIndex(0); setCompletion({ from: 0, to: 0, query: '', manual: { blockId: id, anchor } }); } },
      ...(!entry.task ? [item('make-task', 'Task')] : []),
      ...(!entry.project ? [item('make-project', 'Project')] : []),
      ...(!entry.position ? [item('make-perspective', 'Perspective')] : []),
      ...(!entry.question && !entry.assessment ? [makeInvestigation('question'), makeInvestigation('assessment')].filter((item): item is MenuItem => !!item) : []),
      // Perspectives, questions and assessments add relations from their own manager.
      ...(!entry.relation && !entry.position && !entry.question && !entry.assessment ? [{
        ...group('Argument…', 'Argument', () => relationKinds.map(kind => item(`relation-${kind}`, relationLabels[kind]))),
        disabledReason: relationReason(entry),
      }] : []),
      ...(!hasCards ? [group('Card…', 'Cards', () => cardItems(id))] : []),
    ];
    setMenu({ anchor, label: 'Block actions', title: 'Block actions', context: plainText(entry.text, target => props.notebook.lookup(target)), items: [
      item('edit', 'Edit'), item('insert-below', 'Insert below'),
      group('Move…', 'Move', () => [
        item('indent', 'Indent'), item('outdent', 'Outdent'),
        item('move-up', 'Move up'), item('move-down', 'Move down'),
        ...(doc.root()?.kind === 'journal' ? [item('integrate')] : []),
      ]),
      { ...item('copy-reference', 'Copy reference'), divider: true },
      item('open-beside', 'Open beside'),
      ...managers.map((item, index) => ({ ...item, divider: index === 0 })),
      { label: 'Add field…', divider: !managers.length, action: () => pickField(id, anchor) },
      { label: 'Make…', submenu: () => ({ title: 'Make', items: makeItems, note: 'Each adds to this note and keeps its text.' }) },
      { ...item('archive', entry.archived ? 'Unarchive' : 'Archive'), divider: true },
      { ...item('delete', 'Delete…'), danger: true },
    ] });
  }
  /** Keyboard menus hand focus back to the row or editor that opened them before their action runs. */
  function keyboardMenu(id: string, label: string, items: MenuItem[]) {
    const anchor = rowAnchor(id);
    if (!anchor) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const refocus = () => { if (prior?.isConnected) prior.focus({ preventScroll: true }); };
    setMenu({ anchor, label, ...(label === 'Question' ? { title: label, context: plainText(doc.block(id)?.text ?? '', target => props.notebook.lookup(target)) } : {}), items: items.map(item => ({ ...item, action: () => { refocus(); item.action?.(); } })) });
  }
  function statusMenu(id: string) {
    const task = doc.block(id)?.task;
    keyboardMenu(id, 'Task status', statusMenuItems(task, status => capabilities.invoke(capabilities.status(id, status))));
  }
  function priorityMenu(id: string) {
    const current = doc.block(id)?.task?.priority ?? null;
    keyboardMenu(id, 'Priority', priorities.map((priority): MenuItem => ({ label: priorityLabel(priority), checked: current === priority, action: () => {
      const task = doc.block(id)?.task ?? newTask();
      capabilities.invoke(capabilities.edit(id, { kind: 'task', id, value: { ...task, priority } }));
    } })));
  }
  function openPlanning(id: string, kind: 'schedule' | 'deadline' | 'repeat') {
    capabilities.ensureTask(id);
    capabilities.open(id, kind);
  }
  /**
   * A project made on a journal day gets its own page, named by the row, so it is filed under Projects and
   * collects tasks from later days; the row becomes its link. Elsewhere the block itself becomes the project.
   */
  function openProject(id: string) {
    const block = doc.block(id);
    if (!block) return;
    if (!block.project && block.kind === 'block' && doc.root()?.kind === 'journal') { void promoteToProject(id); return; }
    if (!block.project) capabilities.invoke(capabilities.edit(id, { kind: 'project', id, value: { status: 'active', outcome: '', deadline: null } }));
    capabilities.open(id, 'project');
  }
  async function promoteToProject(id: string) {
    const title = plainText(doc.block(id)?.text ?? '', target => props.notebook.lookup(target)).trim();
    if (!title) { setMessage('Write the project’s name in the block, then make it a project.'); return; }
    rowFocus(id);
    await capabilities.run(id, async () => {
      const { change } = await props.notebook.promoteToProject(id, title);
      context.showNotice(`Made project page ${title}.`, change.undo);
    }).catch(() => {});
  }
  function addCard(id: string, kind: InsertCardKind = 'forward') {
    const next = insertCard(doc.block(id)?.text ?? '', kind, caret()?.id === id ? caret()!.offset : undefined);
    if (context.editor?.id === id && editing() === id) { if (rewriteEditing(id, next)) editAt(id, next.caret, true); return; }
    const result = doc.edit({ kind: 'text', id, text: next.text }, caret());
    if (!result.ok) { setMessage(result.reason); return; }
    editAt(id, next.caret, true);
  }
  function makeCloze() {
    const id = editing() ?? selected();
    if (!id) return;
    const range = context.activeRange();
    if (range && range.anchor.id !== range.head.id) { setMessage('Select text in one block.'); return; }
    const text = doc.block(id)?.text ?? '';
    const from = range ? Math.min(range.anchor.offset, range.head.offset) : caret()?.id === id ? caret()!.offset : text.length;
    const to = range ? Math.max(range.anchor.offset, range.head.offset) : from;
    const next = wrapCloze(text, from, to);
    if ('reason' in next) { setMessage(next.reason); return; }
    // Range replacement is a discrete document history entry, separate from adjacent typing.
    replaceSelection(next.text, 'text', { anchor: { id, offset: 0 }, head: { id, offset: text.length } }, range ?? undefined);
    editAt(id, next.caret, true);
  }
  function cardItems(id: string): MenuItem[] {
    const kinds: [string, string, InsertCardKind][] = [
      ['c', 'Card', 'forward'], ['r', 'Reverse', 'reverse'], ['b', 'Reversible', 'both'],
      ['m', 'Multi-line', 'multiline'], ['l', 'List', 'list'], ['d', 'Descriptor', 'descriptor'], ['z', 'Cloze', 'cloze'],
    ];
    return kinds.map(([key, label, kind]) => ({ key, shortcut: key, label, action: () => addCard(id, kind) }));
  }
  function cardMenu(id: string) {
    keyboardMenu(id, 'Cards', cardItems(id));
  }
  /** Space on a selected row (or in Vim normal mode): one more letter acts on the block. */
  function leaderMenu(id: string) {
    const rowCommands = commandsFor(() => id);
    const leader = (key: string, label: string, run: () => void, section?: string): MenuItem => ({ key, shortcut: key, label, section, action: run });
    const commandItem = (key: string, commandId: string, section?: string): MenuItem => {
      const command = rowCommands.find(command => command.id === commandId)!;
      return { key, shortcut: key, label: command.title, section, disabledReason: command.disabledReason?.(), action: () => command.run() };
    };
    const block = doc.block(id);
    let ancestor = block?.parentId ?? null;
    while (ancestor && !doc.block(ancestor)?.question) ancestor = doc.block(ancestor)?.parentId ?? null;
    keyboardMenu(id, 'Leader keys', [
      ...(fieldEntry(id) ? [leader('f', 'Field…', () => { const anchor = rowAnchor(id); if (anchor) fieldMenu(id, anchor); }, 'Field')] : []),
      leader('t', 'Status…', () => statusMenu(id), 'Task'),
      leader('s', 'Schedule…', () => openPlanning(id, 'schedule')),
      leader('d', 'Deadline…', () => openPlanning(id, 'deadline')),
      leader('p', 'Priority…', () => priorityMenu(id)),
      leader('r', 'Repeat…', () => openPlanning(id, 'repeat')),
      leader('w', doc.block(id)?.task ? 'Clock in / out' : 'Clock in', () => capabilities.invoke(capabilities.clock(id))),
      commandItem('o', block?.project ? 'project' : 'make-project', 'Project'),
      ...(block?.question
        ? [leader('q', 'Question…', () => keyboardMenu(id, 'Question', investigationItems(id, true)), 'Question')]
        : [commandItem('q', ancestor ? 'make-assessment' : 'make-question', 'Question')]),
      commandItem('v', block?.position ? 'remove-perspective' : 'make-perspective', 'Block'),
      leader('c', 'Add card', () => cardMenu(id)),
      leader('z', 'Zoom in', () => zoomTo(id)),
    ]);
  }
  return { openTable, investigationItems, markRelation, relationMenu, commandDefinitions, unregister, blockMenu, holderMenu, fieldMenu, statusMenu, priorityMenu, openPlanning, openProject, leaderMenu, makeCloze, referenceMenu, copy };
}
