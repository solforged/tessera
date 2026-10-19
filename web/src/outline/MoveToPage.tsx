import { Show, createResource, createSignal } from 'solid-js';
import { Picker } from '../ui/Picker';
import { Icon } from '../ui/Icon';
import type { PopupAnchor } from '../ui/Popup';
import type { OutlineContext } from './context';
import { completeNames } from './names';

export function createMoveToPage(context: Pick<OutlineContext, 'props' | 'doc' | 'roots' | 'rowAnchor' | 'heading' | 'restoreFocus' | 'showNotice'>) {
  const [state, setState] = createSignal<{ ids: string[]; anchor: PopupAnchor }>();
  function openMoveToPage() {
    const ids = context.roots();
    if (ids.length) setState({ ids: [...ids], anchor: context.rowAnchor(ids[0]!) ?? context.heading });
  }
  function MoveToPagePopup() {
    return <Show keyed when={state()}>{current => {
      const [query, setQuery] = createSignal('');
      const [busy, setBusy] = createSignal(false);
      const [error, setError] = createSignal('');
      const [names] = createResource(() => [query(), context.props.notebook.roots()] as const,
        ([text, roots]) => completeNames(context.props.notebook, text, roots.filter(page => page.kind === 'page' && page.id !== context.props.pageId)));
      const dismiss = () => { if (!busy()) { setState(undefined); context.restoreFocus(); } };
      const pick = async (pageId: string, title: string) => {
        if (busy()) return;
        setBusy(true); setError('');
        try {
          const pending = context.props.notebook.moveBlocks(current.ids, pageId);
          let applied = true;
          const history = context.doc.rememberChange(pending.then(change => ({
            undo: async () => { await change.undo(); applied = false; },
            redo: async () => { await change.redo(); applied = true; },
          })));
          await pending;
          await context.doc.flush();
          setState(undefined);
          context.restoreFocus();
          if (applied) context.showNotice(`Moved to ${title}`, history.undo);
          else context.showNotice('Move undone');
        } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { setBusy(false); }
      };
      return <Picker anchor={current.anchor} label="Move to atom" query={query()} onQuery={setQuery} placeholder="Find a destination atom" items={names()?.rows ?? []} key={match => match.page.id}
        onDismiss={dismiss} onPick={match => { void pick(match.page.id, match.page.text); }} busy={names.loading || busy()} error={error() || (names.error ? String(names.error) : undefined)}
        empty="No matching atoms. Try another name." row={match => <><Icon name="note" /><span class="picker-text">{match.page.text}</span><Show when={match.alias}><span class="reference-via">via {match.alias}</span></Show></>} />;
    }}</Show>;
  }
  return { openMoveToPage, MoveToPagePopup };
}
