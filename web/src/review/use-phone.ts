import { createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { phoneQuery } from '../ui/phone';

/** Whether the phone layout applies, kept current as the window crosses the breakpoint (a fold opening, a rotation). */
export function createPhone(): Accessor<boolean> {
  const media = window.matchMedia(phoneQuery);
  const [phone, setPhone] = createSignal(media.matches);
  const changed = () => setPhone(media.matches);
  media.addEventListener('change', changed);
  onCleanup(() => media.removeEventListener('change', changed));
  return phone;
}
