import { Workshop } from '../document';
import type { WorkshopOptions, WorkshopWorkflows } from '../document';
import { captureOperations } from './capture';
import { editSourceDetails, integrateBlock, moveBlocks, promoteToProject } from './pages';
import { resolveRelationPick } from './relations';

const defaultWorkflows: WorkshopWorkflows = {
  captureOperations,
  resolveRelationPick,
  editSourceDetails,
  integrateBlock,
  moveBlocks,
  promoteToProject,
};

export function createWorkshopClient(options: WorkshopOptions = {}): Workshop {
  return new Workshop({ ...options, workflows: options.workflows ?? defaultWorkflows });
}

export type { Workshop, WorkshopOptions };
