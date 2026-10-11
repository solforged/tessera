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
import { setStreamFactory, setTransport } from '../api/client';
import { App } from '../shell/App';
import { notebookFetch, notebookStream } from './transport';
import '../styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');
setTransport(notebookFetch);
setStreamFactory(notebookStream);
setOpenedFilesInbox(() => invoke<OpenedFiles>('take_opened_files'));
// MainActivity exposes the launcher's New note request; taking it clears it.
const capture = (window as Window & { TesseraCapture?: { take(): boolean; showKeyboard(): void } }).TesseraCapture;
if (capture) setQuickCaptureSource({ take: () => capture.take(), showKeyboard: () => capture.showKeyboard() });
// The gesture bar's height, which the WebView leaves out of env(safe-area-inset-bottom) on some devices. Folding and
// the keyboard change it, and both resize the page.
const insets = (window as Window & { TesseraInsets?: { bottom(): number } }).TesseraInsets;
if (insets) {
  const apply = () => document.documentElement.style.setProperty('--system-bottom', `${insets.bottom()}px`);
  apply();
  window.addEventListener('resize', apply);
}
// The app bundles its interface, so the native entry's offline cache is not registered.
render(() => <App />, root);
