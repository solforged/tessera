import { Show, createEffect, createSignal, on, untrack } from 'solid-js';
import type { ProjectState } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { DatePicker } from '../tasks/DatePicker';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import './projects.css';

export interface ProjectControlsProps {
  notebook: NotebookClient;
  project: ProjectState | null;
  contextDate: string;
  disabled?: boolean;
  onChange(value: ProjectState | null): void | Promise<void>;
}

const statuses: readonly ProjectState['status'][] = ['active', 'done', 'cancelled'];
const statusLabels: Record<ProjectState['status'], string> = { active: 'Active', done: 'Done', cancelled: 'Cancelled' };
const emptyProject = (): ProjectState => ({ outcome: '', deadline: null, status: 'active' });

/** Each choice saves as it is made; the outcome saves on Enter or when focus leaves it. */
export function ProjectControls(props: ProjectControlsProps) {
  const [outcome, setOutcome] = createSignal(props.project?.outcome ?? '');
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [deadlineAnchor, setDeadlineAnchor] = createSignal<HTMLElement | null>(null);
  const [statusAnchor, setStatusAnchor] = createSignal<HTMLElement | null>(null);
  const disabled = () => !!props.disabled || pending();
  let field: HTMLTextAreaElement | undefined;
  let focused = false;

  // Refresh the outcome from the notebook unless it holds unsaved or rejected input.
  createEffect(on(() => props.project?.outcome, value => {
    if (!untrack(pending) && !untrack(error) && document.activeElement !== field) setOutcome(value ?? '');
  }));
  // A project made by the command that opened this popup arrives a moment later; the outcome takes focus once it can be typed in.
  createEffect(() => {
    if (focused || !props.project || disabled() || !field?.isConnected) return;
    focused = true;
    field.focus();
  });
  createEffect(() => {
    if (disabled() || !props.project) {
      setDeadlineAnchor(null);
      setStatusAnchor(null);
    }
  });

  const save = async (value: ProjectState | null) => {
    if (disabled()) return;
    setPending(true);
    setDeadlineAnchor(null);
    setStatusAnchor(null);
    try {
      await props.onChange(value);
      setError('');
    } catch (reason) {
      setError((reason instanceof Error ? reason.message : String(reason)) || 'Could not save project.');
    } finally {
      setPending(false);
    }
  };
  const current = () => props.project ?? emptyProject();
  const saveOutcome = () => {
    const value = outcome().trim();
    if (props.project && value !== props.project.outcome) void save({ ...current(), outcome: value });
  };

  return <div class="project-controls" role="group" aria-label="Project" aria-busy={pending()}>
    <Show when={props.project} fallback={<Button class="bordered" disabled={disabled()} onClick={() => { void save(emptyProject()); }}>Make project</Button>}>
      <label class="project-outcome">
        <span>Outcome</span>
        <textarea ref={field} class="input" rows={2} value={outcome()} disabled={disabled()} placeholder="What done looks like"
          onInput={event => { setOutcome(event.currentTarget.value); setError(''); }}
          onBlur={saveOutcome}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); saveOutcome(); } }} />
      </label>
      <div class="project-controls-row">
        <Button class="bordered" disabled={disabled()} aria-label={`Deadline: ${current().deadline ?? 'None'}`} aria-haspopup="dialog" aria-expanded={!!deadlineAnchor()} onClick={event => { setStatusAnchor(null); setDeadlineAnchor(event.currentTarget); }}>
          Deadline<Show when={current().deadline}>{date => <span>{date()}</span>}</Show><Icon name="down" />
        </Button>
        <Button class="bordered" disabled={disabled()} aria-label={`Project status: ${statusLabels[current().status]}`} aria-haspopup="menu" aria-expanded={!!statusAnchor()} onClick={event => { setDeadlineAnchor(null); setStatusAnchor(event.currentTarget); }}>
          {statusLabels[current().status]}<Icon name="down" />
        </Button>
        <Button class="danger" disabled={disabled()} onClick={() => { void save(null); }}>Remove project</Button>
      </div>
      <Show when={deadlineAnchor()}>{anchor => <DatePicker notebook={props.notebook} anchor={anchor()} label="Deadline" value={current().deadline} contextDate={props.contextDate} onDismiss={() => setDeadlineAnchor(null)} onSelect={value => save({ ...current(), outcome: outcome().trim(), deadline: value.date })} />}</Show>
      <Show when={statusAnchor()}>{anchor => <Menu anchor={anchor()} label="Project status" onDismiss={() => setStatusAnchor(null)} items={statuses.map(status => ({
        label: statusLabels[status],
        icon: status === current().status ? 'check' as const : undefined,
        action: () => { void save({ ...current(), outcome: outcome().trim(), status }); },
      }))} />}</Show>
    </Show>
    <Show when={error()}><p class="project-error error" role="alert">{error()}</p></Show>
  </div>;
}
