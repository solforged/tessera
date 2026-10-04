import { describe, expect, test } from 'bun:test';
import { nextClozeNumber, rankSlash, slashTokenAt } from './slash';

const atEnd = (text: string) => slashTokenAt(text, text.length);

describe('slash completion tokens', () => {
  test('accepts block starts and whitespace boundaries with an empty or word query', () => {
    expect(atEnd('/')).toEqual({ from: 0, to: 1, query: '' });
    expect(atEnd('/heading 1')).toEqual({ from: 0, to: 10, query: 'heading 1' });
    expect(atEnd('Read /due ')).toEqual({ from: 5, to: 10, query: 'due ' });
    expect(atEnd('Read\t/task')).toEqual({ from: 5, to: 10, query: 'task' });
    expect(atEnd('Read\n/task')).toEqual({ from: 5, to: 10, query: 'task' });
    expect(atEnd('/見出し １２')).toEqual({ from: 0, to: 7, query: '見出し １２' });
  });

  test('uses the last slash before the caret without falling back to an earlier valid token', () => {
    expect(atEnd('/task /due')).toEqual({ from: 6, to: 10, query: 'due' });
    for (const text of ['a/b', '//task', '/usr/bin', '/task a/b', String.raw`\ /task name\/due`, String.raw`\/task`]) {
      expect(atEnd(text)).toBeNull();
    }
    expect(atEnd('')).toBeNull();
    expect(slashTokenAt('/task', 0)).toBeNull();
    expect(slashTokenAt('/task', 6)).toBeNull();
  });

  test('ends the token at the caret and preserves later source text', () => {
    expect(slashTokenAt('Read /heading 1 then /task', 15)).toEqual({ from: 5, to: 15, query: 'heading 1' });
    expect(slashTokenAt('Read /task', 6)).toEqual({ from: 5, to: 6, query: '' });
    expect(slashTokenAt('Read /task', 5)).toBeNull();
  });

  test('requires words separated by single spaces with at most one trailing space', () => {
    for (const text of ['/ x', '/ ', '/foo  ', '/foo  bar', '/foo\tbar', '/foo\nbar', '/foo\rbar', '/clock-in', '/foo_bar', '/task!', '/😀']) {
      expect(atEnd(text)).toBeNull();
    }
    expect(atEnd('/clock in ')?.query).toBe('clock in ');
    expect(atEnd('/TASK2')?.query).toBe('TASK2');
  });

  test('caps the raw query at 24 characters including its trailing space', () => {
    expect(atEnd('/' + 'a'.repeat(24))).toEqual({ from: 0, to: 25, query: 'a'.repeat(24) });
    expect(atEnd('/' + 'a'.repeat(23) + ' ')?.query).toBe('a'.repeat(23) + ' ');
    expect(atEnd('/' + 'a'.repeat(25))).toBeNull();
    expect(atEnd('/' + 'a'.repeat(24) + ' ')).toBeNull();
  });

  test('leaves whole-block field shorthand ahead of completion but accepts card and cloze markup', () => {
    expect(atEnd('Author:: /task')).toBeNull();
    expect(slashTokenAt('Author:: /task then rest', 14)).toBeNull();
    for (const text of ['Front >> Back::suffix /task', '{{c1::answer}} /task']) {
      expect(atEnd(text)).toEqual({ from: text.lastIndexOf('/'), to: text.length, query: 'task' });
    }
  });

  test('protects complete and unfinished references and inline code', () => {
    for (const text of ['Read [[source| /task]]', 'Read [[ /task', 'Read #[[ /task', 'Read ` /task`', 'Read ` /task', 'Read ``literal ` /task']) {
      expect(atEnd(text)).toBeNull();
    }
    const reference = 'Read [[source| /task]]';
    expect(slashTokenAt(reference, reference.length - 2)).toBeNull();
    expect(atEnd('Read [[source| /task]] /due')?.query).toBe('due');
    expect(atEnd('Read ``literal ` code`` /task')?.query).toBe('task');
    expect(atEnd(String.raw`Read \[[literal /task`)?.query).toBe('task');
    expect(atEnd('Read \\`literal /task')?.query).toBe('task');
  });

  test('protects fenced code until a matching closing line', () => {
    for (const text of ['```\nplan /task', '~~~md\nplan /task', '  ````md\n```\nplan /task']) {
      expect(atEnd(text)).toBeNull();
    }
    expect(atEnd('```md\n/task\n```\n/due')?.query).toBe('due');
    expect(atEnd('~~~md\n/task\n~~~~\n/due')?.query).toBe('due');
  });
});

