import { For, Show } from 'solid-js';
import type { FieldDetail } from '../api/types';

export function ChoiceConversion(props: { detail: FieldDetail; checked: boolean; disabled?: boolean; onChange(checked: boolean): void }) {
  return <Show when={props.detail.kind === 'choice' && props.detail.choice_candidates.length}>
    <label class="menu-item field-conversion-toggle"><input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={event => props.onChange(event.currentTarget.checked)} />Add {props.detail.choice_candidates.length} values as options</label>
    <ul class="field-note field-conversion-list"><For each={props.detail.choice_candidates}>{candidate => <li>{candidate.text}</li>}</For></ul>
  </Show>;
}
