import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import type { FieldDetail, Reading } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { Interpretation, InterpretationMap } from './commands';
import { Picker } from '../ui/Picker';
import { Button } from '../ui/Button';
import { kindLabels } from './kinds';
import { instancePages } from './instances';
import { completeNames } from '../outline/names';

export function readingLabel(reading: Reading): string {
  if (!reading.ok) return reading.problem;
  if (typeof reading.value !== 'object') return String(reading.value);
  return `${reading.value.from ?? '?'} to ${reading.value.through ?? '?'}`;
}

/** The same reviewed map serves Choice and the other field kind interpretations. */
export function ChoiceConversion(props: { detail: FieldDetail; mappings: InterpretationMap; notebook: NotebookClient; disabled?: boolean; onChange(mappings: InterpretationMap): void }) {
  const [picker, setPicker] = createSignal<{ anchor: HTMLElement; text: string }>();
  const [query, setQuery] = createSignal('');
  const [pages] = createResource(() => props.detail.kind === 'instance' && props.detail.field.targets, targets => instancePages(props.notebook, targets));
  const [matches] = createResource(() => picker() && pages() && { query: query(), pages: pages()! }, state => completeNames(props.notebook, state.query, state.pages));
  const group = (text: string, reading: Reading) => {
    const mapping = props.mappings[text];
    return mapping && mapping.mode !== 'keep' ? 'Mapped values' : reading.ok ? 'Readable as written' : 'Ambiguous or unreadable';
  };
  function change(text: string, mapping: Interpretation) { props.onChange({ ...props.mappings, [text]: mapping }); }
  return <section class="field-section" aria-label="Interpretation map">
    <h2 class="field-section-head">Interpretation map</h2>
    <p class="field-note">Review every written value before applying. Unmapped values stay as written.</p>
    <For each={['Mapped values', 'Readable as written', 'Ambiguous or unreadable']}>{heading => {
      const rows = createMemo(() => props.detail.interpretations.filter(row => group(row.text, row.reading) === heading));
      return <Show when={rows().length}><h3>{heading}</h3><table class="field-ledger field-interpretations"><thead><tr><th>Written value</th><th>Uses</th><th>Interpretation</th></tr></thead><tbody>
        <For each={rows()}>{row => {
          const mapping = () => props.mappings[row.text] ?? { mode: 'keep' as const };
          return <tr><td>{row.text}</td><td class="field-apparatus">{row.values.length}</td><td>
            <Show when={props.detail.kind === 'choice'} fallback={<Show when={props.detail.kind === 'instance'} fallback={<span classList={{ 'field-rubric': !row.reading.ok }}>{row.reading.ok ? readingLabel(row.reading) : `${readingLabel(row.reading)}; left as written`}</span>}>
              <span>{(() => { const value = mapping(); return value.mode === 'page' ? props.notebook.lookup(value.value)()?.text ?? value.value : value.mode === 'create' ? `Create atom: ${value.value}` : row.reading.ok ? readingLabel(row.reading) : 'No unique atom; left as written'; })()}</span>
              <Button disabled={props.disabled} onClick={event => { setQuery(''); setPicker({ anchor: event.currentTarget, text: row.text }); }}>Choose atom…</Button>
              <Button disabled={props.disabled} onClick={() => change(row.text, { mode: 'create', value: row.text.trim() })}>Create atom</Button>
              <Show when={mapping().mode !== 'keep'}><Button onClick={() => change(row.text, { mode: 'keep' })}>Leave as written</Button></Show>
            </Show>}>
              <label><input type="checkbox" checked={mapping().mode === 'option'} disabled={props.disabled} aria-label={`Map ${row.text}`} onChange={event => change(row.text, event.currentTarget.checked ? { mode: 'option', value: row.text.trim() } : { mode: 'keep' })} />Map to option</label>
              <Show when={mapping().mode === 'option'} fallback={<span class="field-note">Left as written</span>}><input class="input" list={`options-${props.detail.field.id}`} aria-label={`Option for ${row.text}`} value={(() => { const value = mapping(); return value.mode === 'option' ? value.value : ''; })()} disabled={props.disabled} onInput={event => change(row.text, { mode: 'option', value: event.currentTarget.value })} /></Show>
            </Show>
          </td></tr>;
        }}</For>
      </tbody></table></Show>;
    }}</For>
    <datalist id={`options-${props.detail.field.id}`}><For each={[...new Set([...props.detail.field.options.map(option => option.text), ...Object.values(props.mappings).flatMap(mapping => mapping.mode === 'option' ? [mapping.value] : [])])]}>{text => <option value={text} />}</For></datalist>
    <p class="field-note">{kindLabels[props.detail.kind]} readings change together, in one undo.</p>
    <Show when={picker()}>{state => <Picker anchor={state().anchor} label="Interpret as atom" placeholder="Atom name" query={query()} onQuery={setQuery} items={matches()?.rows ?? []} key={match => match.page.id} row={match => <>{match.page.text}<Show when={match.alias}><span class="reference-via">via {match.alias}</span></Show></>} onPick={match => { change(state().text, { mode: 'page', value: match.page.id }); setPicker(undefined); }} onDismiss={() => setPicker(undefined)} empty={pages.error || matches.error ? 'Could not load atoms.' : pages.loading || matches.loading ? 'Loading…' : 'No matching atoms.'} />}</Show>
  </section>;
}
