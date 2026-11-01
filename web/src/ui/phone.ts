import { createSignal } from 'solid-js';

/** The phone scope: the same media query styles.css gates the phone layout on. */
export const phoneQuery = '(max-width: 599px) and (pointer: coarse)';

// One list for the page, held here for as long as it lives, so a fold opening or a rotation always reaches the signal;
// a resize re-reads it in case a host moves the width without a media change.
let media: MediaQueryList | undefined;
const [phone, setPhone] = createSignal(false);

/**
 * Whether the phone layout applies now. Read inside JSX or an effect it follows the window across the breakpoint;
 * read once into a constant it keeps the layout the component mounted with.
 */
export function isPhone(): boolean {
  if (!media) {
    const list = media = window.matchMedia(phoneQuery);
    const read = () => setPhone(list.matches);
    read();
    list.addEventListener?.('change', read);
    window.addEventListener('resize', read);
  }
  phone(); // tracks the breakpoint; the answer is read fresh
  return window.matchMedia(phoneQuery).matches;
}
