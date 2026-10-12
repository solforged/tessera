import { api } from '../api/client';
import { setOpenedFilesInbox } from '../library/opened-files';
import type { OpenedFiles } from '../library/opened-files';
import { blankCapture, setQuickCaptureSource } from '../shell/quick-capture';
import type { CaptureRequest } from '../shell/quick-capture';

type WindowControlsOverlay = EventTarget & { readonly visible: boolean };
type Launch = { targetURL?: string; files?: readonly FileSystemFileHandle[] };
type LaunchWindow = Window & { launchQueue?: { setConsumer(consumer: (launch: Launch) => void): void } };

/** Installed-browser hooks stay out of the native and Android entry points. */
export function installInstalledWindow(): void {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;
  const geometry = () => {
    if (overlay?.visible) document.documentElement.dataset.titlebar = 'overlay';
    else delete document.documentElement.dataset.titlebar;
  };
  geometry();
  overlay?.addEventListener('geometrychange', geometry);

  const installed = window.matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)');
  window.addEventListener('keydown', event => {
    if (!installed.matches || event.isComposing || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    const command = key === ',' ? 'shell.settings' : key === 'n' ? 'shell.new' : key === 't' ? 'shell.today' : null;
    if (!command) return;
    event.preventDefault();
    if (!event.repeat) window.dispatchEvent(new CustomEvent('tessera-command', { detail: command }));
  }, true);

  // The shell drains these sources after mounting, so first-run choices keep incoming launches intact.
  const files: FileSystemFileHandle[] = [];
  let capture: CaptureRequest | null = null;
  setQuickCaptureSource({ take: () => { const request = capture; capture = null; return request; } });
  setOpenedFilesInbox(async () => {
    const result: OpenedFiles = { jobs: [], errors: [] };
    for (const handle of files.splice(0)) {
      if (!/\.epub$/i.test(handle.name)) { result.errors.push('Only EPUB files can be opened.'); continue; }
      try {
        const file = await handle.getFile();
        result.jobs.push(await api.upload(file, file.name));
      } catch (reason) { result.errors.push(`${handle.name}: ${reason instanceof Error ? reason.message : String(reason)}`); }
    }
    return result;
  });

  const cleanURL = () => {
    const url = new URL(window.location.href);
    let changed = false;
    for (const key of ['open-file', 'capture', 'protocol']) {
      if (url.searchParams.has(key)) { url.searchParams.delete(key); changed = true; }
    }
    if (changed) history.replaceState(history.state, '', url);
  };
  const receive = (launch: Launch) => {
    cleanURL();
    if (launch.files?.length) {
      files.push(...launch.files);
      window.dispatchEvent(new Event('tessera-opened-files-ready'));
    } else if (launch.targetURL) {
      const url = new URL(launch.targetURL, window.location.href);
      // URLSearchParams already decodes the protocol's encoded plus.
      if (url.searchParams.has('capture') || /^web\+tessera:(?:\/\/)?capture$/.test(url.searchParams.get('protocol') ?? '')) {
        capture = blankCapture();
        window.dispatchEvent(new Event('tessera-quick-capture'));
      }
    }
  };
  const initialURL = window.location.href;
  receive({ targetURL: initialURL });
  let firstLaunch = true;
  (window as LaunchWindow).launchQueue?.setConsumer(launch => {
    // A cold launch is also the initial navigation; a later focus-existing launch must still run.
    const duplicate = firstLaunch && launch.targetURL === initialURL && !launch.files?.length;
    firstLaunch = false;
    if (!duplicate) receive(launch);
  });
}
