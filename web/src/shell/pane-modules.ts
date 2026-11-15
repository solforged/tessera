// Panes other than the outline load on demand and are prefetched once the app is idle.
export const paneModules = {
  table: () => import('../table/TablePane'),
  fields: () => import('../fields/FieldsPane'),
  field: () => import('../fields/FieldPane'),
  cards: () => import('../fields/CardTemplatesPane'),
  settings: () => import('../settings/SettingsPane'),
  history: () => import('../settings/HistoryPane'),
  agenda: () => import('../tasks/AgendaPane'),
  review: () => import('../review/ReviewPane'),
  revisits: () => import('../review/NotesReview'),
  library: () => import('../library/LibraryPane'),
  reader: () => import('../reader/ReaderPane'),
  compare: () => import('../compare/ComparePane'),
  index: () => import('../notes/IndexPane'),
  spread: () => import('../notes/SpreadPane'),
};
