import { describe, expect, test } from 'bun:test';
import { parseCardText } from './card-text';

describe('card text', () => {
  test('ordinary prose, fields, and shielded syntax do not create cards', () => {
    for (const text of [
      '', 'ordinary prose', 'Author:: Frank Herbert', 'Author::', 'x > y < z',
      String.raw`front\>>back`, String.raw`front\<<back`, String.raw`front\<>back`,
      String.raw`\{{c1::answer}}`, '`a >> b {{c1::answer}}`', '``a ` >> b {{c1::answer}}``',
      '[[id|a >> b {{c1::answer}}]]', '#[[a << b]]',
      '```txt\na >> b {{c1::answer}}\n```', '~~~\na <> b\n~~~',
      '`unfinished >> {{c1::answer}}', '[[unfinished >> {{c1::answer}}',
      '```\nunfinished >> {{c1::answer}}', '~~~\nunfinished >> {{c1::answer}}',
    ]) expect(parseCardText(text)).toEqual({ cards: [], problems: [] });
  });

  test('directions produce stable roles and trimmed sides without requiring spaces', () => {
    const cases = [
      [' front>>back ', [{ key: 'forward', kind: 'forward', front: 'front', back: 'back' }]],
      ['front<<back', [{ key: 'reverse', kind: 'reverse', front: 'back', back: 'front' }]],
      ['front<>back', [
        { key: 'forward', kind: 'forward', front: 'front', back: 'back' },
        { key: 'reverse', kind: 'reverse', front: 'back', back: 'front' },
      ]],
      ['🧠 café>>答🙂', [{ key: 'forward', kind: 'forward', front: '🧠 café', back: '答🙂' }]],
    ] as const;
    for (const [text, cards] of cases) expect(parseCardText(text)).toEqual({ cards: [...cards], problems: [] });
    expect(parseCardText('updated question<>updated answer').cards.map(card => [card.key, card.kind])).toEqual([
      ['forward', 'forward'], ['reverse', 'reverse'],
    ]);
    expect(parseCardText('updated question<<updated answer').cards).toEqual([
      { key: 'reverse', kind: 'reverse', front: 'updated answer', back: 'updated question' },
    ]);
  });

  test('syntax escapes render literally, preserve unknown escapes, and respect backslash parity', () => {
    const cases: [string, string, string][] = [
      [String.raw`a\>>b>>c`, 'a>>b', 'c'],
      [String.raw`a\<>b>>c`, 'a<>b', 'c'],
      [String.raw`a>\>b>>c`, 'a>>b', 'c'],
      [String.raw`a\\>>b`, 'a\\', 'b'],
      [String.raw`a\\\>>b>>c`, String.raw`a\>>b`, 'c'],
      [String.raw`C:\notes>>a\::b`, String.raw`C:\notes`, 'a::b'],
      [String.raw`a\{{c1::x}}>>b`, 'a{{c1::x}}', 'b'],
    ];
    for (const [text, front, back] of cases) expect(parseCardText(text)).toEqual({
      cards: [{ key: 'forward', kind: 'forward', front, back }], problems: [],
    });
    expect(parseCardText(String.raw`a\>>>b`)).toEqual({ cards: [], problems: [] });
  });

  test('code and references keep literal markup and cannot split cards or clozes', () => {
    const cases: [string, string, string][] = [
      ['`a >> b`>>[[id|x << y]]', '`a >> b`', '[[id|x << y]]'],
      ['``a ` >> b``>>answer', '``a ` >> b``', 'answer'],
      ['```a >> b```>>answer', '```a >> b```', 'answer'],
      ['question>>[[id|{{c1::not a cloze}}]]', 'question', '[[id|{{c1::not a cloze}}]]'],
      ['```txt\na >> b\n```\nquestion>>answer', '```txt\na >> b\n```\nquestion', 'answer'],
      ['   ~~~~\na >> b\n~~~\nstill << code\n   ~~~~\nQ>>A', '~~~~\na >> b\n~~~\nstill << code\n   ~~~~\nQ', 'A'],
      ['```\na >> b\n``` not a closer\nc << d\n```\nQ>>A', '```\na >> b\n``` not a closer\nc << d\n```\nQ', 'A'],
      ['Q>>```x```' + String.raw` \>>`, 'Q', '```x``` >>'],
      ['Q>>`' + String.raw`x\>>y` + '`', 'Q', '`' + String.raw`x\>>y` + '`'],
    ];
    for (const [text, front, back] of cases) expect(parseCardText(text)).toEqual({
      cards: [{ key: 'forward', kind: 'forward', front, back }], problems: [],
    });
    expect(parseCardText('{{c1::`a::b >> {{c2::x}}`::code}}')).toEqual({
      cards: [{ key: 'cloze:c1', kind: 'cloze', front: 'code', back: '`a::b >> {{c2::x}}`' }], problems: [],
    });
    expect(parseCardText('{{c1::[[id|a::b {{c2::x}}]]}}')).toEqual({
      cards: [{ key: 'cloze:c1', kind: 'cloze', front: '[…]', back: '[[id|a::b {{c2::x}}]]' }], problems: [],
    });
  });

  test('numbered clozes group repeated IDs and mask only their own answers', () => {
    expect(parseCardText('🧠 {{c1::café::飲}} + {{c2::答🙂}}')).toEqual({
      cards: [
        { key: 'cloze:c1', kind: 'cloze', front: '🧠 飲 + 答🙂', back: '🧠 café + 答🙂' },
        { key: 'cloze:c2', kind: 'cloze', front: '🧠 café + […]', back: '🧠 café + 答🙂' },
      ], problems: [],
    });
    expect(parseCardText('{{c1::```x``` ' + String.raw`\>>` + '::hint}}')).toEqual({
      cards: [{ key: 'cloze:c1', kind: 'cloze', front: 'hint', back: '```x``` >>' }], problems: [],
    });
    expect(parseCardText('A {{c1::one}} B {{c2::two::number}} C {{c01::uno::hint}}.')).toEqual({
      cards: [
        { key: 'cloze:c1', kind: 'cloze', front: 'A […] B two C hint.', back: 'A one B two C uno.' },
        { key: 'cloze:c2', kind: 'cloze', front: 'A one B number C uno.', back: 'A one B two C uno.' },
      ], problems: [],
    });
    expect(parseCardText(String.raw`{{c1::a\::b\}}c::h\::i}}`)).toEqual({
      cards: [{ key: 'cloze:c1', kind: 'cloze', front: 'h::i', back: 'a::b}}c' }], problems: [],
    });
    expect(parseCardText('{{c1::a>>b}}')).toEqual({
      cards: [{ key: 'cloze:c1', kind: 'cloze', front: '[…]', back: 'a>>b' }], problems: [],
    });
  });

  test('authored IDs survive wording edits, insertion, reordering, and arbitrary decimal size', () => {
    const original = parseCardText('{{c8::eight}} {{c2::two}}').cards;
    const changed = parseCardText('{{c2::deux}} {{c7::new}} {{c8::huit}}').cards;
    expect(original.map(card => card.key)).toEqual(['cloze:c8', 'cloze:c2']);
    expect(changed.map(card => card.key)).toEqual(['cloze:c2', 'cloze:c7', 'cloze:c8']);
    expect(changed.find(card => card.key === original[0]!.key)?.front).toBe('deux new […]');
    expect(changed.find(card => card.key === original[1]!.key)?.front).toBe('[…] new huit');
    const id = '900719925474099312345678901234567890';
    expect(parseCardText(`{{c${id}::answer}} {{c0${id}::again}}`).cards).toEqual([
      { key: `cloze:c${id}`, kind: 'cloze', front: '[…] […]', back: 'answer again' },
    ]);
  });

  test('malformed clozes suppress all units rather than returning partial groups', () => {
    for (const text of [
      '{{c0::answer}}', '{{c000::answer}}', '{{c-1::answer}}', '{{c1.5::answer}}', '{{c١::answer}}',
      '{{c::answer}}', '{{C1::answer}}', '{{c1 answer}}', '{{answer}}', '{{c1::}}', '{{c1:: \n }}',
      '{{c1::answer::}}', '{{c1::answer::hint::extra}}', '{{c1::answer}', '{{c1::answer',
      '{{c1::outer {{c2::inner}}}}', '{{c1::`unclosed}}', '{{c1::[[unclosed}}',
    ]) {
      const parsed = parseCardText(text);
      expect(parsed.cards).toEqual([]);
      expect(parsed.problems.map(({ start, end }) => ({ start, end }))).toEqual([{ start: 0, end: text.length }]);
      expect(parseCardText('{{c9::valid}} ' + text).cards).toEqual([]);
    }
  });

  test('mixed, overlapping, and empty operator cards have actionable ranges', () => {
    const ambiguous: [string, number, number][] = [
      ['a >> b << c', 2, 9], ['a >> b >> c', 2, 9],
      ['a>>>b', 1, 4], ['a<>>b', 1, 4], ['a<<<b', 1, 4],
    ];
    for (const [text, start, end] of ambiguous) {
      const parsed = parseCardText(text);
      expect(parsed.cards).toEqual([]);
      expect(parsed.problems.map(problem => [problem.start, problem.end])).toEqual([[start, end]]);
    }
    for (const text of ['>>answer', 'question<<', ' \n <> \t']) {
      const parsed = parseCardText(text);
      expect(parsed.cards).toEqual([]);
      expect(parsed.problems.map(({ start, end }) => text.slice(start, end))).toEqual([text.match(/>>|<<|<>/)![0]]);
    }
    for (const text of ['{{c1::answer}} >> back', 'front << {{c2::answer}}', '{{c0::bad}} <> back']) {
      const parsed = parseCardText(text);
      expect(parsed.cards).toEqual([]);
      expect(parsed.problems.some(({ start, end }) => end === text.length && start === (text.startsWith('{{') ? 0 : 6))).toBe(true);
    }
  });

  test('Unicode diagnostics use UTF-16 offsets and trimming matches Rust White_Space', () => {
    expect(parseCardText('🧠 café {{c0::答}}').problems.map(({ start, end }) => [start, end])).toEqual([[8, 17]]);
    expect(parseCardText('🧠 >> α << β').problems.map(({ start, end }) => [start, end])).toEqual([[3, 10]]);
    expect(parseCardText('\u0085Q\u2003>>\u00a0A\u0085').cards).toEqual([
      { key: 'forward', kind: 'forward', front: 'Q', back: 'A' },
    ]);
    expect(parseCardText('\u0085>>A').cards).toEqual([]);
    expect(parseCardText('\ufeff>>A').cards).toEqual([
      { key: 'forward', kind: 'forward', front: '\ufeff', back: 'A' },
    ]);
  });
});
