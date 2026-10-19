import { For, Show, createEffect, createMemo, createResource, createSignal, on, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import type { TaskState } from '../api/types';
import type { CaptureIntent, CaptureReceipt, NotebookClient } from '../document/contract';
import { openReferenceRange } from '../outline/completion';
import { completeNames, foldName } from '../outline/names';
import type { TitleTargets } from '../outline/link-titles';
import { completeTypes, typeSpelling, typeTokenAt } from '../outline/type-completion';
import { parseCardText } from '../review/card-text';
import { captureDateToken, dateSuggestions, insideProtectedSyntax, newTask, planDateToken } from '../tasks/quick-date';
import { relativeDate } from '../tasks/task-labels';
import { Icon } from '../ui/Icon';
import { Popup } from '../ui/Popup';
import './capture.css';

/** An open `[[page` or `#type` query in the draft, and the text a choice replaces. */
interface Token { kind: 'page' | 'type'; from: number; to: number; query: string }
interface Choice { title: string; id?: string; create?: boolean }

/** `[[` before the caret with no closing pair yet; the range runs on through a closing pair already typed. */
function pageTokenAt(text: string, caret: number): Token | null {
  const open = text.lastIndexOf('[[', caret - 2);
  if (open < 0 || /\]\]|[\r\n]/.test(text.slice(open + 2, caret)) || insideProtectedSyntax(text, open)) return null;
  return { kind: 'page', ...openReferenceRange(text, open, caret, false) };
}

export interface CaptureFieldProps {
  notebook: NotebookClient;
  /** The default schedule when `schedule` is set; typed dates such as `@today` count from the notebook's today. */
  contextDate(): string;
  /** Schedules a task with no date of its own on the context date, as Agenda's Today does. */
  schedule?: boolean;
  /** Every capture is a task; the kind toggle is hidden. */
  taskOnly?: boolean;
  initialTask?: boolean;
  initialText?: string;
  /** The slip owns kind selection and the draft across body switches. */
  fixedKind?: boolean;
  onTextChange?(text: string): void;
  targetPageId?: string;
  question?: boolean;
  label: string;
  placeholder: string;
  /** Called after a save; `again` is true for Shift+Enter, which keeps the field for the next item. */
  onSaved?(again: boolean, receipt: CaptureReceipt): void;
  /** Escape with no completion open. */
  onCancel?(): void;
  onTaskChange?(task: boolean): void;
  inputRef?(input: HTMLInputElement): void;
  /** Rendered after the field, before the preview, such as the sheet's footer. */
  children?: (state: { task: () => boolean; busy: () => boolean; submit(again: boolean): void }) => JSX.Element;
}

/**
 * One durable line. `[[` and `#` complete atoms and tags, `@` schedules, and Enter saves.
 */
