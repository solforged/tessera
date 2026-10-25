import { foldName } from '../outline/names';

/**
 * Today's sections, in order. Plan, Research and Highlights are generated lists; Notes is the rest of the outline;
 * every other section is a heading written into the day's outline the first time something lands in it.
 */
export interface TodaySection { id: string; name: string; on: boolean }
export interface TodayTemplate {
  sections: TodaySection[];
  /** The written section ⌘E and Add a task capture into. */
  capture: string;
  /** A pasted link stays a link in the capture section, or becomes a Library source. */
  links: 'link' | 'source';
  tiles: { agenda: boolean; review: boolean; reading: boolean };
}

export const todayTemplateKey = 'today_template';
export const generatedSections = new Set(['plan', 'research', 'highlights']);

export const defaultTodayTemplate: TodayTemplate = {
  sections: [
    { id: 'plan', name: 'Plan', on: true },
    { id: 'inbox', name: 'Inbox', on: true },
    { id: 'reading', name: 'Reading', on: true },
    { id: 'notes', name: 'Notes', on: true },
    { id: 'research', name: 'Research to revisit', on: true },
    { id: 'highlights', name: 'From your highlights', on: false },
  ],
  capture: 'inbox',
  links: 'link',
  tiles: { agenda: true, review: true, reading: true },
};

/** One line in Settings › Today saying what each built-in section does. */
export const sectionRoles: Record<string, string> = {
  plan: 'Today’s tasks from Agenda',
  inbox: 'Captures in the order they arrived',
  reading: 'Notes under the sources they are about',
  notes: 'The rest of the outline',
  research: 'Due notes and questions',
  highlights: 'One resurfaced highlight at a time',
};

export const isWritten = (section: TodaySection) => !generatedSections.has(section.id) && section.id !== 'notes';

/** The stored template, or the default when it is unset or unreadable; the service validates every saved value. */
export function parseTodayTemplate(value: string | undefined): TodayTemplate {
  if (!value) return defaultTodayTemplate;
  try {
    const parsed = JSON.parse(value) as TodayTemplate;
    return Array.isArray(parsed.sections) ? parsed : defaultTodayTemplate;
  } catch { return defaultTodayTemplate; }
}

/** Written sections that are on, in template order: the capture targets. */
export function writtenSections(template: TodayTemplate): TodaySection[] {
  return template.sections.filter(section => section.on && isWritten(section));
}

export function captureSection(template: TodayTemplate): TodaySection {
  const written = writtenSections(template);
  return written.find(section => section.id === template.capture) ?? written[0] ?? { id: 'inbox', name: 'Inbox', on: true };
}

export function section(template: TodayTemplate, id: string): TodaySection | undefined {
  return template.sections.find(value => value.id === id);
}

/**
 * Where a capture lands: the section's name, and the written order with Notes, so a missing heading takes its place.
 * `under` files the line beneath a source's row in the section, written with the line when the day lacks it.
 */
export interface SectionTarget { name: string; order: string[]; under?: { id: string; text: string } }

const stableId = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** The source a Reading row is about: the row's whole text is one reference to it. */
export function readingRowSource(text: string): string | undefined {
  const match = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(text.trim());
  return match && stableId.test(match[1]!) ? match[1] : undefined;
}

/** A Reading row's text: the source by its short title, with the reader's position when the row was written. */
export function readingRowText(id: string, title: string, position?: string | null): string {
  const clean = (value: string) => value.replace(/[|\[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const locator = position ? clean(position) : '';
  return `[[${id}|${clean(title) || 'Source'}${locator ? `|${locator}` : ''}]]`;
}

export function sectionTarget(template: TodayTemplate, id: string): SectionTarget | undefined {
  const target = writtenSections(template).find(value => value.id === id);
  if (!target) return undefined;
  return { name: target.name, order: template.sections.filter(value => value.on && (isWritten(value) || value.id === 'notes')).map(value => value.id === 'notes' ? '' : value.name) };
}

interface RootRow { id: string; text: string; heading: number | null }

/** The journal's existing heading for a section, matched with the workshop's name folding. */
export function findSectionHeading<T extends RootRow>(roots: readonly T[], name: string): T | undefined {
  const key = foldName(name);
  return roots.find(row => row.heading !== null && foldName(row.text) === key);
}

/**
 * The root row a new section heading follows (null for the first place): before the first row of a later section.
 * Rows outside any section belong to Notes, so Notes keeps its template place too.
 */
export function sectionInsertAfter(roots: readonly RootRow[], target: SectionTarget): string | null {
  const ranks = new Map(target.order.map((name, index) => [foldName(name), index]));
  const notes = ranks.get('') ?? target.order.length;
  const rank = ranks.get(foldName(target.name)) ?? notes;
  const at = roots.findIndex(row => (row.heading !== null ? ranks.get(foldName(row.text)) ?? notes : notes) > rank);
  if (at < 0) return roots.at(-1)?.id ?? null;
  return at === 0 ? null : roots[at - 1]!.id;
}
