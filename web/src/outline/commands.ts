import type { Edit } from '../document/contract';
import { depthStops } from '../shell/contract';
import type { Command } from '../shell/contract';
import { parseCardText } from '../review/card-text';
import { newTask } from '../tasks/quick-date';
import { priorities, priorityLabel, statusMenuItems } from '../tasks/TaskControls';
import { isFinished } from '../tasks/task-labels';
import type { IconName } from '../ui/Icon';
import type { MenuItem } from '../ui/Menu';
import { textTokens } from '../document/text-tokens';
import type { OutlineContext } from './context';

export function createOutlineCommands(context: Pick<OutlineContext,
  | 'doc' | 'editing' | 'commitFieldEntry' | 'props' | 'selected'
  | 'setMessage' | 'setMenu' | 'capabilities' | 'rename' | 'addGloss'
  | 'localPositions' | 'depthTitles' | 'depthReason' | 'setStop' | 'depth'
  | 'stepDepth' | 'heading' | 'adjacent' | 'horizontal' | 'ids'
  | 'rowFocus' | 'editAt' | 'caret' | 'editor' | 'split'
  | 'replaceSelection' | 'apply' | 'roots' | 'setRowRange' | 'fold'
  | 'zoomTo' | 'zoom' | 'zoomOut' | 'anchored' | 'setShowArchived'
  | 'scheduleReport' | 'undo' | 'setConflicts' | 'indices' | 'setFolds'
  | 'setZoom' | 'selectedSet' | 'sourceResets' | 'setCompletionIndex' | 'setCompletion'
  | 'rowAnchor' | 'rewriteEditing'
>) {
  const {
    doc, editing, commitFieldEntry, props, selected, setMessage,
    setMenu, capabilities, rename, addGloss, localPositions, depthTitles,
    depthReason, setStop, depth, stepDepth, adjacent, horizontal,
    ids, rowFocus, editAt, caret, split, replaceSelection,
    apply, roots, setRowRange, fold, zoomTo, zoom,
    zoomOut, anchored, setShowArchived, scheduleReport, undo, setConflicts,
    indices, setFolds, setZoom, selectedSet, sourceResets, setCompletionIndex,
    setCompletion, rowAnchor, rewriteEditing,
  } = context;
  function openTable(beside: boolean) {
    if (doc.root()?.kind !== 'page') return;
    if (editing()) commitFieldEntry(editing()!, false);
    props.onOpen({ kind: 'table', typeId: props.pageId, viewId: null, query: { type: props.pageId, text: null, filters: [], sort: [], limit: null } }, beside);
  }
  function openSelected(beside: boolean) {
    const id = selected();
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
      { label: 'Open here', icon: 'link', disabledReason: block ? undefined : 'The reference is unresolved.', action: () => open(false) },
      { label: 'Open beside', icon: 'panes', disabledReason: block ? undefined : 'The reference is unresolved.', action: () => open(true) },
      { label: 'Copy reference', icon: 'copy', action: () => copy(`[[${id}]]`) },
    ] });
  }
  function investigationItems(id: string): MenuItem[] {
    const block = doc.block(id);
    if (!block) return [];
    const question = block.question?.state;
    const assessment = block.assessment;
    let ownerId = block.parentId;
    while (ownerId && !doc.block(ownerId)?.question) ownerId = doc.block(ownerId)?.parentId ?? null;
    const owner = ownerId ? doc.block(ownerId)?.question : null;
    const edit = (intent: Extract<Edit, { kind: 'question' | 'assessment' }>) => capabilities.invoke(capabilities.edit(intent.id, intent));
    return [
      ...(question ? [
        { label: question.parked ? 'Resume question' : 'Park question', action: () => edit({ kind: 'question', id, value: { ...question, parked: !question.parked } }) },
        { label: question.unsettled ? 'Let it settle' : 'Keep open', action: () => edit({ kind: 'question', id, value: { ...question, unsettled: !question.unsettled } }) },
        { label: 'Set review date', action: () => capabilities.open(id, 'review-date') },
        { label: 'Remove question', disabledReason: question.parked && question.accepted ? 'Resume the question before accepting an answer.' : undefined, action: () => edit({ kind: 'question', id, value: null }) },
      ] : [{ label: 'Make question', disabledReason: assessment ? 'Remove the answer first.' : block.kind === 'journal' ? 'Make an ordinary block or page a question.' : undefined,
        action: () => edit({ kind: 'question', id, value: { unsettled: false, parked: false, accepted: null, review_on: null } }) }]),
      ...(assessment ? [
        { label: 'Accept answer', disabledReason: !owner ? 'Put the answer under a question first.' : owner.state.parked ? 'Resume the question before accepting an answer.' : assessment.accepted ? 'Already accepted.' : undefined,
          action: () => { if (ownerId && owner) edit({ kind: 'question', id: ownerId, value: { ...owner.state, accepted: id } }); } },
        { label: assessment.state.aporia ? 'Clear aporia' : 'Record aporia', action: () => edit({ kind: 'assessment', id, value: { ...assessment.state, aporia: !assessment.state.aporia } }) },
        { label: 'Remove answer', action: () => edit({ kind: 'assessment', id, value: null }) },
      ] : [{ label: 'Make answer', disabledReason: question ? 'Remove the question first.' : !owner ? 'Put the answer under a question first.' : owner.state.parked ? 'Resume the question before answering it.' : undefined,
        action: () => edit({ kind: 'assessment', id, value: { assessed_on: props.notebook.todayDate(), aporia: false } }) }]),
    ];
  }
  const commandDefinitions: Command[] = [
    { id: 'rename', title: 'Rename page', section: 'Page', disabledReason: () => doc.root()?.kind === 'page' ? undefined : 'Journal dates cannot be renamed.', run: rename },
    { id: 'open-table', title: 'Open as table', section: 'Page', keys: ['⌘⇧T'], disabledReason: () => doc.root()?.kind === 'page' ? undefined : 'Journal days cannot be opened as tables.', run: () => openTable(false) },
    { id: 'task-root', title: 'Task', section: 'Page', disabledReason: () => doc.status() !== 'ready' || capabilities.busy(props.pageId) ? 'Page is unavailable.' : undefined, run: () => {
      if (!doc.root()?.task) capabilities.invoke(capabilities.status(props.pageId, 'todo'));
      capabilities.open(props.pageId, 'task');
    } },
    { id: 'project-root', title: 'Project', section: 'Page', disabledReason: () => doc.status() !== 'ready' || capabilities.busy(props.pageId) ? 'Page is unavailable.' : undefined, run: () => {
      if (!doc.root()?.project) capabilities.invoke(capabilities.edit(props.pageId, { kind: 'project', id: props.pageId, value: { status: 'active', outcome: '', deadline: null } }));
      capabilities.open(props.pageId, 'project');
    } },
    { id: 'gloss', title: 'Add or edit gloss', section: 'Page', disabledReason: () => doc.status() !== 'ready' ? 'Page is unavailable.' : doc.root()?.kind !== 'page' ? 'Journal days have no gloss.' : undefined, run: addGloss },
    { id: 'compare', title: 'Compare perspectives', section: 'Page', disabledReason: () => doc.status() !== 'ready' ? 'Page is unavailable.' : localPositions() < 2 ? 'Compare needs two perspectives on this page.' : undefined, run: () => props.onOpen({ kind: 'compare', subjectId: props.pageId }, false) },
    ...depthStops.map((stop): Command => ({ id: `depth-${stop}`, title: depthTitles[stop], section: 'Page', disabledReason: depthReason, run: () => setStop(stop) })),
    { id: 'depth-less', title: 'Show less of the page', section: 'Page', keys: ['['], disabledReason: () => depthReason() ?? (depth() === 'gloss' ? 'Only the gloss is showing.' : undefined), run: () => stepDepth(-1) },
    { id: 'depth-more', title: 'Show more of the page', section: 'Page', keys: [']'], disabledReason: () => depthReason() ?? (depth() === 'full' ? 'The whole page is showing.' : undefined), run: () => stepDepth(1) },
    { id: 'question-root', title: 'Make question', section: 'Page', disabledReason: () => doc.root()?.kind !== 'page' || capabilities.busy(props.pageId) ? 'Page is unavailable.' : undefined, run: () => {
      const item = investigationItems(props.pageId).find(item => item.label === 'Make question');
      if (item && !item.disabledReason) item.action();
      else if (context.heading) setMenu({ anchor: context.heading, label: 'Question', items: investigationItems(props.pageId) });
    } },
    { id: 'previous-row', title: 'Select previous block', section: 'Navigation', keys: ['↑', 'k'], run: () => adjacent(-1) },
    { id: 'next-row', title: 'Select next block', section: 'Navigation', keys: ['↓', 'j'], run: () => adjacent(1) },
    { id: 'parent', title: 'Fold children / select parent', section: 'Navigation', keys: ['←', 'h'], run: () => horizontal('left') },
    { id: 'child', title: 'Unfold children / select first child', section: 'Navigation', keys: ['→', 'l'], run: () => horizontal('right') },
    { id: 'first-row', title: 'Select first block', section: 'Navigation', keys: ['gg'], run: () => ids()[0] && rowFocus(ids()[0]!) },
    { id: 'last-row', title: 'Select last block', section: 'Navigation', keys: ['G'], run: () => ids().at(-1) && rowFocus(ids().at(-1)!) },
    { id: 'extend-up', title: 'Extend block selection up', section: 'Outline', keys: ['⇧↑'], run: () => adjacent(-1, true) },
    { id: 'extend-down', title: 'Extend block selection down', section: 'Outline', keys: ['⇧↓'], run: () => adjacent(1, true) },
    { id: 'edit', title: 'Edit block', section: 'Editing', keys: ['Enter', 'i'], run: () => selected() && editAt(selected()!, caret()?.offset ?? 0, true) },
    { id: 'split', title: 'Split block', section: 'Editing', keys: ['Enter'], run: () => editing() && context.editor && split(context.editor.view) },
    { id: 'newline', title: 'Insert newline', section: 'Editing', keys: ['⇧Enter'], run: () => context.editor?.view.dispatch(context.editor.view.state.replaceSelection('\n')) },
    { id: 'insert-below', title: 'Insert block below', section: 'Editing', keys: ['o'], run: () => selected() && apply({ kind: 'insert', parentId: doc.outline.parentOf(selected()!), after: selected() }, true) },
    { id: 'insert-above', title: 'Insert block above', section: 'Editing', keys: ['O'], run: () => { const id = selected(); if (!id) return; const parentId = doc.outline.parentOf(id); const siblings = doc.outline.children(parentId); apply({ kind: 'insert', parentId, after: siblings[siblings.indexOf(id) - 1] ?? null }, true); } },
    { id: 'indent', title: 'Indent blocks', section: 'Outline', keys: ['Tab', '>>'], run: () => apply({ kind: 'indent', ids: roots() }) },
    { id: 'outdent', title: 'Outdent blocks', section: 'Outline', keys: ['⇧Tab', '<<'], run: () => apply({ kind: 'outdent', ids: roots() }) },
    { id: 'move-up', title: 'Move blocks up', section: 'Outline', keys: ['⌥↑'], run: () => apply({ kind: 'move', ids: roots(), direction: 'up' }) },
    { id: 'move-down', title: 'Move blocks down', section: 'Outline', keys: ['⌥↓'], run: () => apply({ kind: 'move', ids: roots(), direction: 'down' }) },
    { id: 'select', title: 'Select blocks', section: 'Outline', keys: ['V', '⇧↑/↓'], run: () => selected() && rowFocus(selected()!, true) },
    { id: 'select-all', title: 'Select all visible blocks', section: 'Outline', run: () => { const first = ids()[0]; const last = ids().at(-1); if (first && last) { rowFocus(last); setRowRange({ anchor: first, head: last }); } } },
    { id: 'fold', title: 'Fold / unfold children', section: 'View', keys: ['←/→', 'h/l'], run: () => fold() },
    { id: 'zoom', title: 'Zoom into block', section: 'Navigation', keys: ['⌘.', 'Space z'], run: () => selected() && zoomTo(selected()) },
    { id: 'zoom-out', title: 'Zoom out', section: 'Navigation', keys: ['⌘⇧.'], disabledReason: () => zoom() ? undefined : 'Already at the page root.', run: zoomOut },
    { id: 'open-beside', title: 'Open selected target beside', section: 'Navigation', keys: ['⌃⇧O'], run: () => openSelected(true) },
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
    { id: 'add-card', title: 'Add card', section: 'Editing', keys: ['Space c', '>>'], run: () => selected() && addCard(selected()!) },
    { id: 'leader', title: 'Show leader keys', section: 'Editing', keys: ['Space'], run: () => selected() && leaderMenu(selected()!) },
    { id: 'make-project', title: 'Make project', section: 'Outline', keys: ['Space o'], disabledReason: () => selected() && doc.block(selected()!)?.project ? 'Already a project.' : undefined, run: () => selected() && capabilities.invoke(capabilities.edit(selected()!, { kind: 'project', id: selected()!, value: { status: 'active', outcome: '', deadline: null } })) },
    { id: 'make-perspective', title: 'Make perspective', section: 'Block', keys: ['Space v'], disabledReason: () => doc.block(selected() ?? '')?.kind !== 'block' ? 'Select an ordinary block.' : doc.block(selected()!)?.position ? 'Already a perspective.' : undefined, run: () => selected() && capabilities.invoke(capabilities.edit(selected()!, { kind: 'position', id: selected()!, value: true })) },
    { id: 'remove-perspective', title: 'Remove perspective', section: 'Block', keys: ['Space v'], disabledReason: () => doc.block(selected() ?? '')?.kind !== 'block' ? 'Select an ordinary block.' : !doc.block(selected()!)?.position ? 'Select a perspective.' : undefined, run: () => selected() && capabilities.invoke(capabilities.edit(selected()!, { kind: 'position', id: selected()!, value: false })) },
    ...['Make question', 'Make answer', 'Accept answer', 'Record aporia', 'Clear aporia', 'Park question', 'Resume question', 'Keep open', 'Let it settle', 'Set review date', 'Remove question', 'Remove answer'].map((title): Command => ({
      id: title.toLowerCase().replaceAll(' ', '-'), title, section: 'Outline', keys: title === 'Make question' || title === 'Make answer' ? ['Space q'] : undefined,
      disabledReason: () => {
        const item = selected() && investigationItems(selected()!).find(item => item.label === title);
        return item ? item.disabledReason : 'Select a matching question or answer.';
      },
      run: () => {
        const item = selected() && investigationItems(selected()!).find(item => item.label === title);
        if (item && !item.disabledReason) item.action();
      },
    })),
    { id: 'project', title: 'Project', section: 'Outline', keys: ['Space o'], disabledReason: () => selected() && doc.block(selected()!)?.project ? undefined : 'Select a project.', run: () => selected() && capabilities.open(selected()!, 'project') },
    { id: 'project-actions', title: 'Show actions', section: 'Outline', disabledReason: () => selected() && doc.block(selected()!)?.project ? undefined : 'Select a project.', run: () => selected() && capabilities.showActions(selected()!) },
    { id: 'review-cards', title: 'Review cards', section: 'View', run: () => props.onOpen({ kind: 'review' }, false) },
    { id: 'card-source', title: 'Show card source', section: 'Navigation', run: () => selected() && capabilities.source(selected()!) },
    { id: 'archive', title: 'Archive / unarchive block', section: 'Outline', run: () => selected() && apply({ kind: 'archive', id: selected()!, archived: !doc.block(selected()!)?.archived }, false) },
    { id: 'show-archived', title: 'Show / hide archived blocks', section: 'View', run: () => { anchored(() => setShowArchived(value => !value)); scheduleReport(); } },
    { id: 'delete', title: 'Delete selected subtrees', section: 'Outline', keys: ['Backspace', 'dd'], run: () => apply({ kind: 'delete', ids: roots() }, false) },
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
  const commands = commandDefinitions.map(command => ({ ...command, id: `outline.${props.pane}.${command.id}`, disabledReason: () => !props.active ? 'This pane is not active.' : command.disabledReason?.() ?? (command.section !== 'Page' && !['zoom-out', 'show-archived', 'undo', 'redo'].includes(command.id) && !selected() ? 'Select a block first.' : undefined) }));
  const unregister = props.commands.register(commands);
  /** Sections: Block, Move, Select. Pure navigation stays in the command palette and the shortcut list. */
  function blockMenu(id: string, anchor: HTMLElement) {
    if (!selectedSet().has(id)) rowFocus(id);
    const item = (commandId: string, options: { icon?: IconName; section?: string; danger?: boolean } = {}): MenuItem => {
      const command = commandDefinitions.find(candidate => candidate.id === commandId)!;
      return { ...options, label: command.title, shortcut: command.keys?.[0], disabledReason: command.disabledReason?.(), action: command.run };
    };
    const entry = doc.block(id);
    setMenu({ anchor, label: 'Block actions', items: [
      ...sourceResets(id),
      ...(entry?.citations.length ? [{ label: 'Remove citation', action: () => apply({ kind: 'uncite', id, citationIds: entry.citations.map(citation => citation.id) }, false) }] : []),
      { label: 'Add type…', icon: 'tag', action: () => { setCompletionIndex(0); setCompletion({ from: 0, to: 0, query: '', manual: { blockId: id, anchor } }); } },
      item('zoom', { icon: 'bullet' }),
      item('open-beside', { icon: 'panes' }),
      item('copy-reference', { icon: 'copy' }),
      ...(doc.block(id)?.task ? [
        { ...item('toggle-task', { section: 'Task' }), label: isFinished(doc.block(id)!.task!) ? 'Reopen task' : 'Complete task' },
        item('task-status'),
        { label: 'Plan task', action: () => capabilities.open(id, 'task', anchor) },
        { label: 'Work sessions', action: () => capabilities.open(id, 'work', anchor) },
        { label: 'Remove task', action: () => capabilities.invoke(capabilities.status(id, null)) },
      ] : [{ label: 'Make task', section: 'Task', shortcut: '⌘Enter', action: () => capabilities.invoke(capabilities.status(id, 'todo')) }]),
      ...(doc.block(id)?.project ? [
        { label: 'Project', section: 'Project', action: () => capabilities.open(id, 'project', anchor) },
        { label: 'Show actions', action: () => capabilities.showActions(id) },
      ] : [{ label: 'Make project', section: 'Project', action: () => capabilities.invoke(capabilities.edit(id, { kind: 'project', id, value: { status: 'active', outcome: '', deadline: null } })) }]),
      item(entry?.position ? 'remove-perspective' : 'make-perspective', { section: 'Block' }),
      ...investigationItems(id).map((item, index) => ({ ...item, section: index === 0 ? 'Question' : undefined })),
      ...(parseCardText(doc.block(id)?.text ?? '').cards.length ? [
        { label: 'Review cards', section: 'Cards', action: () => props.onOpen({ kind: 'review' }, false) },
        { label: 'Show card source', action: () => capabilities.source(id) },
      ] : [{ label: 'Add card', section: 'Cards', shortcut: 'Space c', action: () => addCard(id) }]),
      item('insert-below', { section: 'Move', icon: 'plus' }),
      item('indent', { icon: 'right' }),
      item('outdent', { icon: 'left' }),
      item('move-up', { icon: 'up' }),
      item('move-down', { icon: 'down' }),
      item('select', { section: 'Select', icon: 'select' }),
      item('select-all'),
      item('archive', { section: 'Block', icon: 'archive' }),
      item('delete', { icon: 'trash', danger: true }),
    ] });
  }
  /** Keyboard menus hand focus back to the row or editor that opened them before their action runs. */
  function keyboardMenu(id: string, label: string, items: MenuItem[]) {
    const anchor = rowAnchor(id);
    if (!anchor) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const refocus = () => { if (prior?.isConnected) prior.focus({ preventScroll: true }); };
    setMenu({ anchor, label, items: items.map(item => ({ ...item, action: () => { refocus(); item.action(); } })) });
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
  function openProject(id: string) {
    if (!doc.block(id)?.project) capabilities.invoke(capabilities.edit(id, { kind: 'project', id, value: { status: 'active', outcome: '', deadline: null } }));
    capabilities.open(id, 'project');
  }
  /** Appends ` >> ` and edits the back of the card. */
  function addCard(id: string) {
    const front = (doc.block(id)?.text ?? '').trimEnd();
    const text = `${front}${front ? ' ' : ''}>> `;
    if (context.editor?.id === id && editing() === id) { if (rewriteEditing(id, { text, caret: text.length })) editAt(id, text.length, true); return; }
    const result = doc.edit({ kind: 'text', id, text }, caret());
    if (!result.ok) { setMessage(result.reason); return; }
    editAt(id, text.length, true);
  }
  /** Space on a selected row (or in Vim normal mode): one more letter acts on the block. */
  function leaderMenu(id: string) {
    const leader = (key: string, label: string, run: () => void, section?: string): MenuItem => ({ key, shortcut: key, label, section, action: run });
    const commandItem = (key: string, commandId: string, section?: string): MenuItem => {
      const command = commandDefinitions.find(command => command.id === commandId)!;
      return { key, shortcut: key, label: command.title, section, disabledReason: command.disabledReason?.(), action: command.run };
    };
    const block = doc.block(id);
    let ancestor = block?.parentId ?? null;
    while (ancestor && !doc.block(ancestor)?.question) ancestor = doc.block(ancestor)?.parentId ?? null;
    keyboardMenu(id, 'Leader keys', [
      leader('t', 'Status…', () => statusMenu(id), 'Task'),
      leader('s', 'Schedule…', () => openPlanning(id, 'schedule')),
      leader('d', 'Deadline…', () => openPlanning(id, 'deadline')),
      leader('p', 'Priority…', () => priorityMenu(id)),
      leader('r', 'Repeat…', () => openPlanning(id, 'repeat')),
      leader('w', doc.block(id)?.task ? 'Clock in / out' : 'Clock in', () => capabilities.invoke(capabilities.clock(id))),
      commandItem('o', block?.project ? 'project' : 'make-project', 'Project'),
      ...(block?.question
        ? [leader('q', 'Question…', () => keyboardMenu(id, 'Question', investigationItems(id)), 'Question')]
        : [commandItem('q', ancestor ? 'make-answer' : 'make-question', 'Question')]),
      commandItem('v', block?.position ? 'remove-perspective' : 'make-perspective', 'Block'),
      leader('c', 'Add card', () => addCard(id)),
      leader('z', 'Zoom in', () => zoomTo(id)),
    ]);
  }
  return { openTable, investigationItems, commandDefinitions, unregister, blockMenu, statusMenu, priorityMenu, openPlanning, openProject, leaderMenu, referenceMenu, copy };
}
