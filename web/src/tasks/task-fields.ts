import type { FieldDefinition, TaskState } from '../api/types';

export const taskFieldNames = ['status', 'scheduled', 'deadline', 'priority', 'repeat', 'project'] as const;
export type TaskFieldName = typeof taskFieldNames[number];
export function taskFieldName(field: Pick<FieldDefinition, 'id' | 'name' | 'built_in'>): TaskFieldName | undefined {
  const name = field.id === '@due' ? 'deadline' : field.id.startsWith('@') ? field.id.slice(1) : field.built_in ? field.name.toLowerCase() : '';
  return taskFieldNames.includes(name as TaskFieldName) ? name as TaskFieldName : undefined;
}
export const taskFieldLabel = (name: TaskFieldName) => name;
export function taskFieldFormat(field: FieldDefinition): string | undefined {
  const name = taskFieldName(field);
  return name === 'repeat' ? 'Repeat' : name === 'scheduled' || name === 'deadline' ? 'Date + time' : undefined;
}
export function taskFieldText(task: TaskState | null | undefined, name: TaskFieldName): string {
  if (!task) return '';
  switch (name) {
    case 'status':
    case 'priority': {
      const value = task[name];
      return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
    }
    case 'scheduled': return task.scheduled ? `${task.scheduled}${task.scheduled_time ? ` ${task.scheduled_time}` : ''}` : '';
    case 'deadline': return task.deadline ? `${task.deadline}${task.deadline_time ? ` ${task.deadline_time}` : ''}` : '';
    case 'repeat': {
      const repeat = task.repeater;
      return repeat ? `${repeat.mode === 'fixed' ? 'Fixed' : repeat.mode === 'catch_up' ? 'Catch up' : 'After completion'} · ${repeat.every} ${repeat.unit}${repeat.every === 1 ? '' : 's'}` : '';
    }
    case 'project': return '';
  }
}
export const taskFieldPlaceholder = (name: TaskFieldName) => name === 'scheduled' || name === 'deadline' ? 'Add date…' : name === 'repeat' ? 'Add repeat…' : name === 'project' ? 'Add project…' : 'None';
