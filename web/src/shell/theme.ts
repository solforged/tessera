import { createSignal } from 'solid-js';

/**
 * Light or dark is a device preference, not a notebook setting: the same
 * notebook can be read on a bright laptop and a dark desk. System follows the
 * operating system and is the default.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

const storageKey = 'tessera.theme';
const lightQuery = window.matchMedia('(prefers-color-scheme: light)');

const stored = (): ThemePreference => {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch { return 'system'; }
};

const [preference, setPreference] = createSignal<ThemePreference>(stored());

function apply() {
  const value = preference();
  const theme = value === 'system' ? (lightQuery.matches ? 'light' : 'dark') : value;
  document.documentElement.dataset.theme = theme;
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
  if (canvas) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas);
}

export const themePreference = preference;

export function setThemePreference(value: ThemePreference) {
  try {
    if (value === 'system') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, value);
  } catch { /* Storage can be unavailable; the choice still holds for this window. */ }
  setPreference(value);
  apply();
}

// Imported first by the entry, so the page never paints in the wrong theme.
apply();
lightQuery.addEventListener('change', apply);
// Another window on this device changed the preference.
window.addEventListener('storage', event => {
  if (event.key !== storageKey) return;
  setPreference(stored());
  apply();
});
