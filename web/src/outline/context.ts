import type { Accessor, JSX, Resource, Setter } from 'solid-js';
import type { Virtualizer } from '@tanstack/solid-virtual';
import type { EditorView } from '@codemirror/view';
import type { FieldDefinition, Fields, RelationKind, TaskState, TaskStatus } from '../api/types';
import type { Edit, EditResult, PageDocument, TextRange } from '../document/contract';
import type { Caret, Command, Depth } from '../core/contract';
import type { OutlinePaneProps } from './contract';
import type { MenuItem } from '../ui/Menu';
import type { PaneEditor } from './editor';
import type { CapabilityKind, CapabilityPopup } from './capabilities';
import type { FieldEntryConversion } from './source-fields';
import type { PopupAnchor } from '../ui/Popup';
import type { Completion } from './completions';

export interface RowRange {
  anchor: string;
  head: string;
}

/** `title` and `context` head a desktop menu; a phone pull-down has no head, so `caption` says in one line what its rows decide. */
export interface MenuState {
  anchor: HTMLElement;
  items: MenuItem[];
  label: string;
  title?: string;
  context?: JSX.Element;
  caption?: JSX.Element;
  header?: JSX.Element;
}

/** Operations consumed by outline controls; the capability factory owns their state. */
export interface OutlineCapabilityActions {
  popup: Accessor<CapabilityPopup | null>;
  busy(id: string): boolean;
  error(id: string): string;
  failure(id: string, reason: unknown): void;
  run(id: string, operation: () => Promise<void>): Promise<void>;
  save(intent: Edit): Promise<void>;
  edit(id: string, intent: Edit): Promise<void>;
  invoke(operation: Promise<void>): void;
  open(id: string, kind: CapabilityKind, anchor?: PopupAnchor | null): void;
  dismiss(state: CapabilityPopup): void;
  status(id: string, status: TaskStatus | null): Promise<void>;
  toggle(id: string): Promise<void>;
  bulkStatus(ids: readonly string[], status: TaskStatus | null): Promise<void>;
  bulkToggle(ids: readonly string[]): Promise<void>;
  bulkPatch(
    ids: readonly string[],
    patch: Partial<Pick<TaskState, 'scheduled' | 'deadline' | 'priority' | 'repeater'>>,
  ): Promise<void>;
  complete(state: Extract<CapabilityPopup, { kind: 'complete' }>): Promise<void>;
  showActions(id: string, beside?: boolean): void;
  source(id: string, beside?: boolean): void;
  ensureTask(id: string): void;
  clock(id: string): Promise<void>;
}

/** Document, field-registry, apparatus and conflict state shared by outline sub-factories. */
export interface OutlineDocumentSlice {
  props: OutlinePaneProps;
  doc: PageDocument;
  contextDate: () => string;
  fields: Resource<Fields>;
  definitionsById: Accessor<Map<string, FieldDefinition>>;
  definitions: Accessor<FieldDefinition[]>;
  /** Template fields of the types named by `typeKeys`, first type first. */
  templateFor: (keys: readonly string[]) => string[];
  requiredFor: (keys: readonly string[]) => ReadonlySet<string>;
  fieldConversion: FieldEntryConversion;
  sourceResets: (entryId?: string) => MenuItem[];
  sourceDetails: Accessor<{ fields: Map<string, string>; chapters: Map<string, string> }>;
  positionSource: (id: string) => string | null;
  sigla: Accessor<Map<string, string>>;
  glossId: Accessor<string | null>;
  inlineFields: Accessor<Set<string>>;
  localPositions: Accessor<number>;
  conflicts: Accessor<Set<string>>;
  setConflicts: Setter<Set<string>>;
  editedConflicts: Accessor<Set<string>>;
  setEditedConflicts: Setter<Set<string>>;
  setMessage: Setter<string>;
  showNotice: (label: string, undo?: () => Promise<void>) => void;
  setMenu: Setter<MenuState | null>;
}

/** Scroll, virtualizer, zoom, fold and depth dial state managed by the viewport controller. */
export interface OutlineViewportSlice {
  readonly scroll: HTMLDivElement;
  readonly heading: HTMLDivElement;
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  hosts: Map<string, HTMLElement>;
  margin: Accessor<number>;
  baseDepth: Accessor<number>;
  ids: Accessor<string[]>;
  indices: Accessor<Map<string, number>>;
  folds: Accessor<Set<string>>;
  setFolds: Setter<Set<string>>;
  fold: (id?: string | null) => void;
  zoom: Accessor<string | null>;
  setZoom: Setter<string | null>;
  zoomTo: (id: string | null) => void;
  zoomOut: () => void;
  depth: Accessor<Depth>;
  depthTitles: Record<Depth, string>;
  depthReason: () => string | undefined;
  setStop: (stop: Depth) => void;
  stepDepth: (delta: 1 | -1) => void;
  setShowArchived: Setter<boolean>;
  anchored: (change: () => void) => void;
  rowAnchor: (id: string) => HTMLElement | null;
  scheduleReport: () => void;
  attach: (id: string, host: HTMLElement) => void;
}

