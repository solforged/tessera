import { describe, expect, test } from 'bun:test';
import type { TaskState } from '../api/types';
import { dateSuggestions, dateTokenAt, newTask, planDateToken } from './quick-date';

const context = '2026-10-03';
const task: TaskState = {
  status: 'waiting', scheduled: '2026-09-01', scheduled_time: '10:30',
  deadline: '2026-12-31', deadline_time: '17:00', warning_days: 3,
  repeater: { every: 2, unit: 'week', mode: 'fixed' }, priority: 'high', completed_on: null,
};
const atEnd = (text: string) => dateTokenAt(text, text.length);

describe('date completion tokens', () => {
  test('accepts the start of text and whitespace boundaries, including an empty query', () => {
    expect(atEnd('@')).toEqual({ from: 0, to: 1, query: '' });
    expect(atEnd('@today')).toEqual({ from: 0, to: 6, query: 'today' });
    expect(atEnd('Read @')).toEqual({ from: 5, to: 6, query: '' });
    expect(atEnd('Read\t@tomorrow')).toEqual({ from: 5, to: 14, query: 'tomorrow' });
    expect(atEnd('Read\n@today')).toEqual({ from: 5, to: 11, query: 'today' });
    expect(atEnd('Read @today @tom')).toEqual({ from: 12, to: 16, query: 'tom' });
  });

  test('rejects mid-word, doubled and escaped @ markers without falling back to an earlier marker', () => {
    for (const text of ['name@today', '@@today', 'Read @@today', String.raw`\@today`, String.raw`Read \@today`, 'Read @today name@tom']) {
      expect(atEnd(text)).toBeNull();
    }
    expect(dateTokenAt('@today', 0)).toBeNull();
    expect(atEnd('')).toBeNull();
  });

  test('uses the caret rather than the end of text', () => {
    expect(dateTokenAt('Read @tomorrow then translate @today', 14)).toEqual({ from: 5, to: 14, query: 'tomorrow' });
    expect(dateTokenAt('Read @tomorrow', 6)).toEqual({ from: 5, to: 6, query: '' });
    expect(dateTokenAt('Read @tomorrow', 5)).toBeNull();
  });

  test('rejects newlines, leading whitespace and queries longer than 24 characters', () => {
    for (const text of ['Read @next\nMonday', 'Read @next\rMonday', 'Read @ today', 'Read @\ttoday', '@' + 'a'.repeat(25)]) {
      expect(atEnd(text)).toBeNull();
    }
    expect(atEnd('@' + 'a'.repeat(24))).toEqual({ from: 0, to: 25, query: 'a'.repeat(24) });
    expect(atEnd('Read @next Thursday')?.query).toBe('next Thursday');
    expect(atEnd('Read @in 2 weeks')?.query).toBe('in 2 weeks');
    expect(atEnd('Read @tomorrow 09:05')?.query).toBe('tomorrow 09:05');
  });

  test('leaves whole-text field shorthand ahead of completion, but accepts card and cloze markup', () => {
    for (const text of ['Author:: @today', 'When:: @next Monday', 'Time:: @tomorrow 09:05']) {
      expect(atEnd(text)).toBeNull();
    }
    expect(dateTokenAt('When:: @tomorrow then translate', 15)).toBeNull();
    for (const text of ['Front >> Back::suffix @tomorrow', '{{c1::answer}} @tomorrow']) {
      expect(atEnd(text)).toEqual({ from: text.lastIndexOf('@'), to: text.length, query: 'tomorrow' });
    }
  });

  test('protects complete and unfinished references, respecting escaped delimiters', () => {
    for (const text of ['Read [[source| @today]]', 'Read [[source| @today', 'Read [[ @tomorrow', 'Read #[[source| @today', 'Read #[[ @today]]', String.raw`Read [[source \]] @today`]) {
      expect(atEnd(text)).toBeNull();
    }
    const reference = 'Read [[source| @today]]';
    expect(dateTokenAt(reference, reference.length - 2)).toBeNull();
    expect(atEnd('Read [[source|some @name]] @tomorrow')?.query).toBe('tomorrow');
    expect(atEnd(String.raw`Read \[[literal @tomorrow`)?.query).toBe('tomorrow');
  });

  test('protects inline code with unmatched or unequal backtick runs and respects escaped opening ticks', () => {
    for (const text of ['Read ` @today`', 'Read ` @today', 'Read ``literal ` @today', 'Read ```literal ` @today']) {
      expect(atEnd(text)).toBeNull();
    }
    expect(atEnd('Read `@today` @tomorrow')?.query).toBe('tomorrow');
    expect(atEnd('Read ``literal ` code`` @tomorrow')?.query).toBe('tomorrow');
    expect(atEnd('Read \\`literal @tomorrow')?.query).toBe('tomorrow');
  });

  test('protects backtick and tilde fences until a matching closing line', () => {
    for (const text of ['```\nplan @today', '~~~md\nplan @today', '  ````md\n```\nplan @today', '~~~\n~~~ still code\nplan @today']) {
      expect(atEnd(text)).toBeNull();
    }
    expect(atEnd('```md\n@today\n```\nRead @tomorrow')?.query).toBe('tomorrow');
    expect(atEnd('~~~md\n@today\n~~~~\nRead @tomorrow')?.query).toBe('tomorrow');
  });
});

