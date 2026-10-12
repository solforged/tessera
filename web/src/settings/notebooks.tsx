import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { ApiError, api } from '../api/client';
import type { KnownNotebook, KnownNotebooks } from '../api/types';
import { EMBEDDED } from '../demo/mode';
import type { NotebookClient } from '../document/contract';
import type { CommandRegistry } from '../shell/contract';

// One service owns one notebook. Switching asks it to restart on another; every window on it then
// reloads, because its requests name the notebook it opened and the service refuses them.
const [known, setKnown] = createSignal<KnownNotebooks>();
const [opening, setOpening] = createSignal<string | null>(null);
export { known as knownNotebooks, opening as notebookOpening };

export const notebookLabel = (notebook: KnownNotebook) => notebook.default ? 'Default notebook' : notebook.name;

export async function loadNotebooks(): Promise<void> {
  if (!EMBEDDED) setKnown(await api.notebooks());
}

export async function forgetNotebook(path: string): Promise<void> {
  setKnown(await api.forgetNotebook(path));
}

/**
 * Give unsent edits a moment to save, switch the service, and reload once it serves the chosen
 * notebook. Edits still unsent stay in this notebook's local outbox until it opens again.
 */
export async function openNotebook(notebook: NotebookClient, path: string, create: boolean, label: string): Promise<void> {
  if (opening()) return;
  setOpening(label);
  try {
    const saving = Date.now() + 3000;
    while (notebook.saveState() !== 'saved' && Date.now() < saving) {
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, 100);
      await wait.promise;
    }
    const opened = await api.openNotebook(path, create);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, 250);
      await wait.promise;
      try {
        if ((await api.notebook()).path === opened.path) { location.reload(); return; }
      } catch (error) {
        // The service refuses this window's notebook once the new one serves; the client reloads.
        if (error instanceof ApiError && error.code === 'notebook_changed') return;
      }
    }
    throw new Error(`${label} did not open within 30 seconds. Reload the window to see which notebook is open.`);
  } catch (error) {
    setOpening(null);
    throw error;
  }
}

/** Palette commands to switch to each other notebook on the list. */
export function registerNotebookCommands(commands: CommandRegistry, notebook: NotebookClient, report: (error: unknown) => void): void {
  if (EMBEDDED) return;
  void loadNotebooks().catch(() => { /* The commands appear once Settings loads the list. */ });
  createEffect(() => {
    const others = (known()?.notebooks ?? []).filter(entry => !entry.current && entry.available);
    onCleanup(commands.register(others.map(entry => ({
      id: `shell.notebook.${entry.path}`, title: `Switch to notebook: ${notebookLabel(entry)}`, section: 'Navigation' as const,
      disabledReason: () => opening() ? 'A notebook is already opening' : undefined,
      run: () => { void openNotebook(notebook, entry.path, false, notebookLabel(entry)).catch(report); },
    }))));
  });
}

/** Covers the window between the switch and the reload, so nothing is edited in the notebook being left. */
export function NotebookOpening() {
  return <Show when={opening()}>{label => <div class="notebook-opening" role="status" aria-live="polite"><span>Opening {label()}…</span></div>}</Show>;
}

/** Names the open notebook beside Settings when it is not the default, so a test or second notebook is never taken for the usual one. */
export function NotebookMarker() {
  const other = () => known()?.notebooks.find(entry => entry.current && !entry.default);
  return <Show when={other()}>{entry => <span class="desk-count notebook-marker" title={`Open notebook: ${entry().path}`}>{entry().name}</span>}</Show>;
}
