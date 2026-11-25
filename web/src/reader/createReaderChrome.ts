import { createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import { ulid } from 'ulid';
import { setSystemBarsHidden } from '../ui/system-bars';
import { setThemeOverride } from '../ui/theme';
import { readerSettings } from './ReaderSettings';

/** Touch screens write a new highlight's note beside the passage, not in the source page. */
export const coarsePointer = window.matchMedia('(pointer: coarse)');
/** No hover and a coarse pointer: a phone or tablet without a keyboard and trackpad, as `kbd` hints assume in CSS. */
export const touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)');
/** The cover screen always reads in the reading layout; its chrome toggles with a centre tap, as in full screen. */
export const coverScreen = window.matchMedia('(max-width: 599px) and (pointer: coarse)');
/** In full screen the reading chrome fades after this long without the mouse moving. */
const CHROME_IDLE = 2500;

/**
 * A resize callback that writes layout state runs a frame later: WebKit reports a resize caused inside its own
 * observer cycle as an uncaught "ResizeObserver loop completed with undelivered notifications" error.
 */
export function deferred(run: () => void) {
  let frame = 0;
  return Object.assign(
    () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(run);
    },
    { cancel: () => cancelAnimationFrame(frame) },
  );
}

export interface ReaderChromeOptions {
  active: Accessor<boolean>;
  immersive: Accessor<boolean>;
  loading: Accessor<boolean>;
  firstVisible: Accessor<number>;
  pageIndex: Accessor<number>;
  chunk: Accessor<unknown>;
  popupKind: Accessor<string | null>;
  closePopup: () => void;
  hasSelection: Accessor<boolean>;
  header: () => HTMLElement | undefined;
  navBar: () => HTMLElement | null;
  onBack: () => void;
}

/**
 * Full screen and cover screen chrome lifecycle: auto-hiding toolbars, Android system bars, per-book Day/Night
 * theme override, contents sheet scroll-to-current and Android Back history interception.
 */
export function createReaderChrome(options: ReaderChromeOptions) {
  const [coverReading, setCoverReading] = createSignal(coverScreen.matches);
  const chromeHides = () => options.immersive() || coverReading();
  const chromeOverlays = () => coverReading() || (options.immersive() && coarsePointer.matches);
  const [chromeHidden, setChromeHidden] = createSignal(false);
  let chromeTimer = 0;
  let keyboardFocus = false;
  let lastPointer = '';

  function showChrome(idle: boolean) {
    clearTimeout(chromeTimer);
    setChromeHidden(false);
    if (idle && options.immersive()) chromeTimer = window.setTimeout(hideChrome, CHROME_IDLE);
  }

  /** Focus a click left on the toolbar goes with it; focus that arrived by keyboard keeps the toolbar up. */
  function hideChrome() {
    if (options.popupKind() || options.hasSelection()) return;
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      (options.header()?.contains(focused) || options.navBar()?.contains(focused))
    ) {
      if (keyboardFocus) return;
      focused.blur();
    }
    setChromeHidden(true);
  }

  function toggleChrome() {
    if (!chromeHides()) return;
    clearTimeout(chromeTimer);
    setChromeHidden(value => !value);
  }

  function onHeaderFocusIn(event: FocusEvent) {
    keyboardFocus = (event.target as Element).matches(':focus-visible');
    showChrome(true);
  }

  // WebKit sends pointermove when the page turns under a resting mouse; only a real move shows the chrome.
  function pointerMoved(event: PointerEvent) {
    const at = `${event.screenX},${event.screenY}`;
    if (event.pointerType !== 'mouse' || !options.immersive() || at === lastPointer) return;
    lastPointer = at;
    showChrome(true);
  }

  createEffect(() => {
    if (!chromeHides() || options.popupKind()) showChrome(false);
  });
  createEffect(() => {
    if (options.immersive() && !coarsePointer.matches) showChrome(true);
  });
  // Android's status and navigation bars leave with the chrome and return with it.
  createEffect(() => {
    if (!options.active() || !chromeHides() || !chromeHidden()) return;
    setSystemBarsHidden(true);
    onCleanup(() => setSystemBarsHidden(false));
  });
  // A book's own Day or Night holds the whole window while it reads on a phone (Appearance › Page); Auto follows the app.
  createEffect(() => {
    const page = readerSettings().page;
    if (!options.active() || !coverReading() || page === 'auto') return;
    setThemeOverride(page === 'day' ? 'light' : 'dark');
    onCleanup(() => setThemeOverride(null));
  });
  // On a phone the contents open on their first entry with the chapter being read inside the window; only a chapter lower down brings the list to it.
  createEffect(
    on(options.popupKind, kind => {
      if (kind !== 'contents' || !coverReading()) return;
      const settle = () => {
        const list = document.querySelector<HTMLElement>('.reader-picker .picker-list'),
          row = list?.querySelector<HTMLElement>('[aria-current="true"]');
        if (!list || !row) return;
        const at = row.getBoundingClientRect(),
          box = list.getBoundingClientRect();
        if (at.bottom > box.bottom) list.scrollTop += at.top - box.top - (box.height - at.height) / 2;
      };
      requestAnimationFrame(() => requestAnimationFrame(settle));
    }),
  );
  // On the cover screen the reader owns a history entry, so the system Back gesture (Android) closes an open sheet and
  // then leaves the book as its back arrow does, rather than leaving the app. Leaving another way pops the entry.
  createEffect(() => {
    if (!options.active() || !coverReading() || options.immersive()) return;
    const key = ulid();
    let owned = true;
    history.pushState({ ...history.state, tesseraReader: key }, '');
    const moved = () => {
      if (history.state?.tesseraReader === key) return;
      if (options.popupKind()) {
        options.closePopup();
        history.pushState({ ...history.state, tesseraReader: key }, '');
        return;
      }
      owned = false;
      options.onBack();
    };
    window.addEventListener('popstate', moved);
    onCleanup(() => {
      window.removeEventListener('popstate', moved);
      if (owned && history.state?.tesseraReader === key) history.back();
    });
  });
  createEffect(
    on(
      [options.loading, options.firstVisible, options.pageIndex, options.chunk],
      () => {
        if (chromeOverlays() && !options.loading()) hideChrome();
      },
      { defer: true },
    ),
  );
  onMount(() => {
    const coverChanged = () => setCoverReading(coverScreen.matches);
    coverScreen.addEventListener('change', coverChanged);
    onCleanup(() => {
      coverScreen.removeEventListener('change', coverChanged);
      clearTimeout(chromeTimer);
    });
  });

  return {
    coverReading,
    chromeHides,
    chromeOverlays,
    chromeHidden,
    showChrome,
    hideChrome,
    toggleChrome,
    onHeaderFocusIn,
    pointerMoved,
  };
}
