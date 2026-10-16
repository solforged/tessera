import type { TaskState } from '../api/types';
import './priority-bars.css';

type Priority = NonNullable<TaskState['priority']>;
const levels: Record<Priority, number> = { low: 1, medium: 2, high: 3 };

/** Priority as three rising bars, filled to its level and tinted by it, so a list of tasks shows its urgent ones at a glance. */
export function PriorityBars(props: { priority: TaskState['priority']; label: string }) {
  return <svg class="priority-bars" data-priority={props.priority} viewBox="0 0 12 12" role="img" aria-label={props.label}>
    <title>{props.label}</title>
    {[0, 1, 2].map(bar => <rect x={1 + bar * 4} y={8 - bar * 3} width="2.5" height={3 + bar * 3} rx="0.5" classList={{ 'priority-bar-on': bar < (props.priority ? levels[props.priority] : 0) }} />)}
  </svg>;
}
