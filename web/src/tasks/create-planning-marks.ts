import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import { cachedMonthPlanningMarks, loadMonthPlanningMarks } from './planning-marks';
import type { PlanningMarks } from './planning-marks';

/** Keep calendar cells mounted and retain cached marks while their month refreshes. */
export function createMonthPlanningMarks(notebook: Accessor<NotebookClient>, initialDate: string) {
  const [month, setMonth] = createSignal(`${initialDate.slice(0, 7)}-01`);
  const [marks, setMarks] = createSignal<PlanningMarks>(cachedMonthPlanningMarks(notebook(), initialDate) ?? {});
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  createEffect(() => {
    const currentNotebook = notebook();
    const currentMonth = month();
    currentNotebook.changeSequence();
    let current = true;
    setMarks(cachedMonthPlanningMarks(currentNotebook, currentMonth) ?? {});
    setLoading(true);
    setError('');
    void loadMonthPlanningMarks(currentNotebook, currentMonth).then(result => {
      if (!current) return;
      setMarks(result);
      setLoading(false);
    }, reason => {
      if (!current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    onCleanup(() => { current = false; });
  });
  return { marks, loading, error, setMonth };
}
