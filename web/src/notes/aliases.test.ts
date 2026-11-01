import { expect, test } from 'bun:test';
import type { PageDocument } from '../document/contract';
import { aliasEntries, aliasNames } from './aliases';

const aliases = '01K00000000000000000000001';

test('the ALSO line reads every top-level aliases entry, not only the first', () => {
  const children: Record<string, string[]> = { page: ['first', 'gloss', 'second', 'archived', 'body'], first: ['kl'], second: ['relative', 'blank'], archived: ['old'] };
  const text: Record<string, string> = {
    first: `[[${aliases}]]`, second: `[[${aliases}]]`, archived: `[[${aliases}]]`, gloss: '[[01K00000000000000000000002]]', body: 'Prose',
    kl: 'KL divergence', relative: ' Relative entropy ', blank: '  ', old: 'Archived alias',
  };
  const doc = {
    pageId: 'page', outline: { children: (id: string) => children[id] ?? [] },
    block: (id: string) => ({ text: text[id] ?? '', archived: id === 'archived' }),
  } as unknown as PageDocument;
  const entries = aliasEntries(doc, aliases);
  expect(entries).toEqual(['first', 'second']);
  expect(aliasNames(doc, entries)).toEqual(['KL divergence', 'Relative entropy']);
  expect(aliasNames(doc, ['second'])).toEqual(['Relative entropy']);
});
