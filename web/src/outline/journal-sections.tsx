import { For, createMemo, createResource, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { CaptureField } from '../capture/CaptureField';
import type { NotebookClient, PageDocument } from '../document/contract';
import { isFinished } from '../tasks/task-labels';
import { captureSection, isWritten, readingRowSource, sectionTarget, writtenSections } from '../tasks/today-template';
import type { TodaySection } from '../tasks/today-template';
import { foldName } from './names';
import { SectionHead } from '../ui/SectionHead';
import { embedTarget } from './streams';
import { referenceSource } from './source-reads';
import './journal-sections.css';

/** A written section's heading row, drawn as the shared section head. */
export interface JournalSectionHead { section: TodaySection; count: string; capture: boolean; today: boolean }

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
  /** Top-level Inbox rows, and those still to file: neither Integrate references nor finished tasks, in order. */
  inbox: Set<string>;
  toFile: string[];
  /** Top-level Reading rows that stand for a source → that source. */
  reading: Map<string, string>;
  /** Top-level Inbox rows that are one reference to a source, such as a Link once its Library import finished. */
  inboxSources: Set<string>;
}

// The field that captured into a missing section hands focus to the field under the heading it wrote.
const [captureFocus, setCaptureFocus] = createSignal<string | null>(null);

/** Matches a journal day's root headings to the template's written sections. */
export function createJournalLayout(doc: PageDocument, notebook: NotebookClient, active: Accessor<boolean>): Accessor<JournalLayout | null> {
  const clock = createMemo(() => new Intl.DateTimeFormat('en-GB', { timeZone: notebook.settings()?.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const layout = createMemo(() => {
    const root = doc.root();
    if (!active() || root?.kind !== 'journal') return null;
    const template = notebook.todayTemplate();
    const today = root.text === notebook.todayDate();
    const written = writtenSections(template);
    const capture = captureSection(template).id;
    const byName = new Map(written.map(section => [foldName(section.name), section]));
    const heads = new Map<string, JournalSectionHead>();
    const found = new Set<string>();
    const times = new Map<string, string>();
    const inbox = new Set<string>();
    const toFile: string[] = [];
    const reading = new Map<string, string>();
    const references = new Map<string, string>();
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
      heads.set(id, { section, count: sectionCount(doc, section, children), capture: today && section.id === capture, today });
      if (section.id === 'inbox') for (const child of children) {
        inbox.add(child);
        const target = readingRowSource(doc.block(child)?.text ?? '');
        if (target) references.set(child, target);
        if (unfiled(doc, child)) toFile.push(child);
        const at = doc.createdAt(child);
        if (at !== undefined) times.set(child, clock().format(at));
      }
      if (section.id === 'reading') for (const child of children) {
        const source = readingRowSource(doc.block(child)?.text ?? '');
        if (source) reading.set(child, source);
      }
    }
    const notesName = template.sections.find(section => section.id === 'notes')?.name ?? 'Notes';
    return {
      today, heads, times, inbox, toFile, reading, references,
      // Other days read as one outline unless they also hold section headings.
      notesHead: loose && (today || heads.size) ? { id: loose, name: notesName } : undefined,
      missing: placeMissing(today ? written.filter(section => !found.has(section.id)) : [], ranked, order),
    };
  });
  // Which referenced pages are sources is the service's to say; the rows draw their source glyph once it has.
  const [sources] = createResource(() => [...new Set(layout()?.references.values() ?? [])].sort().join(' '), async key => {
    const ids = key ? key.split(' ') : [];
    const records = await Promise.all(ids.map(id => referenceSource(notebook, id).catch(() => null)));
    return new Set(ids.filter((_, index) => records[index]));
  });
  return createMemo(() => {
    const value = layout();
    if (!value) return null;
    const known = sources.latest;
    const { references, ...rest } = value;
    return { ...rest, inboxSources: new Set([...references].filter(([, target]) => known?.has(target)).map(([row]) => row)) };
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

/** A row is filed once it is an Integrate reference or a finished task. */
function unfiled(doc: PageDocument, id: string) {
  const block = doc.block(id);
  return !!block && !embedTarget(block.text) && !(block.task && isFinished(block.task));
}

function sectionCount(doc: PageDocument, section: TodaySection, children: readonly string[]): string {
  if (section.id === 'inbox') {
    const open = children.filter(id => unfiled(doc, id)).length;
    return children.length ? `${children.length} · ${open} to file` : '';
  }
  if (section.id === 'reading') return children.length ? `${children.length} source${children.length === 1 ? '' : 's'}` : '';
  return children.length ? String(children.length) : '';
}

/**
 * A section's own line: the section ⌘E captures into gets the boxed field with its reminder; other sections a quiet
 * placeholder row that writes nothing until something is entered.
 */
export function SectionCapture(props: { notebook: NotebookClient; section: TodaySection; onCaptured?(): void }) {
  const boxed = () => props.section.id === captureSection(props.notebook.todayTemplate()).id;
  const target = () => sectionTarget(props.notebook.todayTemplate(), props.section.id);
  return <div class="section-capture" classList={{ 'section-capture-boxed': boxed() }}
    onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <CaptureField notebook={props.notebook} contextDate={() => props.notebook.todayDate()} section={target()} boxed={boxed()}
      trailing={boxed() ? '⌘E from anywhere' : undefined}
      label={`Capture to ${props.section.name}`}
      placeholder={boxed() ? `Capture to ${props.section.name}: a thought, a link, [] a task, a question?` : `Write in ${props.section.name}…`}
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

// Creators change rarely and a day holds few sources, so each source is read once per session.
const creators = new Map<string, Promise<string>>();

/** A Reading row's authors and the reader's position when it was written, in faint after its title. */
export function ReadingCreators(props: { notebook: NotebookClient; sourceId: string; text: string }) {
  // The position is the reference's locator, written when the row was: `[[id|title|position]]`.
  const position = () => /^\[\[[^|\]]+\|[^|\]]*\|([^\]]+)\]\]$/.exec(props.text.trim())?.[1];
  const [names] = createResource(() => props.sourceId, id => {
    let names = creators.get(id);
    if (!names) {
      names = props.notebook.api.source(id).then(view => {
        const snapshot = view.snapshots.find(value => value.id === view.source.current_snapshot_id) ?? view.snapshots[0];
        return (snapshot?.metadata.creators ?? []).filter(creator => creator.role === 'author').map(creator => creator.name).join(', ');
      }, () => '');
      creators.set(id, names);
    }
    return names;
  });
  const line = () => [names(), position()].filter(Boolean).join(' · ');
  return <>{line() ? <span class="row-reading-creators">{line()}</span> : null}</>;
}
