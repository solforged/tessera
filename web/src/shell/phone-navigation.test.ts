import { describe, expect, test } from 'bun:test';
import type { HistoryEntry, PaneSession } from './contract';
import { activatePhoneTab, adoptPhoneTab, collapsePhoneLanding, passiveHistory, popPhoneTab, pushPhoneEntry } from './phone-navigation';

const today: HistoryEntry = { target: { kind: 'page', pageId: 'today' }, view: { zoom: null, caret: null, scroll: null, folds: null, showArchived: false } };
const library: HistoryEntry = { target: { kind: 'library' }, view: { scroll: 0 } };
const directory: HistoryEntry = { target: { kind: 'directory' }, view: { scroll: 140 } };
const reader: HistoryEntry = { target: { kind: 'reader', sourceId: 'meditations' }, view: { snapshotId: 'edition', ordinal: 72, offset: -12 } };

describe('phone tab histories', () => {
  test('parks the full stack and reader position across another tab and JSON persistence', () => {
    const start: PaneSession = { tab: 'library', tabs: {}, entries: [library, reader], index: 1, generation: 4 };
    const away = activatePhoneTab(start, 'today', today);
    expect(away.entries).toEqual([today]);
    const restored = activatePhoneTab(JSON.parse(JSON.stringify(away)), 'library', library);
    expect(restored.entries).toEqual([library, reader]);
    expect(restored.index).toBe(1);
    expect(restored.generation).toBe(6);
    expect(restored.tabs?.today?.entries).toEqual([today]);
    expect(restored.tabs?.library).toBeUndefined();
  });

  test('keeps Index and pushed pages in the originating tab', () => {
    const start: PaneSession = { tab: 'today', entries: [today, directory], index: 1, generation: 2 };
    const away = activatePhoneTab(start, 'library', library);
    const back = activatePhoneTab(away, 'today', today);
    expect(back.tab).toBe('today');
    expect(back.entries[back.index]).toEqual(directory);
  });

  test('reselection pops to root, removes Forward and leaves other tabs intact', () => {
    const start: PaneSession = { tab: 'today', tabs: { library: { entries: [library, reader], index: 1 } }, entries: [today, directory], index: 1, generation: 5 };
    const popped = popPhoneTab(start);
    expect(popped.entries).toEqual([today]);
    expect(popped.index).toBe(0);
    expect(popped.tabs).toEqual(start.tabs);
    expect(popPhoneTab(popped)).toBe(popped);
  });

  test('adopts legacy sessions with a root beneath a restored reader', () => {
    const legacy: PaneSession = { entries: [reader], index: 0, generation: 1 };
    const adopted = adoptPhoneTab(legacy, 'library', library);
    expect(adopted.entries).toEqual([library, reader]);
    expect(adopted.index).toBe(1);
    expect(adoptPhoneTab(adopted, 'today', today)).toBe(adopted);
    expect(adoptPhoneTab({ ...legacy, entries: [today, directory], index: 1 }, 'today', today).entries).toEqual([today, directory]);
    expect(adoptPhoneTab({ entries: [], index: -1, generation: 0 }, 'today', today).index).toBe(0);
  });

  test('reopening the current phone target replaces instead of duplicating its stack entry', () => {
    const start: PaneSession = { tab: 'today', tabs: {}, entries: [today], index: 0, generation: 1 };
    const reopened = pushPhoneEntry(start, { ...today, view: { ...today.view, edit: true } });
    expect(reopened.entries).toHaveLength(1);
    expect(reopened.index).toBe(0);
    expect(reopened.entries[0]?.view).toMatchObject({ edit: true });
    expect(reopened.generation).toBe(2);
    expect(reopened.tab).toBe('today');
    const pendingToday = adoptPhoneTab({ entries: [], index: -1, generation: 0 }, 'today', today);
    expect(pushPhoneEntry(pendingToday, today).index).toBe(0);

    const zoomed: HistoryEntry = { target: { kind: 'page', pageId: 'today', blockId: 'plan' }, view: { ...today.view, zoom: 'plan' } };
    expect(pushPhoneEntry(reopened, zoomed).entries).toHaveLength(2);
    expect(pushPhoneEntry(reopened, directory).entries).toHaveLength(2);
    expect(pushPhoneEntry({ ...start, entries: [today, directory], index: 0 }, today).entries).toEqual([today, directory]);
  });

  test('collapses a saved landing-only stack to its current view on load', () => {
    const current: HistoryEntry = { ...today, view: { ...today.view, folds: ['plan'] } };
    const restored = collapsePhoneLanding({ entries: [today, current], index: 1 }, 'today');
    expect(restored).toEqual({ entries: [current], index: 0 });
    const pushed = { entries: [today, directory, today], index: 2 };
    expect(collapsePhoneLanding(pushed, 'today')).toBe(pushed);
    const zoomed: HistoryEntry = { ...today, view: { ...today.view, zoom: 'plan' } };
    const differentZoom = { entries: [today, zoomed], index: 1 };
    expect(collapsePhoneLanding(differentZoom, 'today')).toBe(differentZoom);
    const libraryStack = { entries: [library, library], index: 1 };
    expect(collapsePhoneLanding(libraryStack, 'library')).toEqual({ entries: [library], index: 0 });
    const readerStack = { entries: [reader, reader], index: 1 };
    expect(collapsePhoneLanding(readerStack, 'library')).toBe(readerStack);
  });

  test('passive activation never replays an explicit editing request', () => {
    const editing: HistoryEntry = { ...today, view: { ...today.view, edit: true } };
    const session: PaneSession = { entries: [editing], index: 0, generation: 1 };
    expect(passiveHistory(session).entries[0]?.view).toMatchObject({ edit: false });
    expect(session.entries[0]?.view).toMatchObject({ edit: true });
  });
});
