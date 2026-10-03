import { Show, createEffect, createSignal, on, untrack } from 'solid-js';
import type { ProjectState } from '../api/types';
import { DatePicker } from '../tasks/DatePicker';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import './projects.css';

export interface ProjectControlsProps {
  project: ProjectState | null;
  contextDate: string;
  disabled?: boolean;
  onChange(value: ProjectState | null): void | Promise<void>;
}

const statuses: readonly ProjectState['status'][] = ['active', 'done', 'cancelled'];
const statusLabels: Record<ProjectState['status'], string> = { active: 'Active', done: 'Done', cancelled: 'Cancelled' };
const emptyProject = (): ProjectState => ({ outcome: '', deadline: null, status: 'active' });

export function ProjectControls(props: ProjectControlsProps) {
  const [draft, setDraft] = createSignal<ProjectState>({ ...(props.project ?? emptyProject()) });
  const [dirty, setDirty] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [deadlineAnchor, setDeadlineAnchor] = createSignal<HTMLElement | null>(null);
  const [statusAnchor, setStatusAnchor] = createSignal<HTMLElement | null>(null);
  const disabled = () => !!props.disabled || pending();

  // Refresh clean controls without replacing unsaved or rejected input.
  createEffect(on(
    () => [props.project?.outcome, props.project?.deadline, props.project?.status] as const,
    () => {
      if (!untrack(dirty) && !untrack(pending) && !untrack(error)) {
        setDraft({ ...(props.project ?? emptyProject()) });
      }
    },
  ));
  createEffect(() => {
    if (disabled() || !props.project) {
      setDeadlineAnchor(null);
      setStatusAnchor(null);
    }
  });

  const edit = (value: Partial<ProjectState>) => {
    if (disabled()) return;
    setDirty(true);
    setDraft(current => ({ ...current, ...value }));
  };
  const save = async (value: ProjectState | null) => {
    if (disabled()) return;
    setPending(true);
    setDeadlineAnchor(null);
    setStatusAnchor(null);
    try {
      await props.onChange(value);
      setDirty(false);
      setDraft({ ...(value ?? emptyProject()) });
      setError('');
    } catch (reason) {
      setError((reason instanceof Error ? reason.message : String(reason)) || 'Could not save project.');
    } finally {
      setPending(false);
    }
  };

  return <div class="project-controls" role="group" aria-label="Project" aria-busy={pending()}>
    <Show when={props.project} fallback={<Button class="bordered" disabled={disabled()} onClick={() => { void save(emptyProject()); }}>Make project</Button>}>
      <label class="project-outcome">
        <span>Outcome</span>
        <textarea class="input" rows={2} value={draft().outcome} disabled={disabled()} onInput={event => edit({ outcome: event.currentTarget.value })} />
      </label>
      <div class="project-controls-row">
        <Button class="bordered" disabled={disabled()} aria-label={`Deadline: ${draft().deadline ?? 'None'}`} aria-haspopup="dialog" aria-expanded={!!deadlineAnchor()} onClick={event => { setStatusAnchor(null); setDeadlineAnchor(event.currentTarget); }}>
          Deadline<Show when={draft().deadline}>{date => <span>{date()}</span>}</Show><Icon name="down" />
        </Button>
        <Button class="bordered" disabled={disabled()} aria-label={`Project status: ${statusLabels[draft().status]}`} aria-haspopup="menu" aria-expanded={!!statusAnchor()} onClick={event => { setDeadlineAnchor(null); setStatusAnchor(event.currentTarget); }}>
          {statusLabels[draft().status]}<Icon name="down" />
        </Button>
        <Button class="bordered" disabled={disabled()} onClick={() => { void save({ ...draft() }); }}>Save</Button>
        <Button class="danger" disabled={disabled()} onClick={() => { void save(null); }}>Remove project</Button>
      </div>
      <Show when={deadlineAnchor()}>{anchor => <DatePicker anchor={anchor()} label="Deadline" value={draft().deadline} contextDate={props.contextDate} onDismiss={() => setDeadlineAnchor(null)} onSelect={value => {
        edit({ deadline: value.date });
        setDeadlineAnchor(null);
      }} />}</Show>
      <Show when={statusAnchor()}>{anchor => <Menu anchor={anchor()} label="Project status" onDismiss={() => setStatusAnchor(null)} items={statuses.map(status => ({
        label: statusLabels[status],
        icon: status === draft().status ? 'check' as const : undefined,
        action: () => edit({ status }),
      }))} />}</Show>
    </Show>
    <Show when={error()}><p class="project-error error" role="alert">{error()}</p></Show>
  </div>;
}
