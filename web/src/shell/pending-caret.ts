import { EditorView } from '@codemirror/view';

/** One pending caret handoff, shared by action submission and shell navigation. */
function createPendingCaretInput() {
  let cancel = () => {};
  let bind: ((pane: string, blockId: string) => void) | undefined;
  const prepare = () => {
    cancel();
    let text = '', composing = false, disposed = false;
    let destination: { pane: string; blockId: string } | undefined;
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    const timer = setTimeout(() => stop(), 1500);
    const stop = () => {
      if (disposed) return;
      disposed = true;
      bind = undefined;
      clearTimeout(timer);
      controller.abort();
    };
    cancel = stop;
    const deliver = () => {
      const focused = document.activeElement;
      if (disposed || composing || !destination || !(focused instanceof HTMLElement)
        || !focused.matches('.cm-content') || focused.closest('[data-block-id]')?.getAttribute('data-block-id') !== destination.blockId
        || focused.closest('section.pane')?.getAttribute('data-pane') !== destination.pane) return;
      const view = EditorView.findFromDOM(focused);
      if (!view?.hasFocus) return;
      cancel();
      if (text) view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type' });
    };
    bind = (pane, blockId) => { destination = { pane, blockId }; queueMicrotask(deliver); };
    document.addEventListener('focusin', event => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !destination) return;
      if (target.matches('.cm-content') && target.closest('[data-block-id]')?.getAttribute('data-block-id') === destination.blockId
        && target.closest('section.pane')?.getAttribute('data-pane') === destination.pane) {
        // CM restores its requested selection after focusing during mount.
        queueMicrotask(deliver);
      }
    }, options);
    document.addEventListener('keydown', event => {
      if (disposed) return;
      if (event.target !== document.body && event.target !== document.documentElement) {
        // Popup teardown may restore an old editor briefly. Only actual input there cancels delivery.
        if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) cancel();
        return;
      }
      if (composing || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey
        || [...event.key].length !== 1) return;
      text += event.key;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, options);
    document.addEventListener('beforeinput', event => {
      if (disposed || event.target !== document.body && event.target !== document.documentElement
        || composing || event.isComposing || event.inputType !== 'insertText' || !event.data) return;
      text += event.data;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, options);
    document.addEventListener('compositionstart', () => { deliver(); composing = true; }, options);
    document.addEventListener('compositionend', () => { composing = false; queueMicrotask(deliver); }, options);
    document.addEventListener('pointerdown', () => cancel(), options);
    return stop;
  };
  return {
    prepare,
    cancel: () => cancel(),
    begin(pane: string, blockId: string) {
      if (!bind) prepare();
      const attach = bind!;
      bind = undefined;
      attach(pane, blockId);
    },
  };
}

export const pendingCaretInput = createPendingCaretInput();
