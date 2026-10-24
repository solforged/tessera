import '../shell/theme';
import '@fontsource-variable/ibm-plex-sans';
import '../ui/keys.css';
import '@fontsource-variable/piazzolla/standard.css';
import '@fontsource-variable/piazzolla/standard-italic.css';
import { render } from 'solid-js/web';
import { invoke } from '@tauri-apps/api/core';
import { setOpenedFilesInbox } from '../library/opened-files';
import type { OpenedFiles } from '../library/opened-files';
import { setQuickCaptureSource } from '../shell/quick-capture';
import { parseCreateRequest } from '../create/request';
import { setStreamFactory, setTransport } from '../api/client';
import { setSystemBarsHandler } from '../shell/system-bars';
import { App } from '../shell/App';
import { installIosViewport } from '../ui/ios-viewport';
import { notebookFetch, notebookStream } from './transport';
import '../styles.css';

installIosViewport();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');
setTransport(notebookFetch);
setStreamFactory(notebookStream);
setOpenedFilesInbox(() => invoke<OpenedFiles>('take_opened_files'));
// MainActivity holds launcher, share, widget and tile requests as `{ kind, text }` JSON; taking one clears it.
const capture = (window as Window & { TesseraCapture?: { take(): string; showKeyboard(): void } }).TesseraCapture;
if (capture) setQuickCaptureSource({ take: () => parseCreateRequest(capture.take()), showKeyboard: () => capture.showKeyboard() });
// The status and gesture bars' heights, which the WebView leaves out of the safe-area insets on some devices. Folding
// and the keyboard change them; MainActivity says so with `tessera-insets`. The reader hides both bars while its
// chrome is away, and their icons follow the app's theme rather than the system's.
const insets = (window as Window & { TesseraInsets?: { top(): number; bottom(): number; bars(visible: boolean): void; lightBars(light: boolean): void } }).TesseraInsets;
if (insets) {
  const apply = () => {
    document.documentElement.style.setProperty('--system-top', `${insets.top()}px`);
    document.documentElement.style.setProperty('--system-bottom', `${insets.bottom()}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('tessera-insets', apply);
  const theme = () => insets.lightBars(document.documentElement.dataset.theme === 'light');
  theme();
  new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setSystemBarsHandler(hidden => insets.bars(!hidden));
}
// The app bundles its interface, so the native entry's offline cache is not registered.
render(() => <App />, root);
