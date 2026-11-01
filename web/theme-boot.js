// Runs before the first paint (a parser-blocking script in the head): the page's boot style follows the device's stored
// theme choice, not just the operating system's. The entry's shell/theme.ts applies the same choice afterwards and owns it.
try {
  var stored = localStorage.getItem('tessera.theme');
  if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;
} catch (error) { /* Storage can be unavailable; the system theme paints. */ }
