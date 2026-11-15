export interface UpgradeCopy {
  schema_version: number;
  created_at: number;
  size: number;
}

/** Filled by the browser entry; shared settings never depend on its worker or transport. */
export interface BrowserWorkshopActions {
  exportWorkshop(): Promise<ArrayBuffer>;
  upgradeCopy(): Promise<UpgradeCopy | null>;
  exportUpgradeCopy(): Promise<ArrayBuffer>;
  restore(file: File): Promise<void>;
  restoreUpgradeCopy(): Promise<void>;
  reset(): Promise<void>;
}

export let browserWorkshop: BrowserWorkshopActions;
export function setBrowserWorkshop(actions: BrowserWorkshopActions): void {
  browserWorkshop = actions;
}