/** Caret, row range, cross-row text selection and IME composition state managed by the selection controller. */
export interface OutlineSelectionSlice {
  editing: Accessor<string | null>;
  selected: Accessor<string | null>;
  setSelected: Setter<string | null>;
  caret: Accessor<Caret | null>;
  setCaret: Setter<Caret | null>;
  rowRange: Accessor<RowRange | null>;
  setRowRange: Setter<RowRange | null>;
  textRange: Accessor<TextRange | null>;
  setTextRange: Setter<TextRange | null>;
  selectedIds: Accessor<string[]>;
  selectedSet: Accessor<Set<string>>;
  coveredSet: Accessor<Set<string>>;
  roots: () => string[];
  activeRange: () => TextRange | null;
  clearSelection: () => void;
  restoreSelection: (range: TextRange) => void;
  deleteTextRange: () => void;
  replaceSelection: (
    text: string,
    mode: 'text' | 'paste' | 'split',
    range?: TextRange | null,
    selectionBefore?: TextRange,
  ) => void;
  composition: Accessor<boolean>;
  readonly compositionSelection: boolean;
  selectedOffsets: (id: string) => [number, number] | null;
  editAt: (id: string, offset?: number, insert?: boolean, reveal?: boolean, activate?: boolean) => void;
  rowFocus: (id: string, extend?: boolean, keepValue?: boolean) => void;
  restoreFocus: () => void;
}

/** Header actions and cross-factory command/completion/drag callbacks. */
export interface OutlineActionsSlice {
  readonly editor: PaneEditor | undefined;
  readonly disposed: boolean;
  readonly commandDefinitions: Command[];
  capabilities: OutlineCapabilityActions;
  apply: (intent: Edit, keepEditing?: boolean) => EditResult | undefined;
  undo: (redo?: boolean) => void;
  commitFieldEntry: (id: string, focus?: boolean, afterEnter?: boolean) => boolean;
  copy: (text: string) => void;
  rename: () => void;
  addGloss: () => void;
  addAlias: () => void;
  openTable: (beside: boolean) => void;
  openMoveToPage: () => void;
  openBulkDate: (ids: readonly string[], field: 'scheduled' | 'deadline', anchor: HTMLElement) => void;
  openViewEmbed: (id?: string | null) => void;
  openRelation: (id: string, kind: 'holder' | 'subject' | 'integrate' | 'reading', anchor?: HTMLElement | null) => void;
  /** File all…: Integrate each row in turn; Skip leaves a row and Escape stops. */
  fileAll: (ids: readonly string[], anchor?: HTMLElement | null) => void;
  positionReason: (id: string) => string | undefined;
  placeReason: (id: string) => string | undefined;
  usePlace: (id: string) => void;
  chooseImage: (id: string, replace?: boolean) => void;
  openImage: (id: string) => void;
  editOcclusion: (id: string) => void;
  uploadImages: (files: readonly File[], targetId?: string) => Promise<void>;
  fieldMenu: (id: string, anchor: HTMLElement) => void;
  /** Opens the owner-scoped Add field picker, also for owners without a field area. */
  pickField: (owner: string, anchor: HTMLElement) => void;
  openPlanning: (id: string, kind: 'schedule' | 'deadline' | 'repeat') => void;
  priorityMenu: (id: string) => void;
  openProject: (id: string) => void;
  investigationItems: (id: string, manager?: boolean) => MenuItem[];
  markRelation: (id: string, kind: RelationKind | null, text?: string) => void;
  relationMenu: (id: string, add?: boolean, text?: string) => void;
  blockMenu: (id: string, anchor: HTMLElement) => void;
  /** A phone's long-press menu for a row: the row lifts over a blurred page and the menu opens under it. */
  rowContext: (id: string, source: HTMLElement) => void;
  /** The fixes for a perspective whose holder is not a person or group. */
  holderMenu: (id: string, anchor: HTMLElement) => void;
  leaderMenu: (id: string) => void;
  statusMenu: (id: string) => void;
  referenceMenu: (id: string, anchor: HTMLElement) => void;
  makeCloze: () => void;
  adjacent: (direction: number, extend?: boolean) => void;
  horizontal: (direction: 'left' | 'right') => void;
  split: (view: EditorView) => void;
  pointerStart: (event: MouseEvent, id: string, element: HTMLElement) => void;
  setCompletionIndex: Setter<number>;
  setCompletion: Setter<Completion | null>;
  rewriteEditing: (id: string, next: { text: string; caret: number }) => boolean;
  forgetReferenceSpace: (event: KeyboardEvent) => boolean;
  slashKey: (event: KeyboardEvent) => boolean;
  dateKey: (event: KeyboardEvent) => boolean;
  popupKey: (event: KeyboardEvent) => boolean;
}

/**
 * Shared pane wiring composed from focused document, viewport, selection and action slices.
 * Each factory takes only its `Pick<OutlineContext, ...>` slice; callbacks defer cross-factory calls until interaction.
 */
export interface OutlineContext
  extends OutlineDocumentSlice,
    OutlineViewportSlice,
    OutlineSelectionSlice,
    OutlineActionsSlice {}
