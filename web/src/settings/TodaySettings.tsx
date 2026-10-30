import { For, Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { ulid } from 'ulid';
import type { NotebookClient } from '../document/contract';
import { foldName } from '../outline/names';
import { captureSection, isWritten, sectionRoles, writtenSections } from '../tasks/today-template';
import type { TodaySection, TodayTemplate } from '../tasks/today-template';
import { Button } from '../ui/Button';
import { haptic } from '../ui/haptics';
import { Icon } from '../ui/Icon';
import { isPhone } from '../ui/phone';
import { Choice } from './Choice';
import { Group } from './Group';
import { dropIndex, makeRoom, settleOffset } from './reorder';

const tiles = [['agenda', 'Agenda'], ['review', 'Review'], ['reading', 'Reading']] as const;
const links = [{ value: 'link', label: 'A link' }, { value: 'source', label: 'A source' }] as const;
/** How near a screen edge a held row must be before the page scrolls under it, and its fastest scroll per frame. */
const EDGE_ZONE = 64;
const EDGE_SPEED = 16;

/** A held row: where every row stood when it was lifted, in the scroller's own coordinates. */
interface Drag {
  from: number;
  to: number;
  rows: HTMLElement[];
  centers: number[];
  heights: number[];
  startY: number;
  pointerY: number;
  scroller: HTMLElement;
  frame: number;
}

/**
 * Settings › Today: the workshop's one template. Sections reorder by dragging the handle (on a phone, by touch, with the row
 * lifting under the finger) or with Alt+Up and Alt+Down, rename in place and switch on or off; Notes and the capture section
 * stay on.
 */
export function TodaySettings(props: { id: string; heading: JSX.Element; pane: string; notebook: NotebookClient }) {
  const phone = isPhone();
  const template = () => props.notebook.todayTemplate();
  const busy = () => props.notebook.settingsBusy();
  const [problem, setProblem] = createSignal('');
  const [draft, setDraft] = createSignal('');
  let list!: HTMLOListElement;
  let dragged: number | undefined;
  let drag: Drag | undefined;
  const save = async (next: Partial<TodayTemplate>) => {
    setProblem('');
    try { await props.notebook.setSetting('today_template', JSON.stringify({ ...template(), ...next })); return true; }
    catch { return false; /* The document shows the save error and keeps the acknowledged template. */ }
  };
  const taken = (name: string, except?: string) => template().sections.some(section => section.id !== except && foldName(section.name) === foldName(name));
  const move = async (from: number, to: number) => {
    const sections = [...template().sections];
    if (to < 0 || to >= sections.length || from === to) return false;
    const [section] = sections.splice(from, 1);
    sections.splice(to, 0, section!);
    const saved = await save({ sections });
    if (saved) requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-section="${section!.id}"] .today-section-handle`)?.focus());
    return saved;
  };

  // Touch reorder. The handle takes the pointer, so the page does not pan under the finger; the held row follows it, the
  // rows it passes slide aside, and letting go saves the new order.
  const place = (held: Drag) => {
    const dy = held.pointerY + held.scroller.scrollTop - held.startY;
    const to = dropIndex(held.centers, held.from, held.centers[held.from]! + dy);
    held.rows[held.from]!.style.setProperty('--lift', `${dy}px`);
    if (to === held.to) return;
    held.to = to;
    haptic('selection');
    held.rows.forEach((row, index) => { if (index !== held.from) row.style.translate = `0 ${makeRoom(index, held.from, to, held.heights[held.from]!)}px`; });
  };
  // Near the top or bottom of what is visible the page scrolls, faster the closer the finger gets to the edge.
  const scrollUnder = (held: Drag) => {
    const box = held.scroller.getBoundingClientRect();
    const style = getComputedStyle(held.scroller);
    const top = box.top + (parseFloat(style.scrollPaddingTop) || 0) + EDGE_ZONE, bottom = box.bottom - (parseFloat(style.scrollPaddingBottom) || 0) - EDGE_ZONE;
    const speed = held.pointerY < top ? -Math.min(1, (top - held.pointerY) / EDGE_ZONE) : held.pointerY > bottom ? Math.min(1, (held.pointerY - bottom) / EDGE_ZONE) : 0;
    if (speed) { held.scroller.scrollTop += speed * EDGE_SPEED; place(held); }
    held.frame = requestAnimationFrame(() => scrollUnder(held));
  };
  const lift = (event: PointerEvent & { currentTarget: HTMLButtonElement }, index: number) => {
    if (!phone || busy() || drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const scroller = list.closest<HTMLElement>('.settings-pane') ?? document.scrollingElement as HTMLElement;
    const rows = [...list.children] as HTMLElement[];
    const rects = rows.map(row => row.getBoundingClientRect());
    drag = { from: index, to: index, rows, centers: rects.map(rect => rect.top + rect.height / 2 + scroller.scrollTop), heights: rects.map(rect => rect.height), startY: event.clientY + scroller.scrollTop, pointerY: event.clientY, scroller, frame: 0 };
    list.classList.add('is-sorting');
    rows[index]!.classList.add('is-lifted');
    haptic('medium');
    drag.frame = requestAnimationFrame(() => scrollUnder(drag!));
  };
  const carry = (event: PointerEvent) => {
    if (!drag) return;
    drag.pointerY = event.clientY;
    place(drag);
  };
  const drop = async (event: PointerEvent & { currentTarget: HTMLButtonElement }, commit: boolean) => {
    const held = drag;
    if (!held) return;
    drag = undefined;
    cancelAnimationFrame(held.frame);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const row = held.rows[held.from]!;
    const to = commit ? held.to : held.from;
    // The row sinks into the slot it was held over while the rows stay aside; the saved list replaces them all at once.
    row.classList.remove('is-lifted');
    row.style.setProperty('--lift', `${settleOffset(held.heights, held.from, to)}px`);
    const saved = to !== held.from && await move(held.from, to);
    if (!saved) {
      held.rows.forEach(other => { other.style.translate = ''; });
      row.style.removeProperty('--lift');
    }
    list.classList.remove('is-sorting');
  };

  const rename = async (section: TodaySection, input: HTMLInputElement) => {
    const name = input.value.trim().replace(/\s+/g, ' ');
    if (name === section.name) { input.value = name; return; }
    if (!name || taken(name, section.id)) {
      input.value = section.name;
      setProblem(name ? `Another section is already called ${name}.` : 'A section needs a name.');
      return;
    }
    if (!await save({ sections: template().sections.map(value => value.id === section.id ? { ...value, name } : value) })) input.value = section.name;
  };
  const add = async () => {
    const name = draft().trim().replace(/\s+/g, ' ');
    if (!name) return;
    if (taken(name)) { setProblem(`Another section is already called ${name}.`); return; }
    // A new written section joins just before Notes, among the other written sections.
    const sections = [...template().sections];
    const notes = sections.findIndex(section => section.id === 'notes');
    sections.splice(notes < 0 ? sections.length : notes, 0, { id: ulid().toLowerCase(), name, on: true });
    if (await save({ sections })) setDraft('');
  };
  const role = (section: TodaySection) => sectionRoles[section.id] ?? 'Written section';
  // Why a section cannot be turned off, said on its row so touch screens, which have no hover, show it too.
  const locked = (section: TodaySection) => section.id === 'notes' ? 'Always on' : section.id === captureSection(template()).id ? (phone ? 'New captures land here, so it stays on' : '⌘E captures here, so it stays on') : '';
  const captureLabel = phone ? 'New captures into' : '⌘E captures into';

  const captureRows = () => <>
    <div class="settings-row">
      <div class="settings-label"><span class="settings-name">{captureLabel}</span><p>Add a task on Today lands here too.</p></div>
      <Choice label={captureLabel} value={captureSection(template()).id} disabled={busy()} options={writtenSections(template()).map(section => ({ value: section.id, label: section.name }))} onChange={id => { void save({ capture: id }); }} />
    </div>
    <div class="settings-row">
      <div class="settings-label"><span class="settings-name">A pasted link becomes</span><p>{phone ? 'In a new capture; Into can still send it elsewhere.' : 'In the ⌘E slip; Into can still send it elsewhere.'}</p></div>
      <Choice label="A pasted link becomes" value={template().links} disabled={busy()} options={links} onChange={value => { void save({ links: value }); }} />
    </div>
  </>;
  const tileSwitch = (key: typeof tiles[number][0]) => <input class="settings-switch" type="checkbox" role="switch" checked={template().tiles[key]} disabled={busy()}
    onChange={event => {
      const on = event.currentTarget.checked;
      void save({ tiles: { ...template().tiles, [key]: on } }).then(saved => { if (!saved) event.currentTarget.checked = !on; });
    }} />;

  return <section id={props.id} aria-labelledby={`${props.id}-heading`} aria-busy={busy()}>
    <Group heading={props.heading} note={phone
      ? 'Today shows these sections in order. Written sections are headings in the day’s outline; the others are lists Today draws. Drag the handle to reorder. Changes apply from today on.'
      : 'Today shows these sections in order. Written sections are headings in the day\'s outline; the others are lists Today draws. Changes apply from today on.'}>
      <ol ref={list} class="today-sections" aria-label="Today sections">
        <For each={template().sections}>{(section, index) => <li class="today-section" data-section={section.id} data-off={section.on ? undefined : ''}
          onKeyDown={event => {
            if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
            event.preventDefault();
            void move(index(), index() + (event.key === 'ArrowUp' ? -1 : 1));
          }}
          onDragOver={event => { if (dragged !== undefined) event.preventDefault(); }}
          onDrop={event => { event.preventDefault(); if (dragged !== undefined) void move(dragged, index()); dragged = undefined; }}>
          <button type="button" class="today-section-handle" draggable={!busy() && !phone} aria-label={`Move ${section.name}`} title={phone ? undefined : 'Drag, or Alt+Up and Alt+Down'}
            onDragStart={event => { dragged = index(); event.dataTransfer?.setData('text/plain', section.name); event.dataTransfer?.setDragImage(event.currentTarget.parentElement!, 16, 16); }}
            onDragEnd={() => { dragged = undefined; }}
            onPointerDown={event => lift(event, index())} onPointerMove={carry}
            onPointerUp={event => { void drop(event, true); }} onPointerCancel={event => { void drop(event, false); }}>
            <Show when={phone} fallback={<Icon name="grip" />}><span class="today-section-bars" aria-hidden="true" /></Show>
          </button>
          <span class="today-section-text">
            <input class="today-section-name" value={section.name} aria-label={`Rename ${section.name}`} maxLength={80} disabled={busy()} spellcheck={false}
              onChange={event => { void rename(section, event.currentTarget); }}
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') { event.currentTarget.value = section.name; event.currentTarget.blur(); }
              }} />
            <span class="today-section-role" id={`${props.id}-${section.id}-role`}>
              <span class="today-section-part">{role(section)}</span><Show when={!isWritten(section) && section.id !== 'notes'}> · <span class="today-section-part">Generated</span></Show>
              <Show when={locked(section)}>{reason => <span class="today-section-lock">{phone ? '' : ' · '}{reason()}</span>}</Show>
            </span>
          </span>
          <input class="settings-switch" type="checkbox" role="switch" aria-label={`Show ${section.name}`} aria-describedby={`${props.id}-${section.id}-role`}
            checked={section.on} disabled={busy() || !!locked(section)}
            onChange={event => {
              const on = event.currentTarget.checked;
              void save({ sections: template().sections.map(value => value.id === section.id ? { ...value, on } : value) }).then(saved => { if (!saved) event.currentTarget.checked = !on; });
            }} />
        </li>}</For>
      </ol>
      <form class="today-section-add" onSubmit={event => { event.preventDefault(); void add(); }}>
        <Show when={phone}><Icon name="plus" /></Show>
        <input class="input" value={draft()} placeholder="Add a section" aria-label="New section name" maxLength={80} disabled={busy()} onInput={event => { setDraft(event.currentTarget.value); setProblem(''); }} />
        <Show when={phone} fallback={<Button type="submit" class="bordered" icon="plus" disabled={busy() || !draft().trim()}>Add</Button>}>
          <Show when={draft().trim()}><Button type="submit" kind="tint" size="sm" disabled={busy()}>Add</Button></Show>
        </Show>
      </form>
      <Show when={problem()}><p class="error" role="alert">{problem()}</p></Show>
      <Show when={!phone}>
        {captureRows()}
        <div class="settings-row">
          <div class="settings-label"><span class="settings-name">Top of Today shows</span><p>The tiles above the day's title.</p></div>
          <div class="today-tiles">
            <For each={tiles}>{([key, label]) => <label class="today-tile">{tileSwitch(key)}<span>{label}</span></label>}</For>
          </div>
        </div>
      </Show>
    </Group>
    <Show when={phone}>
      <Group label="Captures">{captureRows()}</Group>
      <Group label="Top of Today shows" footnote="The tiles above the day’s title.">
        <For each={tiles}>{([key, label]) => <label class="settings-row"><span class="settings-label"><span class="settings-name">{label}</span></span>{tileSwitch(key)}</label>}</For>
      </Group>
    </Show>
  </section>;
}
