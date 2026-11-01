/** Undo depth. Snapshots share untouched operations, so this bounds memory without limiting a single edit. */
const MAX_UNDO_ENTRIES = 100;

/** Snapshot history for immutable working messages. Owners supply detached snapshots; this class only orders them. */
export class SnapshotHistory<T> {
  private readonly undoStack: T[] = [];
  private readonly redoStack: T[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Record a new edit. Any alternate future is no longer valid. */
  record(prior: T): void {
    this.undoStack.push(prior);
    if (this.undoStack.length > MAX_UNDO_ENTRIES) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(current: T): T | undefined {
    const prior = this.undoStack.pop();
    if (prior === undefined) return undefined;
    this.redoStack.push(current);
    return prior;
  }

  redo(current: T): T | undefined {
    const next = this.redoStack.pop();
    if (next === undefined) return undefined;
    this.undoStack.push(current);
    return next;
  }

  /** Reset/reload establish a new baseline with no navigable draft history. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
