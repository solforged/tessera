import { For, Show } from 'solid-js';
import { Button } from '../ui/Button';
import { isPhone } from '../ui/phone';
import { Seg } from '../ui/Seg';

/** One choice among a few: the phone's segmented control, or the mode tabs everywhere else. */
export function Choice<T extends string>(props: { label: string; value: T; options: readonly { value: T; label: string }[]; disabled?: boolean; onChange(value: T): void }) {
  return <Show when={isPhone()} fallback={<div class="mode-tabs settings-segments" role="group" aria-label={props.label}>
    <For each={props.options}>{option =>
      <Button aria-pressed={props.value === option.value} disabled={props.disabled} onClick={() => props.onChange(option.value)}>{option.label}</Button>}</For>
  </div>}>
    <Seg label={props.label} value={props.value} options={props.options} onChange={props.onChange} />
  </Show>;
}
