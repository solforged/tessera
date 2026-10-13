import { createContext } from 'solid-js';

export interface AgentMarksValue {
  mark(blockId: string): { seq: number; summary: string } | undefined;
  undo(seq: number): Promise<string | null>;
}

/** Outline rows can read marks even when no agent dock is mounted. */
export const AgentMarks = createContext<AgentMarksValue>({
  mark: () => undefined,
  undo: async () => null,
});
