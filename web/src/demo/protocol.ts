import type { NotebookInfo } from '../api/types';

export type FailureCode = 'locked' | 'unsupported' | 'internal';
export type ToWorker =
  | { id: number; type: 'request'; method: string; path: string; contentType?: string; body: ArrayBuffer | null }
  | { id: number; type: 'subscribe'; after: number }
  | { id: number; type: 'unsubscribe' }
  | { id: number; type: 'reset' };
export type FromWorker =
  | { type: 'ready'; info: NotebookInfo }
  | { type: 'failed'; code: FailureCode; message: string }
  | { id: number; type: 'response'; status: number; contentType: string; body: ArrayBuffer }
  | { id: number; type: 'change'; event: string }
  | { id: number; type: 'done' };
