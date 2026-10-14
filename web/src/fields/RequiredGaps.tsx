import { For } from 'solid-js';
import type { RequiredField } from '../api/types';
import { Button } from '../ui/Button';

/** One button per required field some members lack, such as “3 need author”, each showing just those members. */
export function RequiredGaps(props: { gaps: readonly RequiredField[] | undefined; name(id: string): string | undefined; onShow(field: string): void }) {
  return <For each={props.gaps?.filter(field => field.missing > 0 && props.name(field.field_id))}>{field => <Button class="required-gap" title={`Show the ${field.missing === 1 ? 'member' : 'members'} without ${props.name(field.field_id)}`} onClick={() => props.onShow(field.field_id)}>
    {field.missing.toLocaleString()} {field.missing === 1 ? 'needs' : 'need'} {props.name(field.field_id)}
  </Button>}</For>;
}
