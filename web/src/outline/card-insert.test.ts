import { expect, test } from 'bun:test';
import { insertCard, makeCloze } from './card-insert';
import { rankSlash } from './slash';

test('empty fronts come before the operator and existing text ends at the answer', () => {
  for (const [kind, operator] of [['forward', '>> '], ['reverse', '<< '], ['both', '<> '], ['multiline', '>>>'], ['list', '>>1.'], ['descriptor', ';; ']] as const) {
    expect(insertCard('', kind)).toEqual({ text: ` ${operator}`, caret: 0 });
    expect(insertCard(' \t ', kind)).toEqual({ text: ` ${operator}`, caret: 0 });
    const text = `Front ${operator}`;
    expect(insertCard('Front  ', kind)).toEqual({ text, caret: text.length });
  }
});

test('operators are not duplicated, including unfinished or mixed syntax', () => {
  for (const text of [' >> ', 'Front << ', 'Front >>>', 'Front >>1.', 'Front ;; ', 'A >> B <> C', '{{c1::gap}}']) {
    expect(insertCard(text, 'forward')).toEqual({ text, caret: text.length });
  }
  expect(insertCard('`>>`', 'forward').text).toBe('`>>` >> ');
  expect(insertCard('[[x|>>]]', 'forward').text).toBe('[[x|>>]] >> ');
  expect(insertCard(String.raw`Literal \>>`, 'forward').text).toBe(String.raw`Literal \>> >> `);
});

test('cloze insertion uses the next number at the requested caret', () => {
  const text = '{{c2::two}} end';
  expect(makeCloze('word', 0)).toEqual({ text: '{{c1::}}word', caret: 6 });
  expect(insertCard(text, 'cloze', 11)).toEqual({ text: '{{c2::two}}{{c3::}} end', caret: 17 });
});

test('cloze wrapping trims only the wrapped span and increments numbering', () => {
  const text = 'Scipio destroyed Carthage in 146 BC';
  expect(makeCloze('A  answer  B {{c7::seven}}', 1, 11)).toEqual({ text: 'A  {{c8::answer}}  B {{c7::seven}}', caret: 17 });
  expect(makeCloze(text, 28, text.length)).toEqual({ text: 'Scipio destroyed Carthage in {{c1::146 BC}}', caret: 43 });
});

test('cloze wrapping refuses operators, existing clozes, reference boundaries and code', () => {
  for (const [text, from, to] of [
    ['Q >> A', 0, 1], ['Q << ', 0, 1], ['{{c1::answer}}', 6, 9], ['{{c1::answer}}', 0, 14],
    ['before [[reference]] after', 4, 15], ['before [[reference]] after', 0, 26],
    ['before `code` after', 0, 19], ['before `code` after', 9, 10],
    ['```js\ncode\n```', 6, 10], ['~~~js\ncode\n~~~', 6, 10], ['[[unfinished', 12, 12],
    ['{{c1::unfinished', 8, 12], ['   ', 0, 3],
  ] as const) expect(makeCloze(text, from, to)).toHaveProperty('reason');
  expect(makeCloze('`code` plain', 7, 12)).toEqual({ text: '`code` {{c1::plain}}', caret: 20 });
});

test('Card remains first when all card kinds match the slash query', () => {
  const entries = ['Card', 'Reverse card', 'Reversible card', 'Multi-line card', 'List card', 'Descriptor card', 'Cloze'].map(title => ({ id: title, title, aliases: ['flashcard'] }));
  expect(rankSlash(entries, 'card')[0]?.title).toBe('Card');
  expect(rankSlash(entries, 'flashcard').map(entry => entry.title)).toEqual(entries.map(entry => entry.title));
});
