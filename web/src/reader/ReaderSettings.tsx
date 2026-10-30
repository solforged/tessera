import { For, Show, createRoot, createSignal } from 'solid-js';
import { Button } from '../ui/Button';
import { isPhone } from '../ui/phone';
import { Popup } from '../ui/Popup';
import { Seg } from '../ui/Seg';

const sizes = [15, 16, 17, 18, 20, 22] as const;
// Widths in em follow the reader size: a compact or medium reading measure.
const widths = { Narrow: '28em', Medium: '34em', Wide: 'var(--measure)' } as const;
const narrowest = 28;
const spacings = { Compact: 1.5, Normal: 1.65, Relaxed: 1.8 } as const;
const layouts = { scroll: 'Scroll', pages: 'Pages' } as const;
/** The reader's page follows the app unless told otherwise (Auto); Day and Night hold it light or dark. Phones only. */
const pageThemes = { auto: 'Auto', day: 'Day', night: 'Night' } as const;
interface ReaderSettings {
  typeface: 'sans' | 'serif';
  size: typeof sizes[number];
  width: keyof typeof widths;
  spacing: keyof typeof spacings;
  /** Pages turn sideways and show two columns when the pane fits them. */
  layout: keyof typeof layouts;
  page: keyof typeof pageThemes;
}
const defaults: ReaderSettings = { typeface: 'serif', size: 17, width: 'Medium', spacing: 'Normal', layout: 'scroll', page: 'auto' };
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
      layout: Object.hasOwn(layouts, value.layout) ? value.layout : defaults.layout,
      page: Object.hasOwn(pageThemes, value.page) ? value.page : defaults.page,
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

/**
 * On a touch screen the settings rise as a sheet from the bottom edge, so the text they change stays in sight above.
 * `room` is the text's width at most; where even Narrow fills it, every width reads the same and Width steps aside.
 */
export function ReaderSettingsPopup(props: { anchor: HTMLElement; sheet: boolean; room: number; onDismiss(): void }) {
  const sizeIndex = () => sizes.indexOf(readerSettings().size);
  const widthMatters = () => props.room > narrowest * readerSettings().size;
  // A phone's Appearance: a floating sheet that leaves the page undimmed, so the text answers each change; every choice a
  // segmented control, and the size a pair of capsules around its value.
  if (isPhone()) {
    const named = <T extends string>(names: Record<T, string>) => (Object.keys(names) as T[]).map(value => ({ value, label: names[value] }));
    return <Popup anchor={props.anchor} placement="sheet" scrim={false} title="Appearance" label="Reader settings" class="reader-settings reader-appearance" onDismiss={props.onDismiss}>
      <div class="reader-settings-body">
        <div class="reader-option"><span class="reader-option-label">Layout</span><Seg label="Layout" value={readerSettings().layout} options={named(layouts)} onChange={layout => setSettings({ layout })} /></div>
        <div class="reader-option"><span class="reader-option-label">Typeface</span><Seg label="Typeface" value={readerSettings().typeface} options={[{ value: 'sans', label: <span class="reader-face-sans">Sans</span> }, { value: 'serif', label: <span class="reader-face-serif">Serif</span> }]} onChange={typeface => setSettings({ typeface })} /></div>
        <div class="reader-option"><span class="reader-option-label">Size</span><div class="reader-step" role="group" aria-label="Size">
          <Button class="reader-step-less" label="Decrease size" disabled={sizeIndex() === 0} onClick={() => setSettings({ size: sizes[sizeIndex() - 1]! })}>A<em>−</em></Button>
          <output class="reader-step-value" aria-label="Reader size">{readerSettings().size}</output>
          <Button class="reader-step-more" label="Increase size" disabled={sizeIndex() === sizes.length - 1} onClick={() => setSettings({ size: sizes[sizeIndex() + 1]! })}>A<em>+</em></Button>
        </div></div>
        <Show when={widthMatters()}><div class="reader-option"><span class="reader-option-label">Width</span><Seg label="Width" value={readerSettings().width} options={(Object.keys(widths) as (keyof typeof widths)[]).map(value => ({ value, label: value }))} onChange={width => setSettings({ width })} /></div></Show>
        <div class="reader-option"><span class="reader-option-label">Line spacing</span><Seg label="Line spacing" value={readerSettings().spacing} options={(Object.keys(spacings) as (keyof typeof spacings)[]).map(value => ({ value, label: value }))} onChange={spacing => setSettings({ spacing })} /></div>
        <div class="reader-option"><span class="reader-option-label">Page</span><Seg label="Page" value={readerSettings().page} options={named(pageThemes)} onChange={page => setSettings({ page })} /></div>
      </div>
    </Popup>;
  }
  return <Popup anchor={props.anchor} placement={props.sheet ? 'sheet' : 'anchor'} label="Reader settings" class="reader-settings" onDismiss={props.onDismiss}>
    <div class="reader-settings-body">
    <div class="reader-setting"><span>Layout</span><div class="mode-tabs" role="group" aria-label="Layout"><For each={Object.keys(layouts) as (keyof typeof layouts)[]}>{layout =>
      <Button aria-pressed={readerSettings().layout === layout} onClick={() => setSettings({ layout })}>{layouts[layout]}</Button>
    }</For></div></div>
    <div class="reader-setting"><span>Typeface</span><div class="mode-tabs" role="group" aria-label="Typeface">
      <Button aria-pressed={readerSettings().typeface === 'sans'} onClick={() => setSettings({ typeface: 'sans' })}>Sans</Button>
      <Button aria-pressed={readerSettings().typeface === 'serif'} onClick={() => setSettings({ typeface: 'serif' })}>Serif</Button>
    </div></div>
    <div class="reader-setting"><span>Size</span><div>
      <Button label="Decrease size" disabled={sizeIndex() === 0} onClick={() => setSettings({ size: sizes[sizeIndex() - 1]! })}>−</Button>
      <output aria-label="Reader size">{readerSettings().size}</output>
      <Button label="Increase size" disabled={sizeIndex() === sizes.length - 1} onClick={() => setSettings({ size: sizes[sizeIndex() + 1]! })}>+</Button>
    </div></div>
    <Show when={widthMatters()}><div class="reader-setting"><span>Width</span><div class="mode-tabs" role="group" aria-label="Width"><For each={Object.keys(widths) as (keyof typeof widths)[]}>{width =>
      <Button aria-pressed={readerSettings().width === width} onClick={() => setSettings({ width })}>{width}</Button>
    }</For></div></div></Show>
    <div class="reader-setting"><span>Line spacing</span><div class="mode-tabs" role="group" aria-label="Line spacing"><For each={Object.keys(spacings) as (keyof typeof spacings)[]}>{spacing =>
      <Button aria-pressed={readerSettings().spacing === spacing} onClick={() => setSettings({ spacing })}>{spacing}</Button>
    }</For></div></div>
    </div>
  </Popup>;
}
