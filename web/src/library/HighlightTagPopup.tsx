import { Show, createSignal, onCleanup } from 'solid-js';
import type { PageDocument } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { documentReady } from '../tasks/JournalAgenda';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';

export function createHighlightTagPrompt() {
  const [target, setTarget] = createSignal<{ document: PageDocument; id: string; anchor: HTMLElement } | null>(null);
  let disposed = false;
  onCleanup(() => { disposed = true; });
  return {
    open(document: PageDocument, id: string) { setTarget({ document, id, anchor: window.document.activeElement as HTMLElement }); },
    TagPopup: () => <Show keyed when={target()}>{value => {
      const [tag, setTag] = createSignal('');
      const [busy, setBusy] = createSignal(false);
      const [error, setError] = createSignal('');
      const dismiss = () => setTarget(null);
      const submit = async () => {
        if (busy()) return;
        const input = tag().trim(), token = input.startsWith('#') ? input : `#${input}`;
        const tokens = textTokens(token), parsed = tokens[0];
        if (tokens.length !== 1 || parsed?.kind !== 'tag' || parsed.end !== token.length) { setError('Enter one tag.'); return; }
        setBusy(true); setError('');
        try {
          await documentReady(value.document);
          const block = value.document.block(value.id);
          if (!block) throw new Error('Highlight not found.');
          if (!textTokens(block.text).some(item => item.kind === 'tag' && item.value.toLowerCase() === parsed.value.toLowerCase())) {
            const result = value.document.edit({ kind: 'text', id: value.id, text: `${block.text} ${token}` });
            if (!result.ok) throw new Error(result.reason);
          }
          await value.document.flush();
          if (!disposed) dismiss();
        } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { if (!disposed) setBusy(false); }
      };
      return <Popup anchor={value.anchor} label="Add tag" placement="top" onDismiss={dismiss}>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <input class="input" aria-label="Tag" placeholder="#tag" value={tag()} disabled={busy()} onInput={event => setTag(event.currentTarget.value)} />
          <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
          <div class="popup-actions"><Button disabled={busy()} onClick={dismiss}>Cancel</Button><Button type="submit" class="bordered" disabled={busy() || !tag().trim()}>Add tag</Button></div>
        </form>
      </Popup>;
    }}</Show>,
  };
}
