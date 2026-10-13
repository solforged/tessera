import { describe, expect, test } from 'bun:test';
import type { Block, NameMatch } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { chooseName, completeNames, foldName, plainText, referenceValue, resolveName, resolvedReferenceText } from './names';

const page = (id: string, text: string): Block => ({ id, text, kind: 'page', parent_id: null, page_id: id, heading: null, archived: false, kept_copy: null, revision: 1, created_at: 0, updated_at: 0 });
const match: NameMatch = { page: page('target', 'Cicero'), alias: 'Tully' };

describe('page names', () => {
  test('folds diacritics, case, apostrophes, punctuation and whitespace without transliterating scripts', () => {
    expect(foldName('  CÍCERO\t Marcus  ')).toBe('cicero marcus');
    expect(foldName('  张三  ')).toBe('张三');
    expect(foldName('J.M. Keynes')).toBe('j m keynes');
    expect(foldName('Merleau-Ponty')).toBe('merleau ponty');
    expect(foldName('Flann O’Brien')).toBe(foldName("flann obrien"));
  });

  test('shares folded resolutions until the notebook change sequence advances', async () => {
    let sequence = 0;
    const requests: string[] = [];
    const notebook = { changeSequence: () => sequence, api: { resolveName: async (name: string) => { requests.push(name); return [match]; } } } as unknown as NotebookClient;
    const first = resolveName(notebook, 'Túlly');
    expect(resolveName(notebook, '  TULLY ')).toBe(first);
    expect(await first).toEqual([match]);
    sequence++;
    expect(await resolveName(notebook, 'tully')).toEqual([match]);
    expect(requests).toEqual(['Túlly', 'tully']);
  });

  test('failed lookups can be retried within the same sequence', async () => {
    let calls = 0;
    const notebook = { changeSequence: () => 0, api: { resolveName: async () => { if (++calls === 1) throw new Error('Offline'); return [match]; } } } as unknown as NotebookClient;
    await expect(resolveName(notebook, 'Tully')).rejects.toThrow('Offline');
    expect(await resolveName(notebook, 'Tully')).toEqual([match]);
    expect(calls).toBe(2);
  });

  test('alias completion keeps allowed identities and never offers duplicate creation for an exact alias', async () => {
    const person = page('person', 'Ibn Khaldun'), source = page('source', 'ʿAbd al-Raḥmān');
    const alias = { page: person, alias: 'ʿAbd al-Raḥmān' };
    const notebook = { changeSequence: () => 0, roots: () => [person, source], api: {
      resolveName: async () => [alias, { page: source, alias: null }],
      complete: async () => [{ ...source, alias: null }, { ...person, alias: alias.alias }],
    } } as unknown as NotebookClient;
    expect(await completeNames(notebook, 'ʿabd al-rahman', [person])).toEqual({ rows: [alias], canCreate: false });
    expect(await completeNames(notebook, 'ʿabd al-rahman', [])).toEqual({ rows: [], canCreate: true });
  });

  test('nested position and quote labels render holder names and bound reference cycles', () => {
    const personId = '01ARZ3NDEKTSV4RRFFQ69G5FAV', positionId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const blocks = new Map([[personId, page(personId, 'Plato')], [positionId, page(positionId, `[[${personId}|Plato]]`)]]);
    const lookup = (id: string) => () => blocks.get(id) ?? null;
    expect(plainText(`See [[${positionId}]]`, lookup)).toBe('See Plato');
    expect(plainText(`((${positionId}))`, lookup)).toBe('“Plato”');
    blocks.set(personId, page(personId, `[[${positionId}]]`));
    blocks.set(positionId, page(positionId, `[[${personId}]]`));
    expect(plainText(`[[${positionId}]]`, lookup)).toBe('Circular reference');
  });

  test('bracketed creator names never masquerade as canonical IDs', () => {
    expect(referenceValue('[[Arnold J. Toynbee]]')).toEqual({ id: null, name: 'Arnold J. Toynbee' });
    expect(referenceValue('[[Arnold Toynbee|A. J. Toynbee]]')).toEqual({ id: null, name: 'A. J. Toynbee' });
    expect(referenceValue('[[01ARZ3NDEKTSV4RRFFQ69G5FAV|Toynbee]]')).toEqual({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'Toynbee' });
    expect(referenceValue('Plain name')).toEqual({ id: null, name: 'Plain name' });
  });

  test('choosing a candidate changes only the selected occurrence and preserves its wording', () => {
    const text = '[[Pliny]] and [[Pliny|the elder]]';
    const token = textTokens(text)[0]!;
    expect(resolvedReferenceText(text, token, 'elder')).toBe('[[elder|Pliny]] and [[Pliny|the elder]]');
    const other = textTokens(text).at(-1)!;
    expect(resolvedReferenceText(text, other, 'elder')).toBe('[[Pliny]] and [[elder|the elder]]');
    expect(resolvedReferenceText('[[Changed]]', token, 'elder')).toBeNull();
  });

  test('candidate selection acknowledges the text before adding the import spelling as an alias', async () => {
    let text = 'See [[Tully]]';
    const calls: string[] = [];
    const source = { ...page('source', text), kind: 'block', parent_id: 'owner', page_id: 'owner' } as Block;
    const doc = {
      status: () => 'ready', block: () => ({ ...source, text }),
      edit: (edit: { text: string }) => { text = edit.text; calls.push('edit'); return { ok: true, caret: null, created: [] }; },
      flush: async () => { calls.push('flush'); }, release: () => { calls.push('release'); },
    } as unknown as PageDocument;
    const notebook = { lookup: () => () => source, open: () => doc, api: { addAlias: async (id: string, name: string) => { calls.push(`alias:${id}:${name}`); return null; } } } as unknown as NotebookClient;
    await chooseName(notebook, source.id, textTokens(text).find(token => token.kind === 'reference')!, 'target');
    expect(text).toBe('See [[target|Tully]]');
    expect(calls).toEqual(['edit', 'flush', 'alias:target:Tully', 'release']);
  });

  test('new page choice uses the typed name and does not overwrite a concurrently edited token', async () => {
    const original = '[[Pliny]]';
    let text = original;
    const calls: string[] = [];
    const source = { ...page('source', text), kind: 'block', parent_id: 'owner', page_id: 'owner' } as Block;
    const doc = { status: () => 'ready', block: () => ({ ...source, text }), release: () => calls.push('release') } as unknown as PageDocument;
    const notebook = { lookup: () => () => source, open: () => doc, createPage: async (name: string) => { calls.push(`create:${name}`); text = 'Changed'; return 'new'; } } as unknown as NotebookClient;
    await chooseName(notebook, source.id, textTokens(original)[0]!);
    expect(text).toBe('Changed');
    expect(calls).toEqual(['create:Pliny', 'release']);
  });
});
