import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { api } from '../api/client';
import type { ProviderInput, ProviderView } from '../api/types';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import './agent.css';

type Protocol = ProviderView['protocol'];
interface Draft { id?: string; name: string; protocol: Protocol; base_url: string; model: string; api_key: string; has_key: boolean; clearKey: boolean }

/** Where common providers listen; each fills the form and leaves the model to the user. */
const presets: { label: string; protocol: Protocol; base_url: string; key: boolean }[] = [
  { label: 'Anthropic', protocol: 'anthropic', base_url: 'https://api.anthropic.com', key: true },
  { label: 'OpenAI', protocol: 'openai', base_url: 'https://api.openai.com/v1', key: true },
  { label: 'OpenRouter', protocol: 'openai', base_url: 'https://openrouter.ai/api/v1', key: true },
  { label: 'Ollama', protocol: 'openai', base_url: 'http://127.0.0.1:11434/v1', key: false },
  { label: 'llama-server', protocol: 'openai', base_url: 'http://127.0.0.1:8080/v1', key: false },
];
const protocolLabels: Record<Protocol, string> = { anthropic: 'Anthropic', openai: 'OpenAI-compatible' };
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/** Settings › Agent: the models the agent dock can use, with keys kept on this machine. */
export function AgentSettings(props: { id: string; heading: JSX.Element }) {
  const [saved, { mutate }] = createResource(() => api.agentProviders());
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [tested, setTested] = createSignal<Record<string, string>>({});
  const [validated, setValidated] = createSignal(false);
  const [protocolAnchor, setProtocolAnchor] = createSignal<HTMLElement | null>(null);
  let formElement!: HTMLFormElement;
  const fieldErrors = createMemo(() => {
    const errors: Partial<Record<'name' | 'base_url' | 'model', string>> = {};
    const value = draft();
    if (!validated() || !value) return errors;
    if (!value.name.trim()) errors.name = 'Enter a name.';
    if (!value.base_url.trim()) errors.base_url = 'Enter an address.';
    else {
      try {
        const url = new URL(value.base_url.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') errors.base_url = 'Use an http:// or https:// address.';
      } catch { errors.base_url = 'Use an http:// or https:// address.'; }
    }
    if (!value.model.trim()) errors.model = 'Enter a model name.';
    return errors;
  });
  const inputs = (except?: string): ProviderInput[] => (saved()?.providers ?? []).filter(item => item.id !== except)
    .map(({ id, name, protocol, base_url, model }) => ({ id, name, protocol, base_url, model }));
  const save = async (providers: ProviderInput[], fallback: string | null) => {
    setBusy(true); setError('');
    try {
      const next = await api.saveAgentProviders({ providers, default: fallback });
      mutate(next);
      return true;
    } catch (reason) { setError(message(reason)); return false; }
    finally { setBusy(false); }
  };
  const submit = async () => {
    const value = draft(); if (!value) return;
    if (busy()) return;
    setValidated(true);
    if (Object.keys(fieldErrors()).length) {
      queueMicrotask(() => formElement.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    const key = value.clearKey ? '' : value.api_key.trim() || null;
    const entry: ProviderInput = { ...(value.id ? { id: value.id } : {}), name: value.name.trim(), protocol: value.protocol, base_url: value.base_url.trim(), model: value.model.trim(), api_key: key };
    const list = saved()?.providers ?? [];
    const providers = value.id ? inputs().map(item => item.id === value.id ? entry : item) : [...inputs(), entry];
    if (await save(providers, saved()?.default ?? (list.length ? list[0]!.id : null))) setDraft(null);
  };
  const remove = (provider: ProviderView) => {
    const rest = inputs(provider.id);
    void save(rest, saved()?.default === provider.id ? rest[0]?.id ?? null : saved()?.default ?? null);
  };
  // The dock uses the default, else the first model; with one model there is nothing to choose.
  const several = () => (saved()?.providers.length ?? 0) > 1;
  const isDefault = (id: string) => (saved()?.default ?? saved()?.providers[0]?.id) === id;
  const test = async (provider: ProviderView) => {
    setTested(values => ({ ...values, [provider.id]: 'Testing…' }));
    try { await api.testAgentProvider(provider.id); setTested(values => ({ ...values, [provider.id]: 'Answered' })); }
    catch (reason) { setTested(values => ({ ...values, [provider.id]: message(reason) })); }
  };
  const edit = (provider?: ProviderView) => {
    setValidated(false); setProtocolAnchor(null); setError('');
    setDraft(provider
      ? { id: provider.id, name: provider.name, protocol: provider.protocol, base_url: provider.base_url, model: provider.model, api_key: '', has_key: provider.has_key, clearKey: false }
      : { name: 'Anthropic', protocol: 'anthropic', base_url: presets[0]!.base_url, model: '', api_key: '', has_key: false, clearKey: false });
  };
  const update = (patch: Partial<Draft>) => setDraft(value => value && { ...value, ...patch });

  const Form = (form: { value: Draft }) => <form ref={formElement} class="agent-provider-form" noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
    <Show when={!form.value.id}><div class="agent-presets" role="group" aria-label="Fill in a provider">
      <For each={presets}>{preset => <Button class="bordered" aria-pressed={form.value.base_url === preset.base_url} onClick={() => update({ name: preset.label, protocol: preset.protocol, base_url: preset.base_url })}>{preset.label}</Button>}</For>
    </div></Show>
    <label><span>Name</span><span class="agent-input-field"><input class="input" value={form.value.name} onInput={event => update({ name: event.currentTarget.value })} required aria-invalid={!!fieldErrors().name} aria-describedby={fieldErrors().name ? `${props.id}-name-error` : undefined} />
      <Show when={fieldErrors().name}>{error => <span class="error agent-field-error" id={`${props.id}-name-error`} role="alert">{error()}</span>}</Show>
    </span></label>
    <label><span id={`${props.id}-protocol-label`}>Speaks</span><span class="agent-input-field">
      <Button class="bordered agent-protocol" aria-labelledby={`${props.id}-protocol-label`} aria-haspopup="menu" aria-expanded={protocolAnchor() !== null} onClick={event => setProtocolAnchor(event.currentTarget)}><span>{protocolLabels[form.value.protocol]}</span><Icon name="down" /></Button>
      <Show when={protocolAnchor()}>{anchor => <Menu anchor={anchor()} label="Protocol" onDismiss={() => setProtocolAnchor(null)} items={(Object.keys(protocolLabels) as Protocol[]).map(protocol => ({
        label: protocolLabels[protocol], checked: form.value.protocol === protocol, action: () => update({ protocol }),
      }))} />}</Show>
    </span></label>
    <label><span>Address</span><span class="agent-input-field"><input class="input settings-mono" type="url" value={form.value.base_url} onInput={event => update({ base_url: event.currentTarget.value })} required aria-invalid={!!fieldErrors().base_url} aria-describedby={fieldErrors().base_url ? `${props.id}-address-error` : undefined} />
      <Show when={fieldErrors().base_url}>{error => <span class="error agent-field-error" id={`${props.id}-address-error`} role="alert">{error()}</span>}</Show>
    </span></label>
    <label><span>Model</span><span class="agent-input-field"><input class="input settings-mono" value={form.value.model} placeholder="As the provider names it" onInput={event => update({ model: event.currentTarget.value })} required aria-invalid={!!fieldErrors().model} aria-describedby={fieldErrors().model ? `${props.id}-model-error` : undefined} />
      <Show when={fieldErrors().model}>{error => <span class="error agent-field-error" id={`${props.id}-model-error`} role="alert">{error()}</span>}</Show>
    </span></label>
    <label><span>Key</span><input class="input settings-mono" type="password" autocomplete="off" value={form.value.api_key} disabled={form.value.clearKey}
      placeholder={form.value.has_key && !form.value.clearKey ? 'Saved; type to replace it' : form.value.protocol === 'openai' ? 'Not needed for a local server' : 'Your API key'}
      onInput={event => update({ api_key: event.currentTarget.value })} /></label>
    <Show when={form.value.has_key}><label class="agent-clear-key"><input type="checkbox" checked={form.value.clearKey} onChange={event => update({ clearKey: event.currentTarget.checked, api_key: '' })} /><span>Forget the saved key</span></label></Show>
    <div class="agent-form-actions">
      <Button class="text-button" onClick={() => { setProtocolAnchor(null); setDraft(null); }}>Cancel</Button>
      <Button class="bordered" type="submit" disabled={busy()}>Save model</Button>
    </div>
  </form>;

  return <section id={props.id} aria-labelledby={`${props.id}-heading`} aria-busy={busy()}>
    {props.heading}
    <p class="settings-empty">The agent dock talks to a model you choose: a hosted one with your own key, or one running on this machine. Models and keys are kept on this machine, outside the workshop and its backups.</p>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={saved.error}><p class="error" role="alert">{message(saved.error)}</p></Show>
    <For each={saved()?.providers}>{provider => <Show when={draft()?.id !== provider.id} fallback={<Form value={draft()!} />}>
      <div class="settings-row agent-provider-row">
        <div class="settings-label">
          <span class="settings-name">{provider.name}<Show when={several() && isDefault(provider.id)}><span class="settings-scope">Default</span></Show></span>
          <p class="settings-mono">{protocolLabels[provider.protocol]} · {provider.model} · {provider.has_key ? 'key saved' : 'no key'}</p>
          <p class="settings-mono agent-provider-address">{provider.base_url}</p>
          <Show when={tested()[provider.id]}>{result => <p role="status" classList={{ error: result() !== 'Answered' && result() !== 'Testing…' }}>{result()}</p>}</Show>
        </div>
        <div class="agent-provider-actions">
          <Show when={several() && !isDefault(provider.id)}><Button class="text-button" disabled={busy()} onClick={() => { void save(inputs(), provider.id); }}>Make default</Button></Show>
          <Button class="text-button" onClick={() => { void test(provider); }}>Test</Button>
          <Button class="text-button" onClick={() => edit(provider)}>Edit</Button>
          <Button class="text-button" disabled={busy()} onClick={() => remove(provider)}>Remove</Button>
        </div>
      </div>
    </Show>}</For>
    <Show when={draft() && !draft()!.id} fallback={<Show when={!draft()}><Button class="bordered agent-add-model" icon="plus" onClick={() => edit()}>Add model</Button></Show>}>
      <Form value={draft()!} />
    </Show>
  </section>;
}
