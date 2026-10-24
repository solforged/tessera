import type { HistoryEntry, PaneSession, PhoneTab } from './contract';

export const phoneTabs: readonly PhoneTab[] = ['today', 'agenda', 'review', 'library'];

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
