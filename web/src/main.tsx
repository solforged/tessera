import '@fontsource-variable/ibm-plex-sans';
import { render } from 'solid-js/web';
import { App } from './shell/App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');
render(() => <App />, root);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void (async () => {
      const shell = await fetch('/index.html', { cache: 'no-cache' });
      if (!shell.ok) throw new Error('Application shell is unavailable');
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(await shell.text())));
      const version = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
      const entry = encodeURIComponent(new URL(import.meta.url).pathname);
      await navigator.serviceWorker.register(`/offline-worker.js?version=${version}&entry=${entry}`, { scope: '/', updateViaCache: 'none' });
    })().catch(error => console.warn('Offline cache update unavailable', error));
  });
}
