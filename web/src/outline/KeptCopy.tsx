import type { KeptCopy } from '../api/types';
import type { Edit } from '../document/contract';
import { ANDROID } from '../demo/mode';
import { Button } from '../ui/Button';

export function KeptCopyLabel(props: { copy: KeptCopy }) {
  return <div class="outline-capability-notice">{props.copy.mine ? ANDROID ? 'This phone' : 'This device' : props.copy.origin_name ?? 'Another device'}'s version, kept beside</div>;
}

export function KeptCopyActions(props: { id: string; apply: (edit: Edit) => void }) {
  return <div class="conflict-actions" onMouseDown={event => event.stopPropagation()}>
    <Button onClick={() => props.apply({ kind: 'keptCopy', id: props.id, choice: 'use' })}>Use this</Button>
    <Button onClick={() => props.apply({ kind: 'keptCopy', id: props.id, choice: 'discard' })}>Discard</Button>
    <Button onClick={() => props.apply({ kind: 'keptCopy', id: props.id, choice: 'both' })}>Keep both</Button>
  </div>;
}
