import type { NotebookInfo } from '../api/types';
import type { UpgradeCopy } from './notebook';

export type FailureCode = 'locked' | 'unsupported' | 'invalid' | 'internal';
export type ToWorker =
  | { id: number; type: 'request'; method: string; path: string; headers: [string, string][]; body: ArrayBuffer | null }
  | { id: number; type: 'subscribe'; after: number }
  | { id: number; type: 'unsubscribe' }
  | { id: number; type: 'start'; kind: 'empty' | 'tour' }
  | { id: number; type: 'export' | 'export-upgrade-copy' | 'upgrade-copy' | 'restore-upgrade-copy' | 'reset' | 'close' }
  | { id: number; type: 'restore'; body: ArrayBuffer };
export type FromWorker =
  | { type: 'ready'; info: NotebookInfo; fresh: boolean }
  | { type: 'failed'; code: FailureCode; message: string }
  | { id: number; type: 'error'; code: 'invalid' | 'internal'; message: string }
  | { id: number; type: 'bytes'; body: ArrayBuffer }
  | { id: number; type: 'restored'; info: NotebookInfo }
  | { id: number; type: 'upgrade-copy'; copy: UpgradeCopy | null }
  | { id: number; type: 'response'; status: number; contentType: string; body: ArrayBuffer }
  | { id: number; type: 'change'; event: string }
  | { id: number; type: 'done' };
