import { Show, createSignal, useContext } from 'solid-js';
import { Button } from '../ui/Button';
import { Menu } from '../ui/Menu';
import { AgentMarks } from './marks';
import './agent.css';

/** The agent's glyph in a changed row's outside rail; it opens the change with Undo. */
export function AgentMark(props: { id: string }) {
  const marks = useContext(AgentMarks);
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const [refusal, setRefusal] = createSignal<string | null>(null);
  let button!: HTMLButtonElement;
  // The menu closes before it runs an item, so Undo reads the mark and the button outside the popup's Show.
  const undo = () => {
    const mark = marks.mark(props.id);
    if (mark) void marks.undo(mark.seq).then(reason => { if (reason) { setRefusal(reason); setAnchor(button); } });
  };
  return <Show when={marks.mark(props.id)}>{mark => <>
    <Button ref={button} class="agent-mark" icon="agent" label="Changed by the agent" aria-haspopup="menu" aria-expanded={!!anchor()} onClick={() => setAnchor(value => value ? null : button)} />
    <Show when={anchor()}>{element => <Menu anchor={element()} label="Agent change" title="Agent change" context={mark().summary} caption={mark().summary} onDismiss={() => { setAnchor(null); setRefusal(null); }} items={[
      { label: 'Undo', icon: 'undo', disabledReason: refusal() ?? undefined, action: undo },
    ]} />}</Show>
  </>}</Show>;
}
