import { describe, expect, test } from 'bun:test';
import type { TaskState } from '../api/types';
import { dateSuggestions, dateTokenAt, flipDateToken, newTask, planDateToken, removeToken } from './quick-date';

const context = '2026-10-03';
const task: TaskState = {
  status: 'waiting', scheduled: '2026-09-01', scheduled_time: '10:30',
  deadline: '2026-12-31', deadline_time: '17:00', warning_days: 3,
  repeater: { every: 2, unit: 'week', mode: 'fixed' }, priority: 'high', completed_on: null,
};
const atEnd = (text: string) => dateTokenAt(text, text.length);

describe('date completion tokens', () => {
  test('accepts the start of text and whitespace boundaries, including an empty query', () => {
    expect(atEnd('@')).toEqual({ from: 0, to: 1, query: '', field: 'scheduled' });
    expect(atEnd('@today')).toEqual({ from: 0, to: 6, query: 'today', field: 'scheduled' });
    expect(atEnd('Read @')).toEqual({ from: 5, to: 6, query: '', field: 'scheduled' });
    expect(atEnd('Read\t@tomorrow')).toEqual({ from: 5, to: 14, query: 'tomorrow', field: 'scheduled' });
    expect(atEnd('Read\n@today')).toEqual({ from: 5, to: 11, query: 'today', field: 'scheduled' });
    expect(atEnd('Read @today @tom')).toEqual({ from: 12, to: 16, query: 'tom', field: 'scheduled' });
  });

  test('rejects mid-word, doubled and escaped @ markers without falling back to an earlier marker', () => {
    for (const text of ['name@today', '@@today', 'Read @@today', String.raw`\@today`, String.raw`Read \@today`, 'Read @today name@tom']) {
      expect(atEnd(text)).toBeNull();
    }
    expect(dateTokenAt('@today', 0)).toBeNull();
    expect(atEnd('')).toBeNull();
  });

  test('uses the caret rather than the end of text', () => {
    expect(dateTokenAt('Read @tomorrow then translate @today', 14)).toEqual({ from: 5, to: 14, query: 'tomorrow', field: 'scheduled' });
    expect(dateTokenAt('Read @tomorrow', 6)).toEqual({ from: 5, to: 6, query: '', field: 'scheduled' });
    expect(dateTokenAt('Read @tomorrow', 5)).toBeNull();
  });

  test('rejects newlines and whitespace directly after the marker', () => {
    for (const text of ['Read @next\nMonday', 'Read @next\rMonday', 'Read @ today', 'Read @\ttoday']) {
      expect(atEnd(text)).toBeNull();
    }
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
      expect(atEnd(text)).toEqual({ from: text.lastIndexOf('@'), to: text.length, query: 'tomorrow', field: 'scheduled' });
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

  test('recognizes complete by and due keywords followed by spaces or the caret', () => {
    for (const [text, query] of [
      ['@by', ''], ['@by ', ''], ['@BY   ', ''], ['@By fri', 'fri'],
      ['@due', ''], ['@due ', ''], ['@DUE   ', ''], ['@Due fri', 'fri'],
      ['Read @by   in 2 weeks', 'in 2 weeks'], ['@by oct 12 3pm', 'oct 12 3pm'],
      ['Read @due   in 2 weeks', 'in 2 weeks'], ['@due tomorrow 09:05', 'tomorrow 09:05'],
    ] as const) {
      expect(atEnd(text)).toEqual({ from: text.lastIndexOf('@'), to: text.length, query, field: 'deadline' });
    }
    for (const query of ['bye', 'bygone', 'b', 'dues', 'du', 'fri', 'by\tfri', 'due\tfri', 'by-date', 'due-date']) {
      expect(atEnd('@' + query)).toEqual({ from: 0, to: query.length + 1, query, field: 'scheduled' });
    }
    expect(dateTokenAt('Read @due fri next', 9)).toEqual({ from: 5, to: 9, query: '', field: 'deadline' });
    expect(dateTokenAt('Read @by fri next', 8)).toEqual({ from: 5, to: 8, query: '', field: 'deadline' });
  });

  test('accepts long date forms while retaining protection rules for deadline tokens', () => {
    for (const word of ['by', 'due']) {
      const text = `Read @${word} september 12 2027 15:00`;
      expect(atEnd(text)).toEqual({ from: 5, to: text.length, query: 'september 12 2027 15:00', field: 'deadline' });
    }
    for (const text of ['@by\nfri', '@due\nfri', 'When:: @due fri', 'Read [[ @due fri', 'Read ` @due fri', 'name@due fri']) {
      expect(atEnd(text)).toBeNull();
    }
  });
});

describe('date completion field flips', () => {
  test('adds by to scheduled tokens and removes either deadline word', () => {
    for (const [text, rewritten] of [
      ['@', '@by '],
      ['Read @fri', 'Read @by fri'],
      ['Read @oct 12 3pm', 'Read @by oct 12 3pm'],
      ['Read @bye', 'Read @by bye'],
      ['Read @by fri', 'Read @fri'],
      ['Read @due fri', 'Read @fri'],
      ['Read @BY   oct 12 3pm', 'Read @oct 12 3pm'],
      ['@by', '@'],
      ['@due ', '@'],
    ] as const) {
      expect(flipDateToken(text, atEnd(text)!)).toEqual({ text: rewritten, caret: rewritten.length });
    }
  });

  test('keeps the query and every surrounding character when the caret is inside a block', () => {
    const text = '  Read\t@oct 12 3pm  then rest';
    const caret = text.indexOf('  then rest');
    const deadline = flipDateToken(text, dateTokenAt(text, caret)!);
    expect(deadline).toEqual({ text: '  Read\t@by oct 12 3pm  then rest', caret: caret + 3 });
    expect(dateTokenAt(deadline.text, deadline.caret)?.field).toBe('deadline');
    expect(flipDateToken(deadline.text, dateTokenAt(deadline.text, deadline.caret)!)).toEqual({ text, caret });
    const due = 'Read @due  fri! and rest';
    const dueCaret = due.indexOf('!');
    expect(flipDateToken(due, dateTokenAt(due, dueCaret)!)).toEqual({ text: 'Read @fri! and rest', caret: dueCaret - 5 });
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
    expect(dateSuggestions('tomorrow 9:05', '2024-02-28')[0]).toEqual({ label: 'Tomorrow 09:05', date: '2024-02-29', time: '09:05' });
    expect(dateSuggestions('09:05', context)[0]).toEqual({ label: 'Today 09:05', date: context, time: '09:05' });
    for (const query of ['today 24:00', '2026-02-29']) expect(dateSuggestions(query, context)).toEqual([]);
  });

  test('puts month/day, next-week weekday and bare-time parses before presets', () => {
    for (const query of ['oct 12 3pm', '12 october 2026 15:00']) {
      expect(dateSuggestions(query, context)[0]).toEqual({ label: 'Monday 15:00', date: '2026-10-12', time: '15:00' });
    }
    expect(dateSuggestions('next fri 3:30pm', '2026-10-05')[0]).toEqual({ label: 'Next Friday 15:30', date: '2026-10-16', time: '15:30' });
    expect(dateSuggestions('3pm', context)[0]).toEqual({ label: 'Today 15:00', date: context, time: '15:00' });
    expect(dateSuggestions('jan 3', '2026-12-28')[0]?.date).toBe('2027-01-03');
    expect(dateSuggestions('feb 30', context)).toEqual([]);
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

  test('creates a deadline task with a chosen local time and no schedule', () => {
    const text = 'Read @due tomorrow 09:05';
    const token = atEnd(text)!;
    const choice = dateSuggestions(token.query, context)[0]!;
    expect(planDateToken(text, token, choice, null)).toEqual({
      text: 'Read', caret: 4, value: { ...newTask(), deadline: '2026-10-04', deadline_time: '09:05' },
    });
  });

  test('plans either deadline word with named dates and normalized time, including annual rollover', () => {
    for (const word of ['by', 'due']) {
      const text = `Read @${word} oct 12 3pm`;
      const token = atEnd(text)!;
      for (const [from, deadline] of [[context, '2026-10-12'], ['2026-10-13', '2027-10-12']] as const) {
        const choice = dateSuggestions(token.query, from)[0]!;
        expect(planDateToken(text, token, choice, null)).toEqual({
          text: 'Read', caret: 4, value: { ...newTask(), deadline, deadline_time: '15:00' },
        });
      }
    }
    expect(atEnd('Read @bye fri')?.field).toBe('scheduled');
    expect(dateSuggestions(atEnd('Read @bye fri')!.query, context)).toEqual([]);
  });

  test('updates only the deadline fields of an existing task', () => {
    const text = 'Read @due tomorrow 09:05';
    const token = atEnd(text)!;
    const choice = dateSuggestions(token.query, context)[0]!;
    expect(planDateToken(text, token, choice, task)).toEqual({
      text: 'Read', caret: 4, value: { ...task, deadline: '2026-10-04', deadline_time: '09:05' },
    });
    expect(task.deadline).toBe('2026-12-31');
    expect(task.deadline_time).toBe('17:00');
  });

  test('clears only the deadline time for an untimed choice and preserves plans for the picker', () => {
    const text = 'Read @due';
    const token = atEnd(text)!;
    expect(planDateToken(text, token, dateSuggestions('', context)[0]!, task)).toEqual({
      text: 'Read', caret: 4, value: { ...task, deadline: context, deadline_time: null },
    });
    expect(planDateToken(text, token, null, task)).toEqual({ text: 'Read', caret: 4, value: task });
    expect(planDateToken(text, token, null, null)).toEqual({ text: 'Read', caret: 4, value: newTask() });
  });
});

describe('token removal', () => {
  test('trims introducing whitespace at the end while preserving the rest of the text', () => {
    expect(removeToken('  Read\t @due', { from: 8, to: 12 })).toEqual({ text: '  Read', caret: 6 });
    expect(removeToken('/task', { from: 0, to: 5 })).toEqual({ text: '', caret: 0 });
  });

  test('trims introducing whitespace but retains the exact whitespace-led suffix', () => {
    expect(removeToken('Read\t /task  then rest', { from: 6, to: 11 })).toEqual({ text: 'Read  then rest', caret: 4 });
    expect(removeToken('Read /task\nnext', { from: 5, to: 10 })).toEqual({ text: 'Read\nnext', caret: 4 });
    expect(removeToken('Read /task   ', { from: 5, to: 10 })).toEqual({ text: 'Read   ', caret: 4 });
  });

  test('keeps introducing whitespace before punctuation or other non-whitespace suffixes', () => {
    expect(removeToken('Read /task.', { from: 5, to: 10 })).toEqual({ text: 'Read .', caret: 5 });
    expect(removeToken('Read /tasknext', { from: 5, to: 10 })).toEqual({ text: 'Read next', caret: 5 });
  });
});
