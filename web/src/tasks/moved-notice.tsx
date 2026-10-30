import { showNotice } from '../ui/Notice';
import { movedWhen } from './reschedule';
import type { Rescheduled } from './reschedule';

/** How long a phone's move notice waits for Undo. */
const MOVED_NOTICE_MS = 4000;

/**
 * The phone's Undo for a move: a glass notice above the tab bar, `Moved to Friday` (`Moved 2 to today` for a group) with an
 * Undo that puts every moved task's plan back. One at a time, like every notice. `onUndone` runs once the plans are back, to
 * refetch the list; a refused undo (a task changed since) reports its reason in a notice of its own. Returns the function that
 * closes this notice.
 */
export function showMovedNotice(options: { moved: Rescheduled; date: string; today: string; onUndone?(): void }): () => void {
  const when = movedWhen(options.date, options.today);
  return showNotice({
    text: <>{options.moved.count === 1 ? 'Moved to ' : `Moved ${options.moved.count} to `}<b>{when}</b></>,
    duration: MOVED_NOTICE_MS,
    action: { label: 'Undo', run: async () => { await options.moved.undo(); options.onUndone?.(); } },
    onError: reason => { showNotice({ text: reason instanceof Error ? reason.message : String(reason) }); },
  });
}
