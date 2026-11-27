import { createContext, useContext } from 'solid-js';
import type { NoteKind } from '../api/types';
import type { CreateOptions, CreateRequest } from '../create/request';
import type { WorkshopClient } from '../document/contract';
import type { PopupAnchor } from '../ui/Popup';
import type { CommandRegistry, PagePresentation } from '../core/contract';

/**
 * Values every pane shares. Getters keep Solid's prop reactivity: a read
 * tracks the signal it closes over, rather than a value captured in App.
 */
export interface WorkshopShell {
  readonly workshop: WorkshopClient;
  readonly commands: CommandRegistry;
  readonly vim: boolean;
  readonly split: boolean;
  readonly pagePresentations: Record<string, PagePresentation>;
  fieldName(id: string): string;
  readonly noteKinds: NoteKind[] | undefined;
  readonly atomCount: number | undefined;
  readonly directoryReady: boolean;
  onCreate(request: CreateRequest, anchor?: PopupAnchor, options?: CreateOptions): void;
  onPagePresentation(id: string, value: PagePresentation): void;
  onDeleteSources(sources: { id: string; title: string }[]): Promise<void>;
}

export const WorkshopContext = createContext<WorkshopShell>();

export function useWorkshop(): WorkshopShell {
  const value = useContext(WorkshopContext);
  if (!value) throw new Error('Workshop shell is missing');
  return value;
}
