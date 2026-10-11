import type { KeptCopy } from '../api/types';
import type { Edit } from '../document/contract';
import { ANDROID } from '../demo/mode';
import { Button } from '../ui/Button';
import './kept-copy.css';

/** The mono line over a copy another device's wording made beside a block both devices edited. */
export function KeptCopyLabel(props: { copy: KeptCopy }) {
  return <div class="kept-copy-label">{props.copy.mine ? ANDROID ? 'This phone' : 'This device' : props.copy.origin_name ?? 'Another device'}'s version, kept beside</div>;
}

export function KeptCopyActions(props: { id: string; apply: (edit: Edit) => void }) {
  return <div class="kept-copy-actions" onMouseDown={event => event.stopPropagation()}>
    <Button class="bordered" onClick={() => props.apply({ kind: 'keptCopy', id: props.id, choice: 'use' })}>Use this</Button>
    <Button class="bordered" onClick={() => props.apply({ kind: 'keptCopy', id: props.id, choice: 'discard' })}>Discard</Button>
    <Button class="bordered" onClick={() => props.apply({ kind: 'keptCopy', id: props.id, choice: 'both' })}>Keep both</Button>
  </div>;
}
