import { createSignal } from 'solid-js';
import type { Command, CommandRegistry } from './contract';

/** Registrations are owned by mounted panes and replaced atomically on cleanup. */
export function createCommandRegistry(): CommandRegistry {
  const groups = new Map<symbol, Command[]>();
  const [commands, setCommands] = createSignal<readonly Command[]>([]);
  return {
    register(items) {
      const owner = Symbol('commands');
      groups.set(owner, items);
      setCommands([...groups.values()].flat());
      return () => {
        groups.delete(owner);
        setCommands([...groups.values()].flat());
      };
    },
    list: commands,
  };
}
