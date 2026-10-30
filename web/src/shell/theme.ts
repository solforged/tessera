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

let settled = false;
/** What the reader's page theme holds the whole window to while a book is open (Day or Night); null lets the preference decide. */
let override: 'light' | 'dark' | null = null;

function apply() {
  const value = preference();
  const theme = override ?? (value === 'system' ? (lightQuery.matches ? 'light' : 'dark') : value);
  const root = document.documentElement;
  const changed = root.dataset.theme !== theme;
  // Colors flip in one frame: controls must not ease from the old theme while surfaces and text already show the new one.
  if (changed && settled) root.dataset.themeSwitching = '';
  root.dataset.theme = theme;
  const canvas = getComputedStyle(root).getPropertyValue('--canvas').trim();
  if (canvas) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas);
  // The style recalculation above ran with transitions off; they come back once that frame has painted.
  if (changed && settled) requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.themeSwitching));
  settled = true;
}

export const themePreference = preference;

export function setThemeOverride(value: 'light' | 'dark' | null) {
  if (override === value) return;
  override = value;
  apply();
}

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
