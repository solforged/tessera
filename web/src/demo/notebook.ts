export interface UpgradeCopy {
  schema_version: number;
  created_at: number;
  size: number;
}

/** Filled by the browser entry; shared settings never depend on its worker or transport. */
export interface BrowserNotebookActions {
  exportNotebook(): Promise<ArrayBuffer>;
  upgradeCopy(): Promise<UpgradeCopy | null>;
  exportUpgradeCopy(): Promise<ArrayBuffer>;
  restore(file: File): Promise<void>;
  restoreUpgradeCopy(): Promise<void>;
  reset(): Promise<void>;
}

export let browserNotebook: BrowserNotebookActions;
export function setBrowserNotebook(actions: BrowserNotebookActions): void { browserNotebook = actions; }
