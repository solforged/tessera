import { describe, expect, test } from 'bun:test';
import { paneTargetIdentity } from './pane-motion';
import { typeQuery } from '../table/query';

describe('pane motion identity', () => {
  test('caret, zoom, popup requests and query edits do not replay navigation entry', () => {
    expect(paneTargetIdentity({ kind: 'page', pageId: 'note', blockId: 'row', caretId: 'row', caretOffset: 7 })).toBe(paneTargetIdentity({ kind: 'page', pageId: 'note' }));
    expect(paneTargetIdentity({ kind: 'library', tab: 'all', add: true })).toBe(paneTargetIdentity({ kind: 'library', tab: 'reading' }));
    expect(paneTargetIdentity({ kind: 'table', typeId: 'type', viewId: null, query: { ...typeQuery('type'), text: 'edited' } })).toBe(paneTargetIdentity({ kind: 'table', typeId: 'type', viewId: null, query: typeQuery('type') }));
  });
  test('destinations and remembered modes distinguish history entries', () => {
    expect(paneTargetIdentity({ kind: 'page', pageId: 'first' })).not.toBe(paneTargetIdentity({ kind: 'page', pageId: 'second' }));
    expect(paneTargetIdentity({ kind: 'agenda', mode: 'week' })).not.toBe(paneTargetIdentity({ kind: 'agenda', mode: 'tasks' }));
    expect(paneTargetIdentity({ kind: 'fields', typeId: 'first' })).not.toBe(paneTargetIdentity({ kind: 'fields', typeId: 'second' }));
  });
});
