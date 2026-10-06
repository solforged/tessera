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

  test('bare weekdays include the context day and next weekdays use the following Monday-start week', () => {
    const cases = [
      ['Saturday', '2026-10-03', '2026-10-10'],
      ['Sunday', '2026-10-04', '2026-10-11'],
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

  test('resolves next weekdays at both ends of a Monday-start week', () => {
    const cases = [
      ['next mon', '2026-10-05', '2026-10-12'],
      ['next mon', '2026-10-11', '2026-10-12'],
      ['next fri', '2026-10-05', '2026-10-16'],
      ['next sun', '2026-10-05', '2026-10-18'],
      ['next sun', '2026-10-11', '2026-10-18'],
    ] as const;
    for (const [input, from, date] of cases) expect(parseTaskDate(input, from)).toEqual({ ok: true, date, time: null });
    expect(parseTaskDate('mon', '2026-10-05')).toEqual({ ok: true, date: '2026-10-05', time: null });
    expect(parseTaskDate('sun', '2026-10-11')).toEqual({ ok: true, date: '2026-10-11', time: null });
  });

  test('accepts full month names and abbreviations in either order with an optional year', () => {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    for (const [index, month] of months.entries()) {
      const date = `2027-${String(index + 1).padStart(2, '0')}-12`;
      for (const name of [month, month.slice(0, 3), ...(month === 'September' ? ['SePt'] : [])]) {
        for (const input of [`${name} 12`, `12 ${name}`]) {
          expect(parseTaskDate(input, '2027-01-01')).toEqual({ ok: true, date, time: null });
          expect(parseTaskDate(`@ ${input} 2027`, context)).toEqual({ ok: true, date, time: null });
          expect(parseTaskDate(`@${input} 2027 3pm`, context)).toEqual({ ok: true, date, time: '15:00' });
        }
      }
    }
    for (const input of ['oct 12', '12 oct', 'OCTOBER 12', '12 October']) {
      expect(parseTaskDate(input, context)).toEqual({ ok: true, date: '2026-10-12', time: null });
      expect(parseTaskDate(input, '2026-10-12')).toEqual({ ok: true, date: '2026-10-12', time: null });
      expect(parseTaskDate(input, '2026-10-13')).toEqual({ ok: true, date: '2027-10-12', time: null });
    }
    expect(parseTaskDate('  12   OCTOBER  2027  ', context)).toEqual({ ok: true, date: '2027-10-12', time: null });
    expect(parseTaskDate('oct 1 2025', context)).toEqual({ ok: true, date: '2025-10-01', time: null });
  });

  test('finds the next valid named day across year and leap-year boundaries without rolling impossible dates', () => {
    const cases = [
      ['jan 3', '2026-12-28', '2027-01-03'],
      ['3 january', '2026-01-03', '2026-01-03'],
      ['jan 3', '2026-01-04', '2027-01-03'],
      ['feb 29', '2028-02-28', '2028-02-29'],
      ['29 feb', '2028-02-29', '2028-02-29'],
      ['feb 29', '2028-03-01', '2032-02-29'],
      ['feb 29', '2026-01-01', '2028-02-29'],
      ['feb 29', '2096-03-01', '2104-02-29'],
      ['february 29 2000', context, '2000-02-29'],
      ['29 feb 2028', context, '2028-02-29'],
      ['dec 31', '9999-12-31', '9999-12-31'],
      ['jan 1 0001', context, '0001-01-01'],
    ] as const;
    for (const [input, from, date] of cases) expect(parseTaskDate(input, from)).toEqual({ ok: true, date, time: null });
    for (const input of ['feb 30', '30 feb 2028', 'feb 29 2027', '29 february 1900', 'feb 29 2100', 'apr 31', 'oct 0', 'oct 32', 'oct 12 0000', 'oct 12 10000', 'octo 12', '12 oct 27']) {
      expect(parseTaskDate(input, context).ok).toBe(false);
    }
    for (const input of ['jan 3', 'feb 29']) expect(parseTaskDate(input, '9999-12-31').ok).toBe(false);
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

  test('normalizes twelve-hour and one-digit-hour times, including times without a date', () => {
    const times = [
      ['9am', '09:00'], ['3pm', '15:00'], ['3:30pm', '15:30'],
      ['12pm', '12:00'], ['12am', '00:00'], ['12:30am', '00:30'],
      ['12:30pm', '12:30'], ['9:30', '09:30'], ['09:30', '09:30'],
      ['0:00', '00:00'], ['23:59', '23:59'],
    ] as const;
    const dates = [
      ['today', context], ['2027-01-02', '2027-01-02'], ['fri', '2026-10-09'],
      ['next fri', '2026-10-09'], ['+2d', '2026-10-05'], ['in 2 weeks', '2026-10-17'],
      ['oct 12', '2026-10-12'], ['12 october 2027', '2027-10-12'],
    ] as const;
    for (const [input, time] of times) {
      expect(parseTaskDate(input, context)).toEqual({ ok: true, date: context, time });
      expect(parseTaskDate(`@${input.toUpperCase()}`, context)).toEqual({ ok: true, date: context, time });
      for (const [form, date] of dates) expect(parseTaskDate(`${form} ${input}`, context)).toEqual({ ok: true, date, time });
    }
  });

  test('rejects malformed local times, zones, seconds and multiple times', () => {
    for (const time of ['09:3', '24:00', '12:60', '-1:00', '001:00', '09:30:00', '09:30Z', '09:30+01:00', '0am', '13pm', '3:60pm', '3:3pm', '12:30 13:30', '3 pm']) {
      expect(parseTaskDate(time, context).ok).toBe(false);
      expect(parseTaskDate(`today ${time}`, context).ok).toBe(false);
      expect(parseTaskDate(`@2026-10-03 ${time}`, context).ok).toBe(false);
    }
  });

  test('rejects invalid context dates instead of falling back to device today', () => {
    for (const invalid of ['', 'today', '2026-02-29', '0000-01-01', '2026-13-01', '2026-10-03T00:00:00Z']) {
      expect(parseTaskDate('today', invalid).ok).toBe(false);
      expect(parseTaskDate('+1w', invalid).ok).toBe(false);
      expect(parseTaskDate('Monday', invalid).ok).toBe(false);
      expect(parseTaskDate('oct 12', invalid).ok).toBe(false);
      expect(parseTaskDate('3pm', invalid).ok).toBe(false);
    }
  });
});
