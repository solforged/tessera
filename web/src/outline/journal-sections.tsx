import { For, createMemo, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { CaptureField } from '../capture/CaptureField';
import type { NotebookClient, PageDocument } from '../document/contract';
import { isFinished } from '../tasks/task-labels';
import { isWritten, sectionTarget, writtenSections } from '../tasks/today-template';
import type { TodaySection } from '../tasks/today-template';
import { foldName } from './names';
import { SectionHead } from '../ui/SectionHead';
import { embedTarget } from './streams';
import './journal-sections.css';

/** A written section's heading row, drawn as the shared section head. */
export interface JournalSectionHead { section: TodaySection; count: string; capture: boolean }

export interface JournalLayout {
  today: boolean;
  /** Heading row → its section, for the first heading of each written section. */
  heads: Map<string, JournalSectionHead>;
  /** The first root row outside every section starts Notes, which is drawn and never written. */
  notesHead?: { id: string; name: string };
  /**
   * Today's written sections without a heading yet, drawn where the heading would be written: before the first
   * root row of a later section (`before`), or after the outline when none follows (`end`).
   */
  missing: { before: Map<string, TodaySection[]>; end: TodaySection[] };
  /** Inbox rows' creation clocks, top level only. */
  times: Map<string, string>;
}

// The field that captured into a missing section hands focus to the field under the heading it wrote.
const [captureFocus, setCaptureFocus] = createSignal<string | null>(null);

/** Matches a journal day's root headings to the template's written sections. */
export function createJournalLayout(doc: PageDocument, notebook: NotebookClient, active: Accessor<boolean>): Accessor<JournalLayout | null> {
  const clock = createMemo(() => new Intl.DateTimeFormat('en-GB', { timeZone: notebook.settings()?.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  return createMemo(() => {
    const root = doc.root();
    if (!active() || root?.kind !== 'journal') return null;
    const template = notebook.todayTemplate();
    const today = root.text === notebook.todayDate();
    const written = writtenSections(template);
    const byName = new Map(written.map(section => [foldName(section.name), section]));
    const heads = new Map<string, JournalSectionHead>();
    const found = new Set<string>();
    const times = new Map<string, string>();
    let loose: string | undefined;
    const order = template.sections.filter(value => value.on && (isWritten(value) || value.id === 'notes')).map(value => value.id);
    const ranked: { id: string; rank: number }[] = [];
    for (const id of doc.outline.children(doc.pageId)) {
      if (doc.isArchived(id)) continue;
      const block = doc.block(id);
      const section = block?.heading ? byName.get(foldName(block.text)) : undefined;
      if (!section || found.has(section.id)) { loose ??= id; ranked.push({ id, rank: order.indexOf('notes') }); continue; }
      ranked.push({ id, rank: order.indexOf(section.id) });
      found.add(section.id);
      const children = doc.outline.children(id).filter(child => !doc.isArchived(child));
      heads.set(id, { section, count: sectionCount(doc, section, children), capture: today && section.id === 'inbox' });
      if (section.id === 'inbox') for (const child of children) {
        const at = doc.createdAt(child);
        if (at !== undefined) times.set(child, clock().format(at));
      }
    }
    const notesName = template.sections.find(section => section.id === 'notes')?.name ?? 'Notes';
    return {
      today, heads, times,
      // Other days read as one outline unless they also hold section headings.
      notesHead: loose && (today || heads.size) ? { id: loose, name: notesName } : undefined,
      missing: placeMissing(today ? written.filter(section => !found.has(section.id)) : [], ranked, order),
    };
  });
}

function placeMissing(missing: TodaySection[], ranked: { id: string; rank: number }[], order: string[]): JournalLayout['missing'] {
  const before = new Map<string, TodaySection[]>();
  const end: TodaySection[] = [];
  for (const section of missing) {
    const rank = order.indexOf(section.id);
    const next = ranked.find(row => row.rank > rank);
    if (next) before.set(next.id, [...before.get(next.id) ?? [], section]);
    else end.push(section);
  }
  return { before, end };
}

function sectionCount(doc: PageDocument, section: TodaySection, children: readonly string[]): string {
  if (section.id === 'inbox') {
    // A row is filed once it is an Integrate reference or a finished task.
    const open = children.filter(id => { const block = doc.block(id); return !embedTarget(block?.text ?? '') && !(block?.task && isFinished(block.task)); }).length;
    return children.length ? `${children.length} · ${open} to file` : '';
  }
  if (section.id === 'reading') return children.length ? `${children.length} source${children.length === 1 ? '' : 's'}` : '';
  return children.length ? String(children.length) : '';
}

/**
 * A section's own line: Inbox gets the boxed capture field with its ⌘E reminder; other sections a quiet placeholder
 * row that writes nothing until something is entered.
 */
export function SectionCapture(props: { notebook: NotebookClient; section: TodaySection; onCaptured?(): void }) {
  const inbox = () => props.section.id === 'inbox';
  const target = () => sectionTarget(props.notebook.todayTemplate(), props.section.id);
  return <div class="section-capture" classList={{ 'section-capture-inbox': inbox() }}
    onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <CaptureField notebook={props.notebook} contextDate={() => props.notebook.todayDate()} section={target()} boxed={inbox()}
      trailing={inbox() ? '⌘E from anywhere' : undefined}
      label={`Capture to ${props.section.name}`}
      placeholder={inbox() ? `Capture to ${props.section.name}: a thought, a link, [] a task, a question?` : `Write in ${props.section.name}…`}
      inputRef={input => { if (captureFocus() === props.section.id) { setCaptureFocus(null); queueMicrotask(() => input.focus()); } }}
      onSaved={() => { setCaptureFocus(props.section.id); props.onCaptured?.(); }} />
  </div>;
}

/** Heads and capture lines for sections the day has not written yet. */
export function MissingSections(props: { notebook: NotebookClient; sections: readonly TodaySection[] }) {
  return <For each={props.sections}>{section => <section class="journal-missing-section" aria-label={section.name}>
    <SectionHead name={section.name} />
    <SectionCapture notebook={props.notebook} section={section} />
  </section>}</For>;
}
