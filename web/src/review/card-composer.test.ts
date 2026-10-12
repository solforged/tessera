import { expect, test } from 'bun:test';
import { forwardCardText, parseCardText } from './card-text';

test('the composer produces one real forward card and preserves authored line breaks', () => {
  const text = forwardCardText('  What is\nremembered?  ', '  A source\nand its answer.  ');
  expect(parseCardText(text)).toEqual({
    cards: [{ key: 'forward', kind: 'forward', front: 'What is\nremembered?', back: 'A source\nand its answer.' }],
    problems: [],
  });
});

test('blank sides and extra card operators cannot persist through the composer', () => {
  for (const [front, back] of [
    ['', 'answer'], ['question', ' \n '], ['question <> reverse', 'answer'],
    ['question', 'answer >> extra'], ['{{c1::question}}', 'answer'],
    ['`unfinished', 'answer'], ['[[unfinished', 'answer'],
  ]) expect(() => forwardCardText(front!, back!)).toThrow();
});

test('intentional literal operators retain the parser shielding rules', () => {
  for (const answer of ['`left >> right`', String.raw`left \>> right`, '[[id|left <> right]]']) {
    const result = parseCardText(forwardCardText('What is the literal syntax?', answer));
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.kind).toBe('forward');
    expect(result.problems).toEqual([]);
  }
});