describe('date completion suggestions', () => {
  test('returns all eight presets in order for empty or whitespace-only queries', () => {
    const expected = [
      { label: 'Today', date: '2026-10-03', time: null },
      { label: 'Tomorrow', date: '2026-10-04', time: null },
      { label: 'Monday', date: '2026-10-05', time: null },
      { label: 'Tuesday', date: '2026-10-06', time: null },
      { label: 'Wednesday', date: '2026-10-07', time: null },
      { label: 'Thursday', date: '2026-10-08', time: null },
      { label: 'Friday', date: '2026-10-09', time: null },
      { label: 'Next week', date: '2026-10-10', time: null },
    ];
    expect(dateSuggestions('', context)).toEqual(expected);
    expect(dateSuggestions(' \t ', context)).toEqual(expected);
  });

  test('places a recognized parse first and deduplicates its matching preset by date and time', () => {
    expect(dateSuggestions('today', context)).toEqual([{ label: 'Today', date: context, time: null }]);
    expect(dateSuggestions('mon', context)).toEqual([{ label: 'Monday', date: '2026-10-05', time: null }]);
    expect(dateSuggestions('  TOMORROW  ', context)).toEqual([{ label: 'Tomorrow', date: '2026-10-04', time: null }]);
    expect(dateSuggestions('yesterday', context)).toEqual([{ label: 'Yesterday', date: '2026-10-02', time: null }]);
    expect(dateSuggestions('Next   thu', '2026-12-31')).toEqual([{ label: 'Next Thursday', date: '2027-01-07', time: null }]);
  });

  test('matches case-insensitive label prefixes and next-week aliases in preset order', () => {
    expect(dateSuggestions('t', context).map(choice => choice.label)).toEqual(['Today', 'Tomorrow', 'Tuesday', 'Thursday']);
    expect(dateSuggestions('TOD', context).map(choice => choice.label)).toEqual(['Today']);
    expect(dateSuggestions('w', context).map(choice => choice.label)).toEqual(['Wednesday', 'Next week']);
    for (const query of ['next', 'next week', 'week']) {
      expect(dateSuggestions(query, context)).toEqual([{ label: 'Next week', date: '2026-10-10', time: null }]);
    }
    expect(dateSuggestions('thur', context).map(choice => choice.label)).toEqual(['Thursday']);
    expect(dateSuggestions('unrecognized', context)).toEqual([]);
  });

  test('derives weekday labels from actual civil dates across month, year and leap-day boundaries', () => {
    expect(dateSuggestions('', '2026-12-30').slice(2)).toEqual([
      { label: 'Friday', date: '2027-01-01', time: null },
      { label: 'Saturday', date: '2027-01-02', time: null },
      { label: 'Sunday', date: '2027-01-03', time: null },
      { label: 'Monday', date: '2027-01-04', time: null },
      { label: 'Tuesday', date: '2027-01-05', time: null },
      { label: 'Next week', date: '2027-01-06', time: null },
    ]);
    expect(dateSuggestions('+2d', '2024-02-28')).toEqual([{ label: 'Friday', date: '2024-03-01', time: null }]);
    expect(dateSuggestions('2027-01-01', '2026-12-31')).toEqual([{ label: 'Friday', date: '2027-01-01', time: null }]);
    expect(dateSuggestions('in 2 weeks', '2026-12-31')).toEqual([{ label: 'Thursday', date: '2027-01-14', time: null }]);
    expect(dateSuggestions('+0d', '0001-01-01')).toEqual([{ label: 'Monday', date: '0001-01-01', time: null }]);
    expect(dateSuggestions('+1d', '0099-12-31')).toEqual([{ label: 'Friday', date: '0100-01-01', time: null }]);
  });

  test('retains parsed local time in natural and computed weekday labels', () => {
    expect(dateSuggestions('tomorrow 09:05', '2024-02-28')).toEqual([{ label: 'Tomorrow 09:05', date: '2024-02-29', time: '09:05' }]);
    expect(dateSuggestions('NEXT THU 23:59', '2026-12-31')).toEqual([{ label: 'Next Thursday 23:59', date: '2027-01-07', time: '23:59' }]);
    expect(dateSuggestions('2027-01-01 00:00', context)).toEqual([{ label: 'Friday 00:00', date: '2027-01-01', time: '00:00' }]);
    expect(dateSuggestions('+2d 09:05', '2024-02-28')).toEqual([{ label: 'Friday 09:05', date: '2024-03-01', time: '09:05' }]);
    for (const query of ['today 24:00', 'today 9:05', '09:05', '2026-02-29']) expect(dateSuggestions(query, context)).toEqual([]);
  });

  test('caps non-empty results at seven while keeping every empty-query preset', () => {
    expect(dateSuggestions('', context)).toHaveLength(8);
    for (const query of ['t', 'w', 's', 'next', 'mon', 'today', '+7d']) {
      const choices = dateSuggestions(query, context);
      expect(choices.length).toBeLessThanOrEqual(7);
      expect(new Set(choices.map(choice => `${choice.date}/${choice.time}`)).size).toBe(choices.length);
    }
  });

  test('does not fall back to a device date for invalid context or out-of-range offsets', () => {
    expect(dateSuggestions('', 'not a date')).toEqual([]);
    expect(dateSuggestions('today', '2026-02-29')).toEqual([]);
    expect(dateSuggestions('tomorrow', '9999-12-31')).toEqual([]);
    expect(dateSuggestions('', '9999-12-31')).toEqual([{ label: 'Today', date: '9999-12-31', time: null }]);
  });
});

