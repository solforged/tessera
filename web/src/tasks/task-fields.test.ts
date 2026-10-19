import { describe, expect, test } from 'bun:test';
import type { FieldDefinition } from '../api/types';
import { newTask } from './quick-date';
import { taskFieldFormat, taskFieldName, taskFieldText } from './task-fields';
import { attributeDefinitions } from '../table/attributes';

const field = (name: string): FieldDefinition => ({ id: name, name, kind: 'text', revision: 1, built_in: true, options: [], targets: [] });

describe('canonical task fields', () => {
  test('retains the saved Deadline alias and does not claim user fields', () => {
    expect(taskFieldName({ id: '@due', name: 'Due' })).toBe('deadline');
    expect(taskFieldName(field('status'))).toBe('status');
    expect(taskFieldName({ ...field('status'), built_in: false })).toBeUndefined();
    expect(taskFieldName(field('Supplier'))).toBeUndefined();
    const attributes = attributeDefinitions('tasks');
    expect(attributes.filter(field => taskFieldName(field)).map(field => field.id)).toEqual(['@status', '@scheduled', '@deadline', '@priority', '@repeat', '@project', '@due']);
  });
  test('presents task-backed formats and values without field-entry copies', () => {
    expect(taskFieldFormat(field('repeat'))).toBe('Repeat');
    expect(taskFieldFormat(field('scheduled'))).toBe('Date + time');
    const task = { ...newTask('todo'), scheduled: '2026-10-19', scheduled_time: '14:00', priority: 'high' as const, repeater: { every: 2, unit: 'week' as const, mode: 'fixed' as const } };
    expect(taskFieldText(task, 'status')).toBe('Todo');
    expect(taskFieldText(task, 'scheduled')).toBe('2026-10-19 14:00');
    expect(taskFieldText(task, 'priority')).toBe('High');
    expect(taskFieldText(task, 'repeat')).toBe('Fixed · 2 weeks');
    expect(taskFieldText({ ...task, status: null }, 'status')).toBe('');
  });
});
