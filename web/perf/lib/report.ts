import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './service';
import type { Outcome } from './metrics';

export function table(headers: string[], rows: (string | number | null)[][]) {
  const cell = (value: string | number | null) => {
    const text = value === null ? 'not measured' : String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
    return text.length > 1000 ? `${text.slice(0, 1000)}… (full evidence in JSON)` : text;
  };
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}
export function milliseconds(value: number | null) { return value === null ? null : `${value.toFixed(2)} ms`; }
export async function report(name: string, summary: string, data: unknown, outcomes: Outcome[]) {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const directory = join(root, 'web/perf/results');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${name}-${stamp}`);
  const checks = table(['Check', 'Result', 'Evidence'], outcomes.map(outcome => [outcome.scenario, outcome.pass ? 'pass' : 'FAIL', outcome.evidence]));
  const markdown = `# ${name}\n\n${summary}\n\n${checks}\n`;
  await Bun.write(`${file}.json`, JSON.stringify({ name, createdAt: new Date().toISOString(), device: { platform: process.platform, arch: process.arch }, outcomes, data }, null, 2) + '\n');
  await Bun.write(`${file}.md`, markdown);
  console.log(`${summary}\n\n${checks}\n\nJSON: ${file}.json`);
  if (outcomes.some(outcome => !outcome.pass)) process.exitCode = 1;
}
