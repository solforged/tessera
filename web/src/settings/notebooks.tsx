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

/** Workshops go by their folder name, capitalized for display; the folder keeps its own spelling. */
export const workshopName = (folder: string) => folder.charAt(0).toLocaleUpperCase() + folder.slice(1);
export const notebookLabel = (notebook: KnownNotebook) => workshopName(notebook.name);

/** The folder that holds workshops made by name, as `~/…`, read off one of them. */
export const workshopsHome = () => {
  const named = known()?.notebooks.find(entry => entry.named);
  return named ? named.display_path.slice(0, named.display_path.lastIndexOf('/')) : undefined;
};

/**
 * Where a workshop lives, when its name alone doesn't say: nothing for one made by name, its location for one
 * elsewhere, and its whole path when another workshop shares its name.
 */
export function notebookPlace(notebook: KnownNotebook): string | undefined {
  const twin = known()?.notebooks.some(entry => entry !== notebook && notebookLabel(entry) === notebookLabel(notebook));
  if (twin) return notebook.display_path;
  return notebook.named ? undefined : notebook.display_path;
}

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
    await reloadNotebook(opened.path, label);
  } catch (error) {
    setOpening(null);
    throw error;
  }
}

/** Wait through the drain and restart before reloading, including same-workshop restores. */
export async function reloadNotebook(path: string, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const wait = Promise.withResolvers<void>();
    setTimeout(wait.resolve, 250);
    await wait.promise;
    try {
      if ((await api.notebook()).path === path) { location.reload(); return; }
    } catch (error) {
      // "switching" and connection failures mean the old service is still draining.
      if (error instanceof ApiError && error.code === 'notebook_changed') return;
    }
  }
  throw new Error(`${label} did not open within 30 seconds. Reload the window to see which workshop is open.`);
}

/** Palette commands to switch to each other notebook on the list. */
export function registerNotebookCommands(commands: CommandRegistry, notebook: NotebookClient, report: (error: unknown) => void): void {
  if (EMBEDDED) return;
  void loadNotebooks().catch(() => { /* The commands appear once Settings loads the list. */ });
  createEffect(() => {
    const others = (known()?.notebooks ?? []).filter(entry => !entry.current && entry.available);
    onCleanup(commands.register(others.map(entry => ({
      id: `shell.notebook.${entry.path}`, title: `Switch to workshop: ${notebookLabel(entry)}`, section: 'Navigation' as const,
      disabledReason: () => opening() ? 'A workshop is already opening' : undefined,
      run: () => { void openNotebook(notebook, entry.path, false, notebookLabel(entry)).catch(report); },
    }))));
  });
}

/** Covers the window between the switch and the reload, so nothing is edited in the notebook being left. */
export function NotebookOpening() {
  return <Show when={opening()}>{label => <div class="notebook-opening" role="status" aria-live="polite"><span>Opening {label()}…</span></div>}</Show>;
}
