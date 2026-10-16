import { EditorView } from '@codemirror/view';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** One pending caret handoff, shared by action submission and shell navigation. */
function createPendingCaretInput() {
  let cancel = () => {};
  let bind: ((pane: string, blockId: string) => void) | undefined;
  const prepare = () => {
    cancel();
    let text = '', composing = false, disposed = false, accepting = true;
    let destination: { pane: string; blockId: string } | undefined;
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    // The operation owns captured input until focus or an explicit cancellation, never elapsed time.
    const stop = () => {
      if (disposed) return;
      disposed = true;
      bind = undefined;
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
    const backspace = () => {
      let last = 0;
      for (const part of graphemes.segment(text)) last = part.index;
      text = text.slice(0, last);
    };
    document.addEventListener('focusin', event => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (destination && target.matches('.cm-content') && target.closest('[data-block-id]')?.getAttribute('data-block-id') === destination.blockId
        && target.closest('section.pane')?.getAttribute('data-pane') === destination.pane) {
        // CM restores its requested selection after focusing during mount.
        queueMicrotask(deliver);
      } else if (target.closest('input, textarea, [contenteditable="true"]')) stop();
    }, options);
    window.addEventListener('keydown', event => {
      if (disposed) return;
      if (event.key === 'Escape') { stop(); return; }
      if (event.target !== document.body && event.target !== document.documentElement) {
        // An editable owns its own input; never capture or redirect it.
        if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) cancel();
        return;
      }
      if (!accepting || composing || event.isComposing || event.keyCode === 229) return;
      if (['Shift', 'Control', 'Meta', 'Alt', 'AltGraph', 'CapsLock'].includes(event.key)) return;
      if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey) backspace();
      else if (!event.ctrlKey && !event.metaKey && !event.altKey && [...event.key].length === 1) text += event.key;
      else {
        // Only plain text and Backspace can be buffered faithfully. An editing key or chord
        // seals intake: deliver the prefix at focus, but leave that key to native handling,
        // never replay it later against another selection or undo history.
        accepting = false;
        deliver();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    }, options);
    document.addEventListener('beforeinput', event => {
      if (disposed || !accepting || event.target !== document.body && event.target !== document.documentElement
        || composing || event.isComposing) return;
      if (event.inputType === 'deleteContentBackward') backspace();
      else if (event.inputType === 'insertText' && event.data) text += event.data;
      else { accepting = false; deliver(); return; }
      event.preventDefault();
      event.stopImmediatePropagation();
    }, options);
    document.addEventListener('compositionstart', () => { deliver(); composing = true; }, options);
    document.addEventListener('compositionend', () => { composing = false; queueMicrotask(deliver); }, options);
    document.addEventListener('pointerdown', () => cancel(), options);
    return Object.assign(stop, { signal: controller.signal });
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
