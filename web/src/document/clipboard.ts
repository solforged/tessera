import type { TaskState } from '../api/types';
import type { BlockClipboard } from './contract';
import { quoteTarget } from './text-tokens';

export const BLOCK_CLIPBOARD_MIME = 'application/x-tessera-blocks+json';

export function clipboardText(content: BlockClipboard): string {
  return content.blocks.map(({ block, depth, capabilities }) => {
    const quote = capabilities.quote;
    if (quote && quoteTarget(block.text) === quote.target_id) {
      return quote.rows.flatMap(row => row.text.split('\n').map((line, index) =>
        '  '.repeat(depth) + '> ' + '  '.repeat(row.depth) + (index === 0 && row.heading ? '#'.repeat(row.heading) + ' ' : '') + line)).join('\n');
    }
    const marker = capabilities.task ? capabilities.task.status === 'done' ? '[x] ' : '[ ] ' : '';
    return block.text.split('\n').map((line, index) => '  '.repeat(depth) + (index === 0 ? marker : '') + line).join('\n');
  }).join('\n');
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function task(value: unknown): value is TaskState | null {
  if (value === null) return true;
  if (!record(value) || !['todo', 'doing', 'waiting', 'done', 'cancelled'].includes(String(value.status))) return false;
  if (value.priority !== null && !['high', 'medium', 'low'].includes(String(value.priority))) return false;
  if (value.warning_days !== null && (!Number.isInteger(value.warning_days) || (value.warning_days as number) < 0)) return false;
  if (!['scheduled', 'scheduled_time', 'deadline', 'deadline_time', 'completed_on'].every(key => value[key] === null || typeof value[key] === 'string')) return false;
  return value.repeater === null || record(value.repeater) && Number.isInteger(value.repeater.every) && (value.repeater.every as number) > 0
    && ['day', 'week', 'month', 'year'].includes(String(value.repeater.unit))
    && ['fixed', 'catch_up', 'after_completion'].includes(String(value.repeater.mode));
}

/** Reject malformed private data before it can replace a selection. Plain text remains the fallback. */
export function parseBlockClipboard(text: string): BlockClipboard | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!record(value) || value.version !== 1 || typeof value.scope !== 'string' || typeof value.cut !== 'boolean' || !Array.isArray(value.blocks) || !value.blocks.length) return null;
  const ids = new Set<string>();
  let previousDepth = -1;
  for (const item of value.blocks) {
    if (!record(item) || !Number.isInteger(item.depth) || (item.depth as number) < 0 || (item.depth as number) > previousDepth + 1) return null;
    const block = item.block;
    const capabilities = item.capabilities;
    if (!record(block) || typeof block.id !== 'string' || !block.id || ids.has(block.id) || block.kind !== 'block'
      || typeof block.text !== 'string' || typeof block.parent_id !== 'string' || typeof block.page_id !== 'string'
      || ![null, 1, 2, 3].includes(block.heading as null | number) || typeof block.archived !== 'boolean'
      || !Number.isInteger(block.revision) || typeof block.created_at !== 'number' || typeof block.updated_at !== 'number'
      || !Array.isArray(item.manualTypes) || !item.manualTypes.every(title => typeof title === 'string')
      || !record(capabilities) || capabilities.block_id !== block.id || !task(capabilities.task)) return null;
    ids.add(block.id);
    previousDepth = item.depth as number;
  }
  return value as unknown as BlockClipboard;
}

/** getData returns an empty string for an absent type, which is not an empty-text paste. */
export function clipboardPlainText(data: Pick<DataTransfer, 'types' | 'getData'>): string | null {
  return Array.from(data.types).includes('text/plain') ? data.getData('text/plain') : null;
}