describe('date completion plans', () => {
  test('turns a plain block into a scheduled todo task and removes the token with its leading space', () => {
    const text = 'Read @tomorrow';
    const choice = dateSuggestions('tomorrow', context)[0]!;
    expect(planDateToken(text, atEnd(text)!, choice, null)).toEqual({
      text: 'Read',
      caret: 4,
      value: { status: 'todo', scheduled: '2026-10-04', scheduled_time: null, deadline: null, deadline_time: null, warning_days: null, repeater: null, priority: null, completed_on: null },
    });
    const first = newTask();
    first.status = 'done';
    expect(newTask().status).toBe('todo');
  });

  test('preserves every unrelated task property and source character, including text after the caret', () => {
    const text = '  Translate the passage\t @tomorrow 09:05  then rest';
    const caret = text.indexOf('  then rest');
    const token = dateTokenAt(text, caret)!;
    const choice = dateSuggestions(token.query, '2024-02-28')[0]!;
    expect(planDateToken(text, token, choice, task)).toEqual({
      text: '  Translate the passage  then rest',
      caret: 23,
      value: { ...task, scheduled: '2024-02-29', scheduled_time: '09:05' },
    });
    expect(task.scheduled).toBe('2026-09-01');
    expect(task.scheduled_time).toBe('10:30');
  });

  test('removes an empty token on selection and clears an existing time for an untimed choice', () => {
    const text = 'Read @ next';
    const token = dateTokenAt(text, 6)!;
    expect(planDateToken(text, token, dateSuggestions('', context)[0]!, task)).toEqual({
      text: 'Read next', caret: 4, value: { ...task, scheduled: context, scheduled_time: null },
    });
  });

  test('keeps the space before punctuation and keeps the plan when the full picker will choose', () => {
    const text = 'Read @tom.';
    const token = dateTokenAt(text, 9)!;
    expect(planDateToken(text, token, null, task)).toEqual({ text: 'Read .', caret: 5, value: task });
    expect(planDateToken(text, token, null, null).value).toEqual(newTask());
  });
});