export function CaptureField(props: CaptureFieldProps) {
  let input!: HTMLInputElement;
  let line!: HTMLDivElement;
  const [draft, setDraft] = createSignal(props.initialText ?? '');
  const [caret, setCaret] = createSignal(draft().length);
  const [task, setTask] = createSignal(!!props.initialTask);
  const [pending, setPending] = createSignal(0);
  const busy = () => pending() > 0;
  const [error, setError] = createSignal('');
  const [index, setIndex] = createSignal(0);
  // Escape closes a completion until the text changes.
  const [dismissed, setDismissed] = createSignal<string | null>(null);
  const picked: TitleTargets = new Map();
  const taskPrefix = createMemo(() => !props.fixedKind || props.taskOnly ? /^\[ ?\] /.exec(draft())?.[0] ?? '' : '');
  const bodyText = createMemo(() => draft().slice(taskPrefix().length).trim());
  const hasCards = createMemo(() => parseCardText(bodyText()).cards.length > 0);
  const isTask = () => !!props.taskOnly || !props.fixedKind && (task() || !!taskPrefix());
  createEffect(on(task, value => props.onTaskChange?.(value), { defer: true }));

  const token = createMemo<Token | null>(() => {
    const text = draft(), at = caret();
    if (dismissed() === text) return null;
    const type = typeTokenAt(text, at);
    return pageTokenAt(text, at) ?? (type && { kind: 'type', ...type });
  });
  const [choices] = createResource(() => token() && `${token()!.kind}:${token()!.query}`, async (key): Promise<Choice[]> => {
    const kind = key.slice(0, key.indexOf(':')), query = key.slice(key.indexOf(':') + 1);
    if (kind === 'type') {
      const result = await completeTypes(props.notebook, query);
      return [...result.rows.map(block => ({ title: block.text, id: block.id })), ...result.canCreate ? [{ title: query.trim(), create: true }] : []];
    }
    const result = await completeNames(props.notebook, query, props.notebook.roots());
    const rows: Choice[] = result.rows.map(({ page }) => ({ title: page.text, id: page.id }));
    const title = query.trim();
    return title && result.canCreate && !/^\d{4}-\d{2}-\d{2}$/.test(title) ? [...rows, { title, create: true }] : rows;
  });
  createEffect(on(() => token()?.query, () => setIndex(0)));
  const open = () => !!token() && !!choices()?.length;

  const plan = createMemo(() => {
    const text = bodyText();
    const found = captureDateToken(text, props.notebook.todayDate());
    if (!found) return null;
    // A plain-word date suffix plans only a task; an explicit @ can schedule any atom.
    const explicit = text[found.from] === '@';
    if (!explicit && !isTask()) return null;
    const choice = found.query ? dateSuggestions(found.query, props.notebook.todayDate())[0] : undefined;
    return { token: found, choice, explicit };
  });
  const preview = createMemo(() => {
    const state = plan();
    if (!state) return null;
    if (!state.choice) return { warning: true, label: `Not a date: ${bodyText().slice(state.token.from, state.token.to)} · it stays in the text` };
    const when = `${relativeDate(state.choice.date, props.notebook.todayDate())}${state.choice.time ? ` ${state.choice.time}` : ''}`;
    return { warning: false, label: `${state.token.field === 'deadline' ? `due ${when}` : when}` };
  });

  const replace = (from: number, to: number, insert: string) => {
    const text = draft();
    const next = text.slice(0, from) + insert + text.slice(to);
    setDraft(next);
    props.onTextChange?.(next);
    const at = from + insert.length;
    setCaret(at);
    queueMicrotask(() => { input.value = next; input.setSelectionRange(at, at); input.focus(); });
  };
  const choose = async (choice: Choice | undefined) => {
    const current = token();
    if (!current || !choice) return;
    let id = choice.id;
    if (choice.create && current.kind === 'page') {
      try { id = await props.notebook.createPage(choice.title); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return; }
    }
    if (current.kind === 'type') { replace(current.from, current.to, `${typeSpelling(choice.title, id || undefined)} `); return; }
    if (id) picked.set(foldName(choice.title), id);
    replace(current.from, current.to, `[[${choice.title}]]`);
  };

  // A submission owns its draft until IndexedDB accepts it; delivery then uses the notebook's durable queue.
  let accepting = false;
  const submit = async (again: boolean) => {
    const text = bodyText();
    if (!text || accepting) return;
    const submittedDraft = draft();
    const state = plan();
    let body = text, value: TaskState | null = null;
    if (state?.choice) ({ text: body, value } = planDateToken(text, state.token, state.choice, isTask() ? newTask('todo') : null));
    else if (isTask()) value = { ...newTask('todo'), scheduled: props.schedule ? props.contextDate() : null };
    const links = new Map(picked);
    accepting = true;
    setPending(count => count + 1); setError('');
    try {
      const receipt = await props.notebook.appendCapture(body.trim(), value, [...links], { targetPageId: props.targetPageId, question: props.question } satisfies Pick<CaptureIntent, 'targetPageId' | 'question'>);
      // Typing while the storage transaction finishes stays in the next line.
      const next = draft() === submittedDraft ? '' : draft().startsWith(submittedDraft) ? draft().slice(submittedDraft.length) : draft();
      if (next !== draft()) {
        picked.clear();
        setDraft(next); setCaret(next.length); input.value = next; input.setSelectionRange(next.length, next.length);
      }
      if (!props.taskOnly && !again && !next) setTask(false);
      props.onSaved?.(again, receipt);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      accepting = false;
      setPending(count => count - 1);
    }
  };

  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const count = choices()?.length ?? 0;
    if (open() && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setIndex(value => (value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
    } else if (open() && (event.key === 'Enter' && !event.metaKey && !event.ctrlKey || event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      void choose(choices()?.[index()]);
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit(event.shiftKey);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void submit(event.shiftKey);
    } else if (event.key === 'Backspace' && !props.taskOnly && task() && !draft() && input.selectionStart === 0 && input.selectionEnd === 0) {
      event.preventDefault();
      setTask(false);
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (token()) setDismissed(draft());
      else props.onCancel?.();
    }
  };
  const track = () => setCaret(input.selectionStart ?? input.value.length);
  const acceptInput = () => {
    const text = input.value;
    const prefix = /^\[ ?\] /.exec(text)?.[0] ?? '';
    const start = Math.max(0, (input.selectionStart ?? text.length) - prefix.length);
    const end = Math.max(0, (input.selectionEnd ?? text.length) - prefix.length);
    if (prefix && !props.fixedKind) {
      setTask(true);
      input.value = text.slice(prefix.length);
      input.setSelectionRange(start, end);
    }
    setDraft(input.value); track(); setError('');
    props.onTextChange?.(input.value);
  };
  onMount(() => { acceptInput(); props.inputRef?.(input); });

  return <div class="capture-field" classList={{ busy: busy() }}>
    <div ref={line} class="capture-line">
      <Show when={!props.taskOnly && !props.fixedKind} fallback={<Icon name={props.taskOnly ? 'select' : 'bullet'} />}>
        <button type="button" class="capture-kind" aria-pressed={task()} aria-label="Task" title="Task" onMouseDown={event => event.preventDefault()} onClick={() => setTask(value => !value)}>
          <Icon name={isTask() || plan()?.explicit && plan()?.choice ? 'select' : hasCards() ? 'card' : 'bullet'} />
        </button>
      </Show>
      <input ref={input} class="capture-input" aria-label={props.label} placeholder={props.placeholder} value={draft()} aria-busy={busy()} autocomplete="off" spellcheck
        role="combobox" aria-expanded={open()} aria-autocomplete="list"
        onInput={event => { if (event.isComposing) { setDraft(event.currentTarget.value); track(); } else acceptInput(); }} onCompositionEnd={acceptInput} onKeyDown={keydown} onKeyUp={track} onClick={track} onSelect={track} />
    </div>
    <Show when={open()}>
      <Popup anchor={line} role="listbox" label={token()?.kind === 'type' ? 'Tags' : 'Pages'} class="picker capture-choices" width={line.offsetWidth} autofocus={false} onDismiss={() => setDismissed(draft())}>
        <div class="picker-list" onMouseDown={event => event.preventDefault()}>
          <For each={choices()}>{(choice, row) =>
            <div role="option" aria-selected={index() === row()} class="picker-row" classList={{ selected: index() === row() }} onMouseEnter={() => setIndex(row())} onClick={() => { void choose(choice); }}>
              <Icon name={choice.create ? 'plus' : token()?.kind === 'type' ? 'tag' : 'page'} />
              <span class="picker-text">{choice.create ? `${token()?.kind === 'type' ? 'Create tag' : 'Create page'} “${choice.title}”` : choice.title}</span>
            </div>}</For>
        </div>
      </Popup>
    </Show>
    <Show when={preview()}>{state => <p class="capture-preview" classList={{ warning: state().warning }} role="status">{state().label}</p>}</Show>
    <Show when={error()}><p class="capture-error" role="alert">{error()}</p></Show>
    {props.children?.({ task: isTask, busy, submit: again => { void submit(again); } })}
  </div>;
}
