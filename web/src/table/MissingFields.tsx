import { For } from 'solid-js';
import { Button } from '../ui/Button';

export function MissingFields(props: { fields: readonly { id: string; name: string }[]; busy?: boolean; onRemove(id: string): void }) {
  return <div class="table-query-chips" role="status"><For each={props.fields}>{field => <span class="table-chip">Field “{field.name}” is missing. <Button disabled={props.busy} label={`Remove ${field.name} from view`} onClick={() => props.onRemove(field.id)}>Remove from view</Button></span>}</For></div>;
}
