import type { Accessor, Resource, Setter } from 'solid-js';
import type { Virtualizer } from '@tanstack/solid-virtual';
import type { EditorView } from '@codemirror/view';
import type { FieldDefinition, Fields, TaskStatus } from '../api/types';
import type { Caret, Edit, EditResult, PageDocument, TextRange } from '../document/contract';
import type { Command, Depth, OutlinePaneProps } from '../shell/contract';
import type { MenuItem } from '../ui/Menu';
import type { PaneEditor } from './editor';
import type { CapabilityKind, CapabilityPopup } from './capabilities';
import type { FieldEntryConversion } from './source-fields';
import type { PopupAnchor } from '../ui/Popup';
import type { Completion } from './completions';

export interface RowRange { anchor: string; head: string }
export interface MenuState { anchor: HTMLElement; items: MenuItem[]; label: string }

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
  complete(state: Extract<CapabilityPopup, { kind: 'complete' }>): Promise<void>;
  showActions(id: string, beside?: boolean): void;
  source(id: string, beside?: boolean): void;
  ensureTask(id: string): void;
  clock(id: string): Promise<void>;
}

/** Shared pane wiring. Signals and late-mounted DOM/editor state cross module boundaries as accessors.
 * Each factory takes only its slice; callbacks defer cross-factory calls until an interaction occurs.
 */
export interface OutlineContext {
  contextDate: () => string;
  editing: Accessor<string | null>;
  textRange: Accessor<TextRange | null>;
  composition: Accessor<boolean>;
  caret: Accessor<Caret | null>;
  readonly editor: PaneEditor | undefined;
  doc: PageDocument;
  capabilities: OutlineCapabilityActions;
  setCaret: Setter<Caret | null>;
  scheduleReport: () => void;
  setMessage: Setter<string>;
  readonly disposed: boolean;
  rowAnchor: (id: string) => HTMLElement | null;
  editAt: (id: string, offset?: number, insert?: boolean, reveal?: boolean, activate?: boolean) => void;
  props: OutlinePaneProps;
  replaceSelection: (text: string, mode: 'text' | 'paste' | 'split', range?: TextRange | null, selectionBefore?: TextRange) => void;
  fields: Resource<Fields>;
  definitionsById: Accessor<Map<string, FieldDefinition>>;
  definitions: Accessor<FieldDefinition[]>;
  /** Template fields of the types named by `typeKeys`, first type first. */
  templateFor: (keys: readonly string[]) => string[];
  activeRange: () => TextRange | null;
  fieldConversion: FieldEntryConversion;
  readonly commandDefinitions: Command[];
  openPlanning: (id: string, kind: 'schedule' | 'deadline' | 'repeat') => void;
  priorityMenu: (id: string) => void;
  openProject: (id: string) => void;
  investigationItems: (id: string) => MenuItem[];
  apply: (intent: Edit, keepEditing?: boolean) => EditResult | undefined;
  zoomTo: (id: string | null) => void;
  copy: (text: string) => void;
  commitFieldEntry: (id: string, focus?: boolean) => boolean;
  selected: Accessor<string | null>;
  setMenu: Setter<MenuState | null>;
  rename: () => void;
  addGloss: () => void;
  localPositions: Accessor<number>;
  depthTitles: Record<Depth, string>;
  depthReason: () => string | undefined;
  setStop: (stop: Depth) => void;
  depth: Accessor<Depth>;
  stepDepth: (delta: 1 | -1) => void;
  readonly heading: HTMLDivElement;
  adjacent: (direction: number, extend?: boolean) => void;
  horizontal: (direction: 'left' | 'right') => void;
  ids: Accessor<string[]>;
  rowFocus: (id: string, extend?: boolean) => void;
  split: (view: EditorView) => void;
  roots: () => string[];
  setRowRange: Setter<RowRange | null>;
  fold: (id?: string | null) => void;
  zoom: Accessor<string | null>;
  zoomOut: () => void;
  anchored: (change: () => void) => void;
  setShowArchived: Setter<boolean>;
  undo: (redo?: boolean) => void;
  setConflicts: Setter<Set<string>>;
  indices: Accessor<Map<string, number>>;
  setFolds: Setter<Set<string>>;
  setZoom: Setter<string | null>;
  selectedSet: Accessor<Set<string>>;
  sourceResets: (entryId?: string) => MenuItem[];
  setCompletionIndex: Setter<number>;
  setCompletion: Setter<Completion | null>;
  rewriteEditing: (id: string, next: { text: string; caret: number }) => boolean;
  folds: Accessor<Set<string>>;
  inlineFields: Accessor<Set<string>>;
  setSelected: Setter<string | null>;
  deleteTextRange: () => void;
  setTextRange: Setter<TextRange | null>;
  forgetReferenceSpace: (event: KeyboardEvent) => boolean;
  slashKey: (event: KeyboardEvent) => boolean;
  dateKey: (event: KeyboardEvent) => boolean;
  popupKey: (event: KeyboardEvent) => boolean;
  leaderMenu: (id: string) => void;
  openTable: (beside: boolean) => void;
  rowRange: Accessor<RowRange | null>;
  statusMenu: (id: string) => void;
  readonly scroll: HTMLDivElement;
  clearSelection: () => void;
  restoreSelection: (range: TextRange) => void;
  selectedIds: Accessor<string[]>;
  readonly compositionSelection: boolean;
  baseDepth: Accessor<number>;
  positionSource: (id: string) => string | null;
  sourceDetails: Accessor<{ fields: Map<string, string>; firstHighlight: string | undefined; highlightCount: number }>;
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  hosts: Map<string, HTMLElement>;
  coveredSet: Accessor<Set<string>>;
  glossId: Accessor<string | null>;
  margin: Accessor<number>;
  sigla: Accessor<Map<string, string>>;
  blockMenu: (id: string, anchor: HTMLElement) => void;
  pointerStart: (event: MouseEvent, id: string, element: HTMLElement) => void;
  attach: (id: string, host: HTMLElement) => void;
  referenceMenu: (id: string, anchor: HTMLElement) => void;
  selectedOffsets: (id: string) => [number, number] | null;
  conflicts: Accessor<Set<string>>;
  editedConflicts: Accessor<Set<string>>;
  setEditedConflicts: Setter<Set<string>>;
}
