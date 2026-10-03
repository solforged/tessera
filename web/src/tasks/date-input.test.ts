import { describe, expect, test } from 'bun:test';
import { parseTaskDate } from './date-input';

describe('task date input', () => {
  const context = '2026-10-03';

  test('clears only blank input, not an unfinished prefix', () => {
    expect(parseTaskDate('', context)).toEqual({ ok: true, date: null, time: null });
    expect(parseTaskDate(' \t\n ', context)).toEqual({ ok: true, date: null, time: null });
    expect(parseTaskDate('', 'not a context')).toEqual({ ok: true, date: null, time: null });
    for (const input of ['@', '@ ', '@@today']) expect(parseTaskDate(input, context).ok).toBe(false);
  });

  test('parses ISO dates and friendly offsets from the supplied context', () => {
    const cases = [
      ['2027-01-02', '2027-01-02'],
      ['today', '2026-10-03'],
      ['tomorrow', '2026-10-04'],
      ['yesterday', '2026-10-02'],
      ['+0d', '2026-10-03'],
      ['+4d', '2026-10-07'],
      ['+2w', '2026-10-17'],
      ['in 1 day', '2026-10-04'],
      ['in 10 days', '2026-10-13'],
      ['in 1 week', '2026-10-10'],
      ['in 3 weeks', '2026-10-24'],
    ] as const;
    for (const [input, date] of cases) {
      expect(parseTaskDate(input, context)).toEqual({ ok: true, date, time: null });
      expect(parseTaskDate(` @ ${input.toUpperCase()}  `, context)).toEqual({ ok: true, date, time: null });
      expect(parseTaskDate(`@${input} 09:05`, context)).toEqual({ ok: true, date, time: '09:05' });
    }
    expect(parseTaskDate(' IN   2   WEEKS ', context)).toEqual({ ok: true, date: '2026-10-17', time: null });
  });

  test('bare weekdays include the context day but next weekdays are strictly future', () => {
    const cases = [
      ['Saturday', '2026-10-03', '2026-10-10'],
      ['Sunday', '2026-10-04', '2026-10-04'],
      ['Monday', '2026-10-05', '2026-10-05'],
      ['Tuesday', '2026-10-06', '2026-10-06'],
      ['Wednesday', '2026-10-07', '2026-10-07'],
      ['Thursday', '2026-10-08', '2026-10-08'],
      ['Friday', '2026-10-09', '2026-10-09'],
    ] as const;
    for (const [weekday, bare, next] of cases) {
      expect(parseTaskDate(weekday, context)).toEqual({ ok: true, date: bare, time: null });
      expect(parseTaskDate(weekday.slice(0, 3), context)).toEqual({ ok: true, date: bare, time: null });
      expect(parseTaskDate(`next ${weekday}`, context)).toEqual({ ok: true, date: next, time: null });
      expect(parseTaskDate(`@next ${weekday.slice(0, 3)} 23:59`, context)).toEqual({ ok: true, date: next, time: '23:59' });
    }
    expect(parseTaskDate('Friday', '2026-12-31')).toEqual({ ok: true, date: '2027-01-01', time: null });
    expect(parseTaskDate('next Thursday', '2026-12-31')).toEqual({ ok: true, date: '2027-01-07', time: null });
  });

  test('crosses month, year and Gregorian leap-day boundaries without overflow', () => {
    const cases = [
      ['tomorrow', '2026-01-31', '2026-02-01'],
      ['yesterday', '2026-03-01', '2026-02-28'],
      ['tomorrow', '2026-12-31', '2027-01-01'],
      ['yesterday', '2027-01-01', '2026-12-31'],
      ['+1d', '2024-02-28', '2024-02-29'],
      ['+1d', '2024-02-29', '2024-03-01'],
      ['yesterday', '2024-03-01', '2024-02-29'],
      ['+1w', '2024-02-23', '2024-03-01'],
      ['tomorrow', '1900-02-28', '1900-03-01'],
      ['tomorrow', '2000-02-28', '2000-02-29'],
      ['tomorrow', '2100-02-28', '2100-03-01'],
      ['tomorrow', '2400-02-28', '2400-02-29'],
    ] as const;
    for (const [input, from, date] of cases) expect(parseTaskDate(input, from)).toEqual({ ok: true, date, time: null });
  });

  test('keeps civil dates and time labels through time-zone and daylight-saving boundaries', () => {
    const cases = [
      ['tomorrow 02:30', '2026-03-07', '2026-03-08', '02:30'],
      ['tomorrow 01:30', '2026-10-31', '2026-11-01', '01:30'],
      ['+1d 00:00', '2011-12-29', '2011-12-30', '00:00'],
      ['yesterday 23:59', '2011-12-31', '2011-12-30', '23:59'],
      ['today 00:00', '2026-01-01', '2026-01-01', '00:00'],
      ['today 23:59', '2026-12-31', '2026-12-31', '23:59'],
    ] as const;
    for (const [input, from, date, time] of cases) expect(parseTaskDate(input, from)).toEqual({ ok: true, date, time });
  });

  test('accepts the full supported year range without reinterpreting short years', () => {
    for (const date of ['0001-01-01', '0099-12-31', '0100-01-01', '2000-02-29', '9999-12-31']) {
      expect(parseTaskDate(date, context)).toEqual({ ok: true, date, time: null });
      expect(parseTaskDate('today', date)).toEqual({ ok: true, date, time: null });
    }
    expect(parseTaskDate('+3652058d', '0001-01-01')).toEqual({ ok: true, date: '9999-12-31', time: null });
    expect(parseTaskDate('Monday', '0001-01-01')).toEqual({ ok: true, date: '0001-01-01', time: null });
    expect(parseTaskDate('next Monday', '0001-01-01')).toEqual({ ok: true, date: '0001-01-08', time: null });
    expect(parseTaskDate('tomorrow', '0099-12-31')).toEqual({ ok: true, date: '0100-01-01', time: null });
  });

  test('rejects impossible dates, out-of-range offsets and unrecognised forms', () => {
    for (const input of [
      '0000-01-01', '10000-01-01', '2026-00-01', '2026-13-01', '2026-01-00',
      '2026-01-32', '2026-04-31', '2026-02-29', '1900-02-29', '2100-02-29',
      '2026-1-01', '26-01-01', '10/03/2026', 'next someday', 'Friday after next',
      '+1.5d', '-1d', '+1m', 'in -2 days', 'in 1.5 weeks', 'today extra',
      '+999999999999999999999999w', '+3652059d',
    ]) expect(parseTaskDate(input, context).ok).toBe(false);
    expect(parseTaskDate('yesterday', '0001-01-01').ok).toBe(false);
    expect(parseTaskDate('tomorrow', '9999-12-31').ok).toBe(false);
    expect(parseTaskDate('next Friday', '9999-12-31').ok).toBe(false);
  });

  test('rejects orphan times and requires a strict local HH:MM without zones or seconds', () => {
    for (const input of ['12:30', '@12:30', '00:00', '@ 23:59']) expect(parseTaskDate(input, context).ok).toBe(false);
    for (const time of ['9:30', '09:3', '24:00', '12:60', '-1:00', '001:00', '09:30:00', '09:30Z', '09:30+01:00', '12:30pm', '12:30 13:30']) {
      expect(parseTaskDate(`today ${time}`, context).ok).toBe(false);
      expect(parseTaskDate(`@2026-10-03 ${time}`, context).ok).toBe(false);
    }
  });

  test('rejects invalid context dates instead of falling back to device today', () => {
    for (const invalid of ['', 'today', '2026-02-29', '0000-01-01', '2026-13-01', '2026-10-03T00:00:00Z']) {
      expect(parseTaskDate('today', invalid).ok).toBe(false);
      expect(parseTaskDate('+1w', invalid).ok).toBe(false);
      expect(parseTaskDate('Monday', invalid).ok).toBe(false);
    }
  });
});
