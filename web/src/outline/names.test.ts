import { describe, expect, test } from 'bun:test';
import type { Block, NameMatch } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { chooseName, foldName, resolveName, resolvedReferenceText } from './names';

const page = (id: string, text: string): Block => ({ id, text, kind: 'page', parent_id: null, page_id: id, heading: null, archived: false, revision: 1, created_at: 0, updated_at: 0 });
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
