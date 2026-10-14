import { Show, createResource, createSignal } from 'solid-js';
import type { Block } from '../api/types';
import { Picker } from '../ui/Picker';
import type { PopupAnchor } from '../ui/Popup';
import { Icon } from '../ui/Icon';
import { BlockBreadcrumb, BlockText } from './BlockText';
import type { OutlineContext } from './context';
import { completeNames, plainText, resolveName } from './names';
import { changeHolderText, fileUnderText, positionLinks, usePlaceReason, usePlaceText } from './position-links';
import { createEntity, entityKinds, entityLabel, fileAsEntity } from './holders';
import type { EntityKind } from './holders';

type RelationAction = 'holder' | 'subject' | 'integrate' | 'reading';
interface Choice { block: Block; section: string; alias?: string | null; create?: EntityKind; file?: EntityKind }
const labels: Record<RelationAction, string> = { holder: 'Change holder', subject: 'File under', integrate: 'Integrate', reading: 'Who holds this?' };

/** The existing picker serves authored links and journal destinations; none are inferred from prose. */
export function createRelationActions(context: Pick<OutlineContext, 'doc' | 'props' | 'rowAnchor' | 'setMessage' | 'restoreFocus' | 'editor' | 'showNotice' | 'scheduleReport'>, onAddReading?: (holderId: string) => Promise<void>) {
  const { doc, props, rowAnchor, setMessage, restoreFocus, showNotice, scheduleReport } = context;
  const [state, setState] = createSignal<{ kind: RelationAction; id: string; anchor: PopupAnchor }>();
  function openRelation(id: string, kind: RelationAction, anchor = rowAnchor(id)) {
    if (anchor) setState({ id, kind, anchor });
  }
  const positionReason = (id: string) => !doc.block(id)?.position ? 'Select a perspective.' : undefined;
  const placeReason = (id: string) => positionReason(id) ?? usePlaceReason(doc.block(id)?.text ?? '');
  const write = async (id: string, text: string) => {
    const result = doc.edit({ kind: 'positionLinks', id, text });
    if (!result.ok) throw new Error(result.reason);
    if (context.editor?.id === id) context.editor.sync(text);
    await doc.flush();
    scheduleReport();
  };
  function usePlace(id: string) {
    void write(id, usePlaceText(doc.block(id)?.text ?? '')).catch(reason => setMessage(reason instanceof Error ? reason.message : String(reason)));
  }
  function RelationPopups() {
    return <Show keyed when={state()}>{current => {
      const [query, setQuery] = createSignal('');
      const [busy, setBusy] = createSignal(false);
      const [error, setError] = createSignal('');
      const holding = current.kind === 'holder' || current.kind === 'reading';
      const [preferred] = createResource(async () => {
        if (current.kind === 'integrate') return { ids: new Set<string>(), questions: [] as Block[] };
        // Holders are people and groups, refined types included, in one read.
        if (holding) return { ids: new Set(await props.notebook.api.entities()), questions: [] as Block[] };
        const [index, questions, directory, types] = await Promise.all([
          props.notebook.api.kindNotes('concept'),
          props.notebook.api.questions({}),
          props.notebook.api.noteIndex(),
          props.notebook.api.types(),
        ]);
        const ids = new Set(index.notes.map(note => note.id));
        const typeIds = new Set(types.map(type => type.page.id));
        const pending = directory.kinds.filter(kind => kind.key === 'concept').flatMap(kind => kind.type_id ? [kind.type_id] : []);
        const visited = new Set<string>();
        while (pending.length) {
          const typeId = pending.pop()!;
          if (visited.has(typeId)) continue;
          visited.add(typeId);
          for (const row of await props.notebook.api.members(typeId, 100000)) {
            if (row.block.kind !== 'page' || row.block.archived) continue;
            ids.add(row.block.id);
            if (typeIds.has(row.block.id)) pending.push(row.block.id);
          }
        }
        return { ids, questions: questions.map(row => row.block.block) };
      });
      const [choices] = createResource(() => [query(), preferred(), props.notebook.roots()] as const, async ([text, preferred, roots]): Promise<Choice[]> => {
        if (!preferred) return [];
        const names = await completeNames(props.notebook, text, roots);
        if (holding) {
          // Only people and groups hold perspectives: another page is offered for filing, a new name for creating.
          const people: Choice[] = names.rows.filter(({ page }) => preferred.ids.has(page.id)).map(({ page, alias }) => ({ block: page, alias, section: 'People and groups' }));
          const others = names.rows.filter(({ page }) => !preferred.ids.has(page.id)).slice(0, 3);
          const filing: Choice[] = others.flatMap(({ page, alias }) => entityKinds.map(kind => ({ block: page, alias, file: kind, section: 'File as a person or group' })));
          const creating: Choice[] = names.canCreate && text.trim() ? entityKinds.map(kind => ({ create: kind, section: 'Create', block: { id: `create-${kind}`, kind: 'page', parent_id: null, page_id: `create-${kind}`, text: text.trim(), heading: null, archived: false, revision: 0, created_at: 0, updated_at: 0, kept_copy: null } })) : [];
          return [...people, ...filing, ...creating];
        }
        const result: Choice[] = names.rows.map(({ page, alias }) => ({ block: page, alias, section: current.kind === 'integrate' ? 'Pages' : preferred.ids.has(page.id) ? 'Questions and concepts' : 'Pages' }));
        if (current.kind === 'subject') {
          // Question pages use the shared name resolver; inline questions use reference search below.
          const questions = new Set(preferred.questions.map(block => block.id));
          for (const choice of result) if (questions.has(choice.block.id)) choice.section = 'Questions and concepts';
          const matches = text.trim() ? await props.notebook.api.search(text, 100) : null;
          const ids = matches && new Set(matches.map(row => row.block.id));
          for (const block of preferred.questions) if (block.kind === 'block' && (!ids || ids.has(block.id))) result.push({ block, section: 'Questions and concepts' });
        } else if (current.kind === 'integrate' && text.trim()) {
          const found = await props.notebook.api.search(text, 100);
          for (const row of found) if (row.block.kind === 'block' && !row.block.archived) result.push({ block: row.block, section: 'Blocks' });
        }
        const sorted = result.sort((a, b) => Number(a.section === 'Pages' || a.section === 'Blocks') - Number(b.section === 'Pages' || b.section === 'Blocks') || Number(a.section === 'Blocks') - Number(b.section === 'Blocks'));
        return sorted;
      });
      const dismiss = () => { if (!busy()) { setState(undefined); restoreFocus(); } };
      const pick = async (choice: Choice) => {
        if (busy() || choices.loading || preferred.loading) return;
        setBusy(true); setError('');
        try {
          const holderId = !holding ? choice.block.id : choice.create ? await createEntity(props.notebook, choice.block.text, choice.create) : choice.block.id;
          if (choice.file) await fileAsEntity(props.notebook, holderId, choice.file);
          if (current.kind === 'reading') {
            await onAddReading?.(holderId);
            setState(undefined);
            return;
          }
          if (current.kind === 'integrate') {
            const change = await props.notebook.integrateBlock(current.id, choice.block.id);
            setState(undefined);
            showNotice(`Integrated into ${plainText(choice.block.text, target => props.notebook.lookup(target))}.`, change.undo);
          } else {
            if (!doc.block(current.id)?.position) throw new Error('This block is no longer a perspective.');
            let text = doc.block(current.id)!.text;
            if (current.kind === 'holder') {
              const alias = positionLinks(text)[0]?.alias;
              const keep = alias && (await resolveName(props.notebook, alias)).some(match => match.page.id === holderId);
              const latest = doc.block(current.id)!.text;
              text = changeHolderText(latest, holderId, keep && positionLinks(latest)[0]?.alias === alias ? alias : undefined);
            } else text = fileUnderText(text, choice.block.id);
            await write(current.id, text);
            setState(undefined); restoreFocus();
          }
        } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { setBusy(false); }
      };
      return <Picker<Choice> anchor={current.anchor} placement={window.matchMedia('(max-width: 600px)').matches ? 'sheet' : 'anchor'} label={labels[current.kind]} query={query()} onQuery={setQuery} placeholder={holding ? 'Find a person or group' : current.kind === 'subject' ? 'Find a question, concept or page' : 'Find a page or block'} items={choices() ?? []} key={choice => `${choice.block.id}:${choice.create ?? choice.file ?? ''}`} section={choice => choice.section} onDismiss={dismiss} onPick={choice => { void pick(choice); }} busy={choices.loading || preferred.loading || busy()} error={error() || (choices.error || preferred.error ? String(choices.error || preferred.error) : undefined)} empty="No matching destinations." disabledReason={choice => busy() ? 'Saving…' : choices.loading || preferred.loading ? 'Loading destinations…' : current.kind === 'integrate' && choice.block.id === current.id ? 'A block cannot move into itself.' : undefined}
        row={choice => <><Icon name={choice.create || choice.file ? 'plus' : choice.block.kind === 'block' ? 'bullet' : 'note'} /><span class="picker-text"><Show when={choice.create}>{kind => <>Create {entityLabel(kind())} “</>}</Show><Show when={choice.file}>File “</Show><BlockText text={choice.block.text} notebook={props.notebook} interactive={false} /><Show when={choice.create}>”</Show><Show when={choice.file}>{kind => <>” as {entityLabel(kind())}</>}</Show></span><Show when={choice.alias}><span class="reference-via">via {choice.alias}</span></Show><Show when={choice.block.kind === 'block'}><span class="picker-meta"><BlockBreadcrumb block={choice.block} notebook={props.notebook} /></span></Show></>} />;
    }}</Show>;
  }
  return { openRelation, positionReason, placeReason, usePlace, RelationPopups };
}
