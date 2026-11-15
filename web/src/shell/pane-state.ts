import { copyTaskQuery } from '../tasks/query';
import { copyQuery } from '../table/query';
import type { HistoryEntry, OpenTarget, PaneView, ViewState } from './contract';

export type VimMode = 'insert' | 'normal' | 'visual' | 'outline' | null;

/** Views are snapshots: fold arrays and caret/scroll objects never alias history. */
export function copyView(view: ViewState): ViewState {
  return {
    ...view,
    folds: view.folds ? [...view.folds] : null,
    caret: view.caret ? { ...view.caret } : null,
    scroll: view.scroll ? { ...view.scroll } : null,
    readDisclosures: view.readDisclosures ? [...view.readDisclosures] : undefined,
    compare: view.compare
      ? { ...view.compare, chosen: view.compare.chosen ? [...view.compare.chosen] : view.compare.chosen }
      : undefined,
  };
}

export function pageIdOf(current: HistoryEntry | undefined): string | undefined {
  return current?.target.kind === 'page' ? current.target.pageId : undefined;
}
/** Header and tab text for panes that are not pages. */
export function paneLabel(target: OpenTarget | undefined): string {
  if (target?.kind === 'field') return 'Fields';
  if (target?.kind === 'cards') return 'Cards';
  if (target?.kind === 'spread') return 'Spread';
  if (target?.kind === 'revisits') return 'Revisits';
  if (target?.kind === 'directory') return 'Index';
  if (target?.kind === 'table' && target.query.layout === 'desk') return 'Research desk';
  // Unfiled leaves the index once nothing is filed there; the pane that stays open still names itself.
  if (target?.kind === 'index' && target.key === 'unfiled') return 'Unfiled';
  return target?.kind === 'table'
    ? 'Table'
    : target?.kind === 'fields'
      ? 'Fields'
      : target?.kind === 'settings'
        ? 'Settings'
        : target?.kind === 'history'
          ? 'History'
          : target?.kind === 'agenda'
            ? 'Agenda'
            : target?.kind === 'review'
              ? 'Review'
              : target?.kind === 'library'
                ? 'Library'
                : target?.kind === 'reader'
                  ? 'Reader'
                  : target?.kind === 'compare'
                    ? 'Compare'
                    : target?.kind === 'index'
                      ? 'Index'
                      : 'Loading…';
}
export function snapshotView(view: PaneView): PaneView {
  if ('mode' in view) return { ...view, query: copyTaskQuery(view.query) };
  if ('deckId' in view) return { ...view, selection: view.selection ?? null };
  if ('comparison' in view) return { ...view, chosen: view.chosen ? [...view.chosen] : null };
  // Library views saved before Browse lack filters and grouping.
  if ('tab' in view)
    return {
      ...view,
      view: view.view ?? null,
      colors: [...(view.colors ?? [])],
      tags: [...(view.tags ?? [])],
      group: view.group ?? 'none',
      filters: {
        people: [...(view.filters?.people ?? [])],
        decades: [...(view.filters?.decades ?? [])],
        years: [...(view.filters?.years ?? [])],
        publishers: [...(view.filters?.publishers ?? [])],
        languages: [...(view.filters?.languages ?? [])],
      },
    };
  if ('ordinal' in view) return { ...view };
  if ('revisitId' in view) return { ...view };
  if ('noteQuery' in view) return { ...view, noteQuery: view.noteQuery ? copyQuery(view.noteQuery) : undefined };
  return 'query' in view
    ? { ...view, query: copyQuery(view.query), hiddenFields: view.hiddenFields ? [...view.hiddenFields] : undefined }
    : 'zoom' in view
      ? copyView(view)
      : { scroll: view.scroll };
}
