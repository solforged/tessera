import { For, Match, Show, Switch, createEffect, createResource, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { ContextRef, ProviderView } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { resolveName } from '../outline/names';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { AgentSession, AssistantPart, DockMessage } from './session';
import './agent.css';

/** A page the agent reads: one per visible pane, plus links dragged into the dock. */
export interface ContextChip { key: string; ref: ContextRef; title: string; extra: boolean }

const PROVIDER_KEY = 'tessera.agent.provider';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Models often cite pages by title; a title that names exactly one page becomes its link, as an id reference would. */
function AgentText(props: { text: string; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void }) {
  const [resolved] = createResource(() => [props.text, props.notebook.changeSequence()] as const, async ([text]) => {
    const names = [...new Set([...text.matchAll(/\[\[([^[\]|]+)\]\]/g)].map(match => match[1]!.trim()).filter(name => !ULID.test(name)))];
    if (!names.length) return text;
    const ids = new Map(await Promise.all(names.map(async name => {
      const matches = await resolveName(props.notebook, name).catch(() => []);
      return [name, matches.length === 1 ? matches[0]!.page.id : null] as const;
    })));
    return text.replace(/\[\[([^[\]|]+)\]\]/g, (whole, name: string) => { const id = ids.get(name.trim()); return id ? `[[${id}]]` : whole; });
  });
  return <BlockText text={resolved.latest ?? props.text} notebook={props.notebook} onOpen={props.onOpen} />;
}

/**
 * The agent dock stands right of the pane row, so opening beside never pushes it away. It reads the pages in view,
 * talks to the model the user connected in Settings, and lists each change it makes with Show and Undo.
 */
export function AgentDock(props: {
  notebook: NotebookClient;
  session: AgentSession;
  chips: ContextChip[];
  excluded: ReadonlySet<string>;
  onToggleChip(key: string): void;
  onRemoveChip(key: string): void;
  onShow(pageId: string, blockId?: string): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onSettings(): void;
  onClose(): void;
}) {
  const [providers, { refetch }] = createResource(() => props.notebook.api.agentProviders());
  const [chosen, setChosen] = createSignal(localStorage.getItem(PROVIDER_KEY));
  const provider = (): ProviderView | undefined => {
    const list = providers()?.providers ?? [];
    return list.find(item => item.id === chosen()) ?? list.find(item => item.id === providers()?.default) ?? list[0];
  };
  const choose = (id: string) => { setChosen(id); try { localStorage.setItem(PROVIDER_KEY, id); } catch { /* The choice holds for this tab. */ } };
  const [menu, setMenu] = createSignal<HTMLElement | null>(null);
  const [draft, setDraft] = createSignal('');
  const [refusals, setRefusals] = createSignal<Record<number, string>>({});
  const included = () => props.chips.filter(chip => !props.excluded.has(chip.key));
  let thread!: HTMLDivElement;
  let composer!: HTMLTextAreaElement;
  onMount(() => composer.focus({ preventScroll: true }));
  // Providers may change in Settings, often in another window.
  const refresh = () => { void refetch(); };
  window.addEventListener('focus', refresh);
  onCleanup(() => window.removeEventListener('focus', refresh));
  // The thread follows new text while the reader is at its end, and stays put when they scrolled back.
  let pinned = true;
  createEffect(on(() => props.session.messages(), () => { if (pinned) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; }); }));
  const send = () => {
    const prompt = draft().trim(), current = provider();
    if (!prompt || !current || props.session.running()) return;
    props.session.send(prompt, current.id, included().map(chip => chip.ref));
    setDraft('');
    pinned = true;
  };
  const undo = async (seq: number) => {
    const refusal = await props.session.undo(seq);
    setRefusals(values => { const { [seq]: _, ...rest } = values; return refusal ? { ...rest, [seq]: refusal } : rest; });
  };
  const pageTitle = (id: string | null) => (id && props.notebook.lookup(id)()?.text) || 'Workshop';

  const Part = (part: AssistantPart) => <Switch>
    <Match when={part.kind === 'text' && part}>{text => <For each={text().text.split(/\n{2,}/).filter(paragraph => paragraph.trim())}>{paragraph =>
      <p class="agent-text"><AgentText text={paragraph.trim()} notebook={props.notebook} onOpen={props.onOpen} /></p>}</For>}</Match>
    <Match when={part.kind === 'tool' && part}>{tool => <p class="agent-tool">{tool().summary}</p>}</Match>
    <Match when={part.kind === 'edit' && part}>{edit => <div class="agent-edit" classList={{ undone: edit().undone }}>
      <p class="agent-edit-page">{pageTitle(edit().page)}</p>
      <p class="agent-edit-summary">{edit().summary}</p>
      <div class="agent-edit-actions">
        <Show when={!edit().undone} fallback={<span class="agent-edit-undone">Undone</span>}>
          <Show when={edit().page}>{page => <Button class="text-button" onClick={() => props.onShow(page(), edit().blocks[0])}>Show</Button>}</Show>
          <Button class="text-button" onClick={() => { void undo(edit().seq); }}>Undo</Button>
        </Show>
      </div>
      <Show when={refusals()[edit().seq]}>{reason => <p class="agent-edit-refusal" role="status">{reason()}</p>}</Show>
    </div>}</Match>
  </Switch>;

  const Message = (message: DockMessage) => <Show when={message.role === 'assistant' && message} fallback={
    <div class="agent-message agent-message-user"><p class="agent-who">You</p><div class="agent-body">{(message as Extract<DockMessage, { role: 'user' }>).text}</div></div>
  }>{assistant => <div class="agent-message">
    <p class="agent-who">Agent</p>
    <For each={assistant().parts}>{part => <Part {...part} />}</For>
    <Switch>
      <Match when={assistant().status === 'running' && !assistant().parts.some(part => part.kind === 'text')}><p class="agent-status" role="status">Working…</p></Match>
      <Match when={assistant().status === 'cancelled'}><p class="agent-status">Stopped</p></Match>
      <Match when={assistant().status === 'limit'}><p class="agent-status">Stopped after 12 steps</p></Match>
      <Match when={assistant().status === 'error'}><p class="agent-status agent-error" role="alert">{assistant().error ?? 'The model did not answer.'}</p></Match>
    </Switch>
  </div>}</Show>;

  return <aside class="agent-dock" aria-label="Agent">
    <header class="agent-head">
      <Icon class="agent-glyph" name="agent" />
      <h2>Agent</h2>
      <Show when={provider()}>{current => <Button class="agent-provider" title={`${current().name} · ${current().model}`} aria-haspopup="menu" aria-expanded={!!menu()}
        onClick={event => { void refetch(); setMenu(value => value ? null : event.currentTarget); }}><span>{current().name}</span><Icon name="down" /></Button>}</Show>
      <Button class="agent-close" icon="close" label="Hide agent" shortcut="⌃⇧A" onClick={props.onClose} />
    </header>
    <Show when={menu()}>{anchor => <Menu anchor={anchor()} label="Model" onDismiss={() => setMenu(null)} items={[
      ...(providers()?.providers ?? []).map(item => ({ label: item.name, secondary: item.model, checked: item.id === provider()?.id, action: () => choose(item.id) })),
      { label: 'Agent settings…', icon: 'settings' as const, divider: true, action: props.onSettings },
    ]} />}</Show>
    <div class="agent-context">
      <p class="agent-context-label">{included().length ? `Reads ${included().length} ${included().length === 1 ? 'page' : 'pages'}` : 'Reads nothing in view'} · drag links here to add</p>
      <For each={props.chips}>{chip => <span class="agent-chip" classList={{ excluded: props.excluded.has(chip.key) }} title={chip.title}>
        <span class="agent-chip-title">{chip.title}</span>
        <Show when={chip.extra} fallback={<Button icon={props.excluded.has(chip.key) ? 'plus' : 'close'} label={`${props.excluded.has(chip.key) ? 'Include' : 'Leave out'} ${chip.title}`} onClick={() => props.onToggleChip(chip.key)} />}>
          <Button icon="close" label={`Remove ${chip.title}`} onClick={() => props.onRemoveChip(chip.key)} />
        </Show>
      </span>}</For>
    </div>
    <div ref={thread} class="agent-thread" onScroll={() => { pinned = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24; }}>
      <Show when={props.session.messages().length} fallback={<Show when={!providers.loading}>
        <Show when={provider()} fallback={<div class="agent-empty">
          <h3>Connect a model</h3>
          <p>The agent uses a model you choose: a hosted one with your own key, or one running on this machine. Keys stay on this machine.</p>
          <Button class="bordered" icon="settings" onClick={props.onSettings}>Agent settings</Button>
        </div>}>
          <div class="agent-empty"><p>Ask about the pages in view, or ask for a change. Edits land in the panes, marked, and each one can be undone.</p></div>
        </Show>
      </Show>}>
        <For each={props.session.messages()}>{message => <Message {...message} />}</For>
      </Show>
    </div>
    <form class="agent-composer" onSubmit={event => { event.preventDefault(); send(); }}>
      <textarea ref={composer} class="input" rows={3} aria-label="Message the agent" placeholder="Ask about these notes, or ask for a change…" value={draft()} disabled={!provider()}
        onInput={event => setDraft(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } }} />
      <div class="agent-composer-foot">
        <Show when={props.session.messages().length && !props.session.running()}><Button class="text-button" onClick={() => props.session.clear()}>Clear</Button></Show>
        <Show when={props.session.running()} fallback={<Button class="agent-send" type="submit" shortcut="↵" disabled={!draft().trim() || !provider()}>Send</Button>}>
          <Button class="agent-send" onClick={() => props.session.stop()}>Stop</Button>
        </Show>
      </div>
    </form>
  </aside>;
}