describe('slash command ranking', () => {
  test('keeps the original order and entry values for an empty or whitespace-only query', () => {
    const entries = [{ id: 'due', title: 'Due date', payload: 7 }, { id: 'task', title: 'Task', payload: 8 }];
    expect(rankSlash(entries, '')).toEqual(entries);
    expect(rankSlash(entries, ' \t\n ')).toEqual(entries);
    expect(rankSlash(entries, '')[0]).toBe(entries[0]);
  });

  test('orders title prefixes before word prefixes before substrings, with stable ties', () => {
    const entries = [
      { id: 'substring1', title: 'Ahead' },
      { id: 'word1', title: 'Section: Heading' },
      { id: 'title1', title: 'Heading 2' },
      { id: 'substring2', title: 'Go ahead' },
      { id: 'miss', title: 'Task' },
      { id: 'title2', title: 'Headings' },
      { id: 'word2', title: 'Large / Heading' },
    ];
    expect(rankSlash(entries, ' HeAd ').map(entry => entry.id)).toEqual(['title1', 'title2', 'word1', 'word2', 'substring1', 'substring2']);
    expect(entries.map(entry => entry.id)).toEqual(['substring1', 'word1', 'title1', 'substring2', 'miss', 'title2', 'word2']);
    expect(rankSlash(entries, 'missing')).toEqual([]);
  });

  test('matches every query word as a prefix of title or alias words, split on punctuation', () => {
    const entries = [
      { id: 'heading1', title: 'Heading 1' },
      { id: 'heading2', title: 'Heading 2' },
      { id: 'clock', title: 'Track time', aliases: ['Clock in / out'] },
      { id: 'partial', title: 'Clock settings' },
      { id: 'mixed', title: 'Start timer', aliases: ['Clock in'] },
    ];
    expect(rankSlash(entries, 'head 1').map(entry => entry.id)).toEqual(['heading1']);
    expect(rankSlash(entries, 'clock').map(entry => entry.id)).toEqual(['partial', 'clock', 'mixed']);
    expect(rankSlash(entries, 'cl ou').map(entry => entry.id)).toEqual(['clock']);
    expect(rankSlash(entries, 'timer clock').map(entry => entry.id)).toEqual(['mixed']);
    expect(rankSlash(entries, 'out clock').map(entry => entry.id)).toEqual(['clock']);
  });

  test('uses aliases in word-prefix and substring tiers, not the title-prefix tier', () => {
    const entries = [
      { id: 'aliasSubstring', title: 'Read', aliases: ['Upcoming deadlines'] },
      { id: 'aliasPrefix', title: 'Schedule', aliases: ['Deadline'] },
      { id: 'titlePrefix', title: 'Deadline date' },
    ];
    expect(rankSlash(entries, 'dead').map(entry => entry.id)).toEqual(['titlePrefix', 'aliasSubstring', 'aliasPrefix']);
    expect(rankSlash(entries, 'ead').map(entry => entry.id)).toEqual(['aliasSubstring', 'aliasPrefix', 'titlePrefix']);
  });

  test('matches Unicode title and alias words case-insensitively', () => {
    const entries = [{ id: 'one', title: '見出し １' }, { id: 'two', title: 'Other', aliases: ['Échéance'] }];
    expect(rankSlash(entries, '見 １').map(entry => entry.id)).toEqual(['one']);
    expect(rankSlash(entries, 'ÉCH').map(entry => entry.id)).toEqual(['two']);
  });
});

describe('next cloze number', () => {
  test('starts at one when no parsed cloze is present', () => {
    for (const text of ['', 'Plain text', 'Front >> Back', '{{c0::answer}}', '{{c1::}}', '{{c3::unfinished']) {
      expect(nextClozeNumber(text)).toBe(1);
    }
  });

  test('increments the highest parsed ID regardless of order, grouping, hints, or leading zeroes', () => {
    expect(nextClozeNumber('{{c1::answer}}')).toBe(2);
    expect(nextClozeNumber('{{c12::twelve}} {{c2::two}} {{c12::again::hint}}')).toBe(13);
    expect(nextClozeNumber('{{c0007::seven}} {{c1::one}}')).toBe(8);
  });

  test('ignores escaped clozes and clozes inside references or code', () => {
    const text = String.raw`\{{c90::escaped}} [[source|{{c80::reference}}]] ` + '`{{c70::code}}` {{c2::real}}';
    expect(nextClozeNumber(text)).toBe(3);
    expect(nextClozeNumber('```md\n{{c50::code}}\n```\n{{c4::real}}')).toBe(5);
    expect(nextClozeNumber('~~~md\n{{c50::code}}\n~~~\n{{c4::real}}')).toBe(5);
    expect(nextClozeNumber('[[source|{{c80::reference}}')).toBe(1);
    expect(nextClozeNumber('`{{c70::code}}')).toBe(1);
  });

  test('counts only outer parsed clozes when their answers contain protected markup', () => {
    expect(nextClozeNumber('{{c3::`{{c99::code}}`}}')).toBe(4);
    expect(nextClozeNumber('{{c3::[[id|{{c99::reference}}]]}}')).toBe(4);
  });

  test('does not count cards rejected by the parser for invalid or mixed syntax', () => {
    expect(nextClozeNumber('{{c3::valid}} {{c7::}}')).toBe(1);
    expect(nextClozeNumber('Front >> {{c3::answer}}')).toBe(1);
  });
});
