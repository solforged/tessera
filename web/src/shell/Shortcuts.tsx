import { createMemo, For, Show } from 'solid-js';
import type { Command, CommandRegistry } from './contract';
import { Popup } from '../ui/Popup';
import { cardOperators } from '../review/card-text';
import './shortcuts.css';

/** What can be written into a block. Operators come from the card parser so the sheet cannot drift from it. */
const syntax: { write: string; means: string }[] = [
  { write: '#tag', means: 'What this atom is. A new name makes a new tag.' },
  { write: '#task', means: 'A checkbox, status, schedule, deadline, priority and repeat.' },
  { write: '#question', means: 'A revisit date, criteria and assessments.' },
  { write: '#project', means: 'An outcome, deadline and active state.' },
  { write: '#source', means: 'A snapshot, reading state and citation key.' },
  { write: 'name:: value', means: 'A field on this atom. A name no field has makes one.' },
  { write: '>>  <<  <>  {{c1::…}}', means: `A card: ${(['>>', '<<', '<>'] as const).map(op => cardOperators[op].label).join(', ')}, cloze. Its tags are its decks. Also ${(['>>>', '>>1.', ';;'] as const).map(op => `${op} ${cardOperators[op].label}`).join(', ')}.` },
  { write: '@friday  @due monday', means: 'Schedule or deadline on this atom. It is not a task until it is tagged one.' },
  { write: '[[', means: 'A reference to another atom.' },
  { write: '((', means: 'A frozen quote of another atom.' },
  { write: '/', means: 'Everything else: tags, fields, task states, images, views.' },
];

const sections: Command['section'][] = ['Navigation', 'Create', 'Editing', 'Outline', 'Atom', 'Page', 'View', 'Vim', 'Go to'];

/** Keys and syntax on one sheet. Bindings are read from the command registry, so only mounted surfaces contribute. */
export function Shortcuts(props: { commands: CommandRegistry; onDismiss(): void }) {
  const groups = createMemo(() => {
    const bound = props.commands.list().filter(command => command.keys?.length);
    return sections.map(section => ({ section, commands: bound.filter(command => command.section === section) })).filter(group => group.commands.length);
  });
  const sheet = window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches;
  return <Popup anchor={document.body} placement={sheet ? 'sheet' : 'top'} width={820} fitContent class="shortcuts" label="Keys and syntax" onDismiss={props.onDismiss}>
    <header class="shortcuts-head"><h2 class="popup-title">Keys and syntax</h2><kbd>⌘/</kbd></header>
    <div class="shortcuts-columns">
      <section class="shortcuts-syntax" aria-label="Syntax">
        <h3 class="shortcuts-section">Write</h3>
        <dl><For each={syntax}>{row => <><dt><code>{row.write}</code></dt><dd>{row.means}</dd></>}</For></dl>
      </section>
      <section class="shortcuts-keys" aria-label="Keys">
        <h3 class="shortcuts-section">Press</h3>
        <For each={groups()}>{group => <>
          <h4 class="shortcuts-group">{group.section}</h4>
          <dl><For each={group.commands}>{command => <><dt><kbd>{command.keys!.join(' / ')}</kbd></dt><dd>{command.title}</dd></>}</For></dl>
        </>}</For>
        <Show when={!groups().some(group => group.section === 'Outline')}><p class="muted shortcuts-note">Open a page to see its outline keys.</p></Show>
      </section>
    </div>
  </Popup>;
}
