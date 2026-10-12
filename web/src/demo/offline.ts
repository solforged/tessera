if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .catch(reason => console.warn('The browser offline cache could not start.', reason));
}

let requested = false;

/** Called after a notebook opens, including the first-run empty/restore choices. */
export function persistOwnNotebook(): void {
  if (requested || localStorage.getItem('tessera.browser.notebook') !== 'own') return;
  requested = true;
  const storage = navigator.storage;
  if (!storage?.persisted || !storage.persist) return;
  void storage.persisted().then(persisted => {
    if (!persisted) return storage.persist();
  }).catch(reason => console.warn('The browser storage request failed.', reason));
}
