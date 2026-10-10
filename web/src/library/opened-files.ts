import { createEffect, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { IngestJob } from '../api/types';

export interface OpenedFiles {
  jobs: IngestJob[];
  errors: string[];
}

type OpenedFilesWindow = Window & {
  __tesseraOpenedFiles?: (result: OpenedFiles) => void;
  __tesseraPendingOpenedFiles?: OpenedFiles[];
};
let takeOpenedFiles: (() => Promise<OpenedFiles>) | undefined;

/** Android reads its private native inbox; desktop pushes upload results. */
export function setOpenedFilesInbox(take: () => Promise<OpenedFiles>): void {
  takeOpenedFiles = take;
}

/** Both shells reveal the import through the normal Library jobs/source view. */
export function installOpenedFiles(ready: Accessor<boolean>, showLibrary: () => void, reportError: (reason: unknown) => void): void {
  const nativeWindow = window as OpenedFilesWindow;
  const pending = nativeWindow.__tesseraPendingOpenedFiles ?? [];
  delete nativeWindow.__tesseraPendingOpenedFiles;
  let disposed = false;
  let taking = false;
  let takeAgain = false;
  const reveal = () => {
    if (!ready() || !pending.length) return;
    const results = pending.splice(0);
    showLibrary();
    const errors = results.flatMap(result => result.errors);
    reportError(errors.join('\n'));
  };
  const receive = (result: OpenedFiles) => {
    if (!result.jobs.length && !result.errors.length) return;
    pending.push(result);
    reveal();
  };
  nativeWindow.__tesseraOpenedFiles = receive;
  createEffect(reveal);
  const take = async () => {
    if (!takeOpenedFiles || disposed) return;
    if (taking) { takeAgain = true; return; }
    taking = true;
    try {
      do {
        takeAgain = false;
        const result = await takeOpenedFiles();
        if (!disposed) receive(result);
      } while (takeAgain && !disposed);
    } catch (reason) {
      if (!disposed) reportError(reason);
    } finally { taking = false; }
  };
  const visible = () => { if (document.visibilityState === 'visible') void take(); };
  onMount(() => {
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('tessera-opened-files-ready', take);
    void take();
  });
  onCleanup(() => {
    disposed = true;
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('tessera-opened-files-ready', take);
    if (nativeWindow.__tesseraOpenedFiles === receive) delete nativeWindow.__tesseraOpenedFiles;
  });
}
