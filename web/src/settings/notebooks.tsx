import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { ApiError, api } from '../api/client';
import type { KnownWorkshop, KnownWorkshops } from '../api/types';
import { EMBEDDED } from '../core/mode';
import type { WorkshopClient } from '../document/contract';
import type { CommandRegistry } from '../core/contract';

// One service owns one workshop. Switching asks it to restart on another; every window on it then
// reloads, because its requests name the workshop it opened and the service refuses them.
const [known, setKnown] = createSignal<KnownWorkshops>();
const [opening, setOpening] = createSignal<string | null>(null);
export { known as knownWorkshops, opening as workshopOpening };

/** Workshops go by their folder name, capitalized for display; the folder keeps its own spelling. */
export const workshopName = (folder: string) => folder.charAt(0).toLocaleUpperCase() + folder.slice(1);
export const workshopLabel = (workshop: KnownWorkshop) => workshopName(workshop.name);

/** The folder that holds workshops made by name, as `~/…`, read off one of them. */
export const workshopsHome = () => {
  const named = known()?.notebooks.find(entry => entry.named);
  return named ? named.display_path.slice(0, named.display_path.lastIndexOf('/')) : undefined;
};

/**
 * Where a workshop lives, when its name alone doesn't say: nothing for one made by name, its location for one
 * elsewhere, and its whole path when another workshop shares its name.
 */
export function workshopPlace(workshop: KnownWorkshop): string | undefined {
  const twin = known()?.notebooks.some(entry => entry !== workshop && workshopLabel(entry) === workshopLabel(workshop));
  if (twin) return workshop.display_path;
  return workshop.named ? undefined : workshop.display_path;
}

export async function loadWorkshops(): Promise<void> {
  if (!EMBEDDED) setKnown(await api.workshops());
}

export async function forgetWorkshop(path: string): Promise<void> {
  setKnown(await api.forgetWorkshop(path));
}

/**
 * Give unsent edits a moment to save, switch the service, and reload once it serves the chosen
 * workshop. Edits still unsent stay in this workshop's local outbox until it opens again.
 */
export async function openWorkshop(
  workshop: WorkshopClient,
  path: string,
  create: boolean,
  label: string,
): Promise<void> {
  if (opening()) return;
  setOpening(label);
  try {
    const saving = Date.now() + 3000;
    while (workshop.saveState() !== 'saved' && Date.now() < saving) {
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, 100);
      await wait.promise;
    }
    const opened = await api.openWorkshop(path, create);
    await reloadWorkshop(opened.path, label);
  } catch (error) {
    setOpening(null);
    throw error;
  }
}

/** Wait through the drain and restart before reloading, including same-workshop restores. */
export async function reloadWorkshop(path: string, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const wait = Promise.withResolvers<void>();
    setTimeout(wait.resolve, 250);
    await wait.promise;
    try {
      if ((await api.workshop()).path === path) {
        location.reload();
        return;
      }
    } catch (error) {
      // "switching" and connection failures mean the old service is still draining.
      if (error instanceof ApiError && error.code === 'notebook_changed') return;
    }
  }
  throw new Error(`${label} did not open within 30 seconds. Reload the window to see which workshop is open.`);
}

/** Palette commands to switch to each other workshop on the list. */
export function registerWorkshopCommands(
  commands: CommandRegistry,
  workshop: WorkshopClient,
  report: (error: unknown) => void,
): void {
  if (EMBEDDED) return;
  void loadWorkshops().catch(() => {
    /* The commands appear once Settings loads the list. */
  });
  createEffect(() => {
    const others = (known()?.notebooks ?? []).filter(entry => !entry.current && entry.available);
    onCleanup(
      commands.register(
        others.map(entry => ({
          id: `shell.notebook.${entry.path}`,
          title: `Switch to workshop: ${workshopLabel(entry)}`,
          section: 'Navigation' as const,
          disabledReason: () => (opening() ? 'A workshop is already opening' : undefined),
          run: () => {
            void openWorkshop(workshop, entry.path, false, workshopLabel(entry)).catch(report);
          },
        })),
      ),
    );
  });
}

/** Covers the window between the switch and the reload, so nothing is edited in the workshop being left. */
export function WorkshopOpening() {
  return (
    <Show when={opening()}>
      {label => (
        <div class="notebook-opening" role="status" aria-live="polite">
          <span>Opening {label()}…</span>
        </div>
      )}
    </Show>
  );
}
