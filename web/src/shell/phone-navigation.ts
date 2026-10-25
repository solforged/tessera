import type { HistoryEntry, PaneHistory, PaneSession, PhoneTab } from './contract';
import { paneTargetIdentity } from '../ui/pane-motion';

export const phoneTabs: readonly PhoneTab[] = ['today', 'agenda', 'review', 'library'];

/** Navigation identity also distinguishes an outline's zoom and journal ledger. */
function samePhonePlace(left: HistoryEntry, right: HistoryEntry): boolean {
  if (paneTargetIdentity(left.target) !== paneTargetIdentity(right.target)) return false;
  if (left.target.kind === 'page' && right.target.kind === 'page') {
    return ('zoom' in left.view ? left.view.zoom : null) === ('zoom' in right.view ? right.view.zoom : null) && left.target.journalPeriod === right.target.journalPeriod;
  }
  return true;
}

/** Reopening the current place replaces its one-shot request without adding Back. */
export function pushPhoneEntry(session: PaneSession, entry: HistoryEntry): PaneSession {
  const current = session.entries[session.index];
  if (current && samePhonePlace(current, entry)) {
    const entries = [...session.entries];
    entries[session.index] = entry;
    return { ...session, entries, generation: session.generation + 1 };
  }
  return { ...session, entries: [...session.entries.slice(0, session.index + 1), entry], index: session.index + 1, generation: session.generation + 1 };
}

/** Repair saved landing-only stacks while retaining the current view snapshot. */
export function collapsePhoneLanding(history: PaneHistory, tab: PhoneTab): PaneHistory {
  const root = history.entries[0];
  if (!root || history.entries.length < 2) return history;
  const landing = tab === 'today' ? root.target.kind === 'page' && 'zoom' in root.view && !root.view.zoom && !root.target.journalPeriod : root.target.kind === tab;
  if (!landing || !history.entries.every(entry => samePhonePlace(root, entry))) return history;
  return { entries: [history.entries[history.index]!], index: 0 };
}

/** Adopt an old single-pane session without losing its current page or Back path. */
export function adoptPhoneTab(session: PaneSession, tab: PhoneTab, root: HistoryEntry): PaneSession {
  if (session.tab) return session;
  const atRoot = (entry: HistoryEntry) => entry.target.kind === root.target.kind && (entry.target.kind !== 'page' || root.target.kind === 'page' && entry.target.pageId === root.target.pageId && 'zoom' in entry.view && !entry.view.zoom);
  let start = session.index;
  while (start >= 0 && !atRoot(session.entries[start]!)) start--;
  const entries = start >= 0 ? session.entries.slice(start) : [root, ...session.entries];
  return { ...session, tab, tabs: {}, entries, index: start >= 0 ? session.index - start : session.index + 1 };
}

/** Only inactive stacks are parked; active view reports keep updating the live stack. */
export function activatePhoneTab(session: PaneSession, tab: PhoneTab, root: HistoryEntry): PaneSession {
  if (session.tab === tab) return session;
  const tabs = { ...session.tabs };
  if (session.tab) tabs[session.tab] = { entries: session.entries, index: session.index };
  const next = tabs[tab] ?? { entries: [root], index: 0 };
  delete tabs[tab];
  return { ...session, ...next, tab, tabs, generation: session.generation + 1 };
}

/** Reselecting discards the pushed path, so Forward cannot resurrect it. */
export function popPhoneTab(session: PaneSession): PaneSession {
  if (session.index <= 0) return session;
  return { ...session, entries: [session.entries[0]!], index: 0, generation: session.generation + 1 };
}

/** An explicit editing request is one-shot, never replayed by Back or tab activation. */
export function passiveHistory(session: PaneSession): PaneSession {
  return { ...session, entries: session.entries.map(entry => 'zoom' in entry.view && entry.view.edit ? { ...entry, view: { ...entry.view, edit: false } } : entry) };
}
