import { For, createRoot, createSignal } from 'solid-js';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';

const sizes = [15, 16, 17, 18, 20, 22] as const;
// Widths in em follow the reader size: a compact or medium reading measure.
const widths = { Narrow: '28em', Medium: '34em', Wide: 'var(--measure)' } as const;
const spacings = { Compact: 1.5, Normal: 1.65, Relaxed: 1.8 } as const;
interface ReaderSettings {
  typeface: 'sans' | 'serif';
  size: typeof sizes[number];
  width: keyof typeof widths;
  spacing: keyof typeof spacings;
}
const defaults: ReaderSettings = { typeface: 'serif', size: 17, width: 'Medium', spacing: 'Normal' };
const storageKey = 'tessera.reader';
function storedSettings(): ReaderSettings {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (!value || typeof value !== 'object') return defaults;
    return {
      typeface: value.typeface === 'sans' || value.typeface === 'serif' ? value.typeface : defaults.typeface,
      size: sizes.includes(value.size) ? value.size : defaults.size,
      width: Object.hasOwn(widths, value.width) ? value.width : defaults.width,
      spacing: Object.hasOwn(spacings, value.spacing) ? value.spacing : defaults.spacing,
    };
  } catch { return defaults; }
}
// One device preference shared by every reader pane.
const [readerSettings, setReaderSettingsSignal] = createRoot(() => createSignal(storedSettings()));
export { readerSettings };
function setSettings(patch: Partial<ReaderSettings>) {
  const value = { ...readerSettings(), ...patch };
  setReaderSettingsSignal(value);
  try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* The preference lasts for this tab. */ }
}
export const readerStyle = () => ({
  '--reader-font': readerSettings().typeface === 'serif' ? 'var(--font-reading-serif)' : 'var(--font-body)',
  '--reader-size': `${readerSettings().size}px`,
  '--reader-line': spacings[readerSettings().spacing],
  '--reader-measure': widths[readerSettings().width],
});

export function ReaderSettingsPopup(props: { anchor: HTMLElement; onDismiss(): void }) {
  const sizeIndex = () => sizes.indexOf(readerSettings().size);
  return <Popup anchor={props.anchor} label="Reader settings" class="reader-settings" onDismiss={props.onDismiss}>
    <div class="reader-setting"><span>Typeface</span><div class="mode-tabs" role="group" aria-label="Typeface">
      <Button aria-pressed={readerSettings().typeface === 'sans'} onClick={() => setSettings({ typeface: 'sans' })}>Sans</Button>
      <Button aria-pressed={readerSettings().typeface === 'serif'} onClick={() => setSettings({ typeface: 'serif' })}>Serif</Button>
    </div></div>
    <div class="reader-setting"><span>Size</span><div>
      <Button label="Decrease size" disabled={sizeIndex() === 0} onClick={() => setSettings({ size: sizes[sizeIndex() - 1]! })}>−</Button>
      <output aria-label="Reader size">{readerSettings().size}</output>
      <Button label="Increase size" disabled={sizeIndex() === sizes.length - 1} onClick={() => setSettings({ size: sizes[sizeIndex() + 1]! })}>+</Button>
    </div></div>
    <div class="reader-setting"><span>Width</span><div class="mode-tabs" role="group" aria-label="Width"><For each={Object.keys(widths) as (keyof typeof widths)[]}>{width =>
      <Button aria-pressed={readerSettings().width === width} onClick={() => setSettings({ width })}>{width}</Button>
    }</For></div></div>
    <div class="reader-setting"><span>Line spacing</span><div class="mode-tabs" role="group" aria-label="Line spacing"><For each={Object.keys(spacings) as (keyof typeof spacings)[]}>{spacing =>
      <Button aria-pressed={readerSettings().spacing === spacing} onClick={() => setSettings({ spacing })}>{spacing}</Button>
    }</For></div></div>
  </Popup>;
}
