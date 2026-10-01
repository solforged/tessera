import type { OutlineRow, Selection } from '@spike/shared';
import type { Command, Operation } from './commands';
import { OutlineIndex } from './outline-index';

type Listener = () => void;
export interface RowSnapshot { row: OutlineRow; active: boolean; selected: boolean }
export class DocumentStore {
  readonly outline: OutlineIndex;
  private snapshots = new Map<string, RowSnapshot>();
  private listeners = new Map<string, Set<Listener>>();
  private orderListeners = new Set<Listener>();
  private revision = 0;
  private selected = new Set<string>();
  private active: string | null = null;
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private groupingText = false;
  private textGroup: Command | null = null;
  private groupBefore: Selection | null = null;
  selection: Selection | null = null;

  constructor(rows: OutlineRow[]) {
    this.outline = new OutlineIndex(rows);
    for (const row of rows) this.snapshots.set(row.id, { row, active: false, selected: false });
  }
  getRow = (id: string) => this.outline.get(id)!;
  getSnapshot = (id: string) => this.snapshots.get(id)!;
  getRevision = () => this.revision;
  model = () => this.outline.toArray();
  subscribeRow = (id: string, callback: Listener) => {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, set = new Set());
    set.add(callback);
    return () => {
      set.delete(callback);
      if (!set.size && !this.outline.get(id)) this.snapshots.delete(id);
    };
  };
  subscribeOrder = (callback: Listener) => {
    this.orderListeners.add(callback);
    return () => { this.orderListeners.delete(callback); };
  };
  private notify(id: string) {
    const row = this.outline.get(id);
    if (row) this.snapshots.set(id, { row, active: this.active === id, selected: this.selected.has(id) });
    for (const listener of this.listeners.get(id) ?? []) listener();
  }
  setSelection(selection: Selection) {
    const previousActive = this.active;
    this.active = selection.head.id;
    this.selection = selection;
    const nextSelected = new Set<string>();
    if (selection.anchor.id !== selection.head.id) {
      const a = this.outline.indexOf(selection.anchor.id);
      const b = this.outline.indexOf(selection.head.id);
      for (const row of this.outline.slice(Math.min(a, b), Math.max(a, b) + 1)) nextSelected.add(row.id);
    }
    const affected = new Set([...this.selected, ...nextSelected]);
    if (previousActive !== this.active) {
      if (previousActive) affected.add(previousActive);
      affected.add(this.active);
    }
    this.selected = nextSelected;
    for (const id of affected) this.notify(id);
  }
  private apply(operation: Operation): boolean {
    if (operation.kind === 'text') {
      this.outline.setText(operation.id, operation.text);
      this.notify(operation.id);
      return false;
    }
    if (operation.kind === 'depth') {
      for (const row of this.outline.shiftDepth(operation.at, operation.count, operation.delta)) this.notify(row.id);
      return false;
    }
    if (operation.kind === 'move') {
      this.outline.move(operation.from, operation.count, operation.to);
      return operation.from !== operation.to;
    }
    const removed = this.outline.slice(operation.at, operation.at + operation.remove);
    this.outline.splice(operation.at, operation.remove, operation.rows);
    for (const row of removed) this.notify(row.id);
    for (const row of operation.rows) this.notify(row.id);
    return true;
  }
  private applyAll(operations: Operation[]) {
    let orderChanged = false;
    for (const operation of operations) orderChanged = this.apply(operation) || orderChanged;
    if (orderChanged) {
      this.revision++;
      for (const callback of this.orderListeners) callback();
    }
  }
  execute(command: Command | null): Selection | null {
    if (!command) return null;
    this.applyAll(command.forward);
    this.undoStack.push(command);
    this.redoStack = [];
    this.setSelection(command.after);
    return command.after;
  }
  beginTextGroup() {
    this.groupingText = true;
    this.textGroup = null;
    this.groupBefore = this.selection;
  }
  endTextGroup() {
    this.groupingText = false;
    this.textGroup = null;
    this.groupBefore = null;
  }
  text(id: string, text: string, before: Selection, after: Selection) {
    const previous = this.getRow(id).text;
    if (previous === text) return;
    const grouped = this.textGroup?.forward[0];
    if (this.groupingText && grouped?.kind === 'text' && grouped.id === id) {
      this.textGroup!.forward[0] = { kind: 'text', id, text };
      this.textGroup!.after = after;
      this.apply(this.textGroup!.forward[0]);
      this.setSelection(after);
    } else {
      const command: Command = { forward: [{ kind: 'text', id, text }], inverse: [{ kind: 'text', id, text: previous }], before: this.groupBefore?.head.id === id ? this.groupBefore : before, after };
      this.execute(command);
      if (this.groupingText) this.textGroup = command;
    }
  }
  undo(): Selection | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    this.applyAll(command.inverse);
    this.redoStack.push(command);
    this.setSelection(command.before);
    return command.before;
  }
  redo(): Selection | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    this.applyAll(command.forward);
    this.undoStack.push(command);
    this.setSelection(command.after);
    return command.after;
  }
}
