import { Show, createResource } from 'solid-js';
import type { NotebookClient, PageDocument } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import type { OpenTarget } from '../shell/contract';
import { opensBeside } from '../shell/beside';
import { TaskSourceRows } from '../tasks/JournalAgenda';
import { createTaskQuery } from '../tasks/query';
import { relativeDate } from '../tasks/task-labels';
import { Button } from '../ui/Button';
import './projects.css';

export function createProjectSummary(props: { doc: PageDocument; notebook: NotebookClient; date(): string; onOpen(target: OpenTarget, beside: boolean): void; onEdit(anchor: HTMLElement): void }) {
  const [tasks, { refetch }] = createResource(() => props.doc.root()?.project ? [props.notebook.changeSequence(), props.date()] as const : false, async ([, date]) => {
    const query = createTaskQuery(date);
    query.filter = { ...query.filter, project_id: props.doc.pageId, selection: 'all', sort: 'outline' };
    query.limit = 2000;
    const [next, plan, done] = await Promise.all([
      props.notebook.api.taskQuery({ ...query, filter: { ...query.filter, selection: 'unfinished' }, limit: 1 }),
      props.notebook.api.taskQuery({ ...query, filter: { ...query.filter, sort: 'plan', project_via: 'field' } }),
      props.notebook.api.taskQuery({ ...query, filter: { ...query.filter, statuses: ['done'] }, limit: 1 }),
    ]);
    return { next: next.rows[0], total: next.total + done.total, done: done.total, linked: plan.rows.filter(row => row.source.page.id !== props.doc.pageId) };
  });
  const labels = { active: 'Active', done: 'Done', cancelled: 'Cancelled' };
  function Summary() {
    return <Show when={props.doc.root()?.project}>{project => <section class="project-summary" aria-label="Project summary">
      <div class="project-summary-facts">
        <Button class="outline-planning" onClick={event => props.onEdit(event.currentTarget)}>{labels[project().status]}</Button>
        <Show when={project().deadline}>{date => <span>due {relativeDate(date(), props.notebook.todayDate())}</span>}</Show>
      </div>
      <Show when={project().outcome}><Button class="project-summary-outcome" onClick={event => props.onEdit(event.currentTarget)}>{project().outcome}</Button></Show>
      <Show when={!tasks.error && tasks()}>{value => <>
        <div class="project-summary-progress"><span>{value().done} of {value().total}</span><span class="project-progress-rule" role="progressbar" aria-label="Project progress" aria-valuemin={0} aria-valuemax={value().total} aria-valuenow={value().done} style={{ '--progress': `${value().total ? value().done / value().total * 100 : 0}%` }} /></div>
        <Show when={value().next}>{row => <Button class="project-summary-next" onClick={event => props.onOpen({ kind: 'page', pageId: row().source.page.id, blockId: row().source.block.id }, opensBeside(event))}>Next: <BlockText text={row().source.block.text} notebook={props.notebook} interactive={false} /></Button>}</Show>
      </>}</Show>
      <Show when={tasks.error}><p class="error" role="alert">{String(tasks.error)}</p></Show>
    </section>}</Show>;
  }
  function LinkedTasks() {
    return <Show when={!tasks.error && tasks()?.linked.length}><section class="related-sections project-linked-tasks" aria-label="Linked tasks" data-task-rows>
      <h2 class="outline-highlights-label">Linked tasks</h2>
      <TaskSourceRows rows={tasks()?.linked ?? []} date={props.date()} pageId={props.doc.pageId} notebook={props.notebook} plan onOpen={props.onOpen} onChanged={() => { void refetch(); }} />
    </section></Show>;
  }
  return { Summary, LinkedTasks };
}
