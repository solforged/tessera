import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { formatSourceValue } from '../outline/source';
import type { SourceFieldValue } from './details';
import { metadataEqual, metadataText, metadataValues } from './metadata-values';
import { isoLanguageNames } from './languages';

const languages = Object.keys(isoLanguageNames).map(code => ({ code, name: formatSourceValue('language', code) })).sort((a, b) => a.name.localeCompare(b.name));
const states = [{ code: 'inbox', name: 'Inbox' }, { code: 'reading', name: 'Reading' }, { code: 'finished', name: 'Finished' }, { code: 'abandoned', name: 'Abandoned' }];

/** Clickable metadata becomes one input, keeping failed drafts local until corrected or escaped. */
export function MetadataField(props: {
  label: string;
  values: readonly SourceFieldValue[];
  scope?: string;
  placeholder?: string;
  voice?: 'title' | 'mono' | 'description';
  kind?: 'text' | 'lines' | 'language' | 'state';
  extracted?: SourceFieldValue;
  resetLabel?: string;
  disabled?: boolean;
  startEditing?: boolean;
  onCancel?(): void;
  hint?: JSX.Element;
  onSave(value: SourceFieldValue): Promise<void>;
  onError?(message: string): void;
}) {
  const id = createUniqueId();
  const [editing, setEditing] = createSignal(!!props.startEditing);
  const [draft, setDraft] = createSignal(props.startEditing ? metadataText(props.values[0] ?? '') : '');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [disclosed, setDisclosed] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [overflows, setOverflows] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [query, setQuery] = createSignal('');
  const aggregate = createMemo(() => metadataValues(props.values));
  const value = () => aggregate().mixed ? '' : metadataText(props.values[0] ?? '');
  const display = (text: string) => props.kind === 'language' ? formatSourceValue('language', text) : props.kind === 'state' ? states.find(state => state.code === text)?.name ?? text : text;
  const matches = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    const result = languages.filter(item => `${item.name} ${item.code}`.toLocaleLowerCase().includes(needle));
    if (/^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(needle) && !result.some(item => item.code === needle)) {
      const name = formatSourceValue('language', needle);
      if (name !== needle) result.push({ code: needle, name });
    }
    return [{ code: '', name: 'No language' }, ...result];
  });
  let trigger: HTMLButtonElement | undefined;
  let disposed = false;
  onCleanup(() => { disposed = true; props.onError?.(''); });
  const fail = (message: string) => { setError(message); props.onError?.(message); };
  const restoreFocus = () => { queueMicrotask(() => trigger?.focus({ preventScroll: true })); };
  const start = () => {
    setDraft(value()); setEditing(true); fail('');
  };
  const save = async (next: SourceFieldValue, returnFocus = false) => {
    if (busy() || props.disabled) return;
    setBusy(true); fail('');
    try {
      await props.onSave(next);
      if (disposed) return;
      setEditing(false); setAnchor(undefined);
      if (returnFocus) restoreFocus();
    } catch (reason) {
      if (!disposed) fail(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!disposed) setBusy(false); }
  };
  const commit = (returnFocus = false) => {
    if (!editing()) return;
    if (!aggregate().mixed && draft() === value()) { setEditing(false); fail(''); if (returnFocus) restoreFocus(); return; }
    void save(props.kind === 'lines' ? draft().split(/\r?\n/).map(text => text.trim()).filter(Boolean) : draft().trim(), returnFocus);
  };
  const cancel = () => { setEditing(false); fail(''); restoreFocus(); props.onCancel?.(); };
  const keydown: JSX.EventHandlerUnion<HTMLInputElement | HTMLTextAreaElement, KeyboardEvent> = event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); commit(true); }
  };
  const focus = (input: HTMLInputElement | HTMLTextAreaElement) => queueMicrotask(() => {
    if (!input.isConnected) return;
    input.focus(); input.setSelectionRange(input.value.length, input.value.length); input.scrollIntoView({ block: 'nearest' });
  });
  createEffect(() => {
    props.values; expanded();
    if (props.voice !== 'description' || editing() || !trigger) return;
    const element = trigger;
    const measure = () => {
      const style = getComputedStyle(element);
      setOverflows(element.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) > parseFloat(style.lineHeight) * 3 + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    onCleanup(() => observer.disconnect());
  });
  const summary = createMemo(() => `${aggregate().distinct.length} ${aggregate().distinct.length === 1 ? 'value' : 'values'}${aggregate().empty ? ` · ${aggregate().empty} empty` : ''}`);
  const resetAvailable = createMemo(() => props.extracted !== undefined && (editing() ? draft() !== metadataText(props.extracted) : props.values.some(item => !metadataEqual(item, props.extracted!))));
  return <div class={`metadata-field metadata-field-${props.voice ?? 'text'}`}>
    <span id={`${id}-label`} class="metadata-label">{props.label}</span>
    <div class="metadata-field-body">
      <Show when={aggregate().mixed && !editing()}>
        <Button class="metadata-mixed" aria-expanded={disclosed()} onClick={() => setDisclosed(value => !value)}>{summary()}<Icon name="down" /></Button>
        <Show when={disclosed()}><ul class="metadata-distinct"><For each={aggregate().distinct}>{entry => <li><span>{display(metadataText(entry.value))}</span><span>{entry.count} {entry.count === 1 ? 'source' : 'sources'}</span></li>}</For><Show when={aggregate().empty}><li><span>Empty</span><span>{aggregate().empty} sources</span></li></Show></ul></Show>
      </Show>
      <Show when={editing()} fallback={<>
        <Button ref={trigger} class={`metadata-value${!value() ? ' metadata-empty' : ''}${props.kind === 'language' || props.kind === 'state' ? ' bordered metadata-choice' : ''}${expanded() ? ' metadata-expanded' : ''}`} disabled={props.disabled || busy()} aria-labelledby={`${id}-label`} onClick={event => {
          if (props.kind === 'language' || props.kind === 'state') { setQuery(''); setAnchor(event.currentTarget); }
          else start();
        }}>{aggregate().mixed ? `Set ${props.label.toLocaleLowerCase()}…` : display(value()) || props.placeholder || `Add ${props.label.toLocaleLowerCase()}`}{(props.kind === 'language' || props.kind === 'state') && <Icon name="down" />}</Button>
        <Show when={props.voice === 'description' && value() && (overflows() || expanded())}><Button class="metadata-text-action" aria-expanded={expanded()} onClick={() => setExpanded(value => !value)}>{expanded() ? 'Less' : 'More'}</Button></Show>
      </>}>
        <Show when={props.kind === 'lines' || props.voice === 'description'} fallback={<input ref={focus} class="input metadata-input" aria-labelledby={`${id}-label`} aria-invalid={!!error()} aria-describedby={error() ? `${id}-error` : undefined} value={draft()} disabled={busy()} placeholder={props.placeholder} onInput={event => setDraft(event.currentTarget.value)} onBlur={() => commit()} onKeyDown={keydown} />}>
          <textarea ref={focus} class="input metadata-input" aria-labelledby={`${id}-label`} aria-invalid={!!error()} aria-describedby={error() ? `${id}-error` : undefined} value={draft()} disabled={busy()} rows={props.voice === 'description' ? 5 : 3} placeholder={props.placeholder} onInput={event => setDraft(event.currentTarget.value)} onBlur={() => commit()} onKeyDown={keydown} />
        </Show>
        <Show when={props.scope}><p class="metadata-hint">{props.scope}</p></Show>
        <Show when={props.kind === 'lines'}><p class="metadata-hint">One value per line. Shift+Enter adds a line.</p></Show>
      </Show>
      <Show when={resetAvailable()}><div class="metadata-reset"><Show when={editing()}><span>Extracted: {metadataText(props.extracted!) || 'Empty'}</span></Show><Button class="metadata-text-action" disabled={busy() || props.disabled} onPointerDown={event => event.preventDefault()} onClick={() => { setDraft(metadataText(props.extracted!)); void save(props.extracted!, true); }}>{props.resetLabel ?? 'Reset to extracted'}</Button></div></Show>
      {props.hint}
      <Show when={error()}><p id={`${id}-error`} class="metadata-error" role="alert">{error()} This field was not saved.</p></Show>
      <Show when={anchor()}>{element => <Show when={props.kind === 'language'} fallback={<Menu anchor={element()} class="metadata-popup" label="Reading state" onDismiss={() => setAnchor(undefined)} header={<Show when={props.scope}><p class="metadata-hint metadata-menu-scope">{props.scope}</p></Show>} items={states.map(state => ({ label: state.name, checked: value() === state.code, action: () => { void save(state.code); } }))} />}>
        <Picker anchor={element()} class="metadata-popup" width={280} label="Find a language" placeholder="Find a language" query={query()} onQuery={setQuery} items={matches()} key={item => item.code} empty="No matching languages." onDismiss={() => setAnchor(undefined)} status={<Show when={props.scope}><p class="metadata-hint metadata-menu-scope">{props.scope}</p></Show>} row={item => <><span class="picker-text">{item.name}</span><span class="metadata-code">{item.code}</span><Show when={item.code === value()}><Icon name="check" /></Show></>} onPick={item => { void save(item.code); }} />
      </Show>}</Show>
    </div>
  </div>;
}
