import { For, Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { ulid } from 'ulid';
import type { NotebookClient } from '../document/contract';
import { foldName } from '../outline/names';
import { captureSection, isWritten, sectionRoles, writtenSections } from '../tasks/today-template';
import type { TodaySection, TodayTemplate } from '../tasks/today-template';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

const tiles = [['agenda', 'Agenda'], ['review', 'Review'], ['reading', 'Reading']] as const;

/**
 * Settings › Today: the workshop's one template. Sections reorder by dragging the handle or with Alt+Up and Alt+Down,
 * rename in place and switch on or off; Notes and the capture section stay on.
 */
export function TodaySettings(props: { id: string; heading: JSX.Element; pane: string; notebook: NotebookClient }) {
  const template = () => props.notebook.todayTemplate();
  const busy = () => props.notebook.settingsBusy();
  const [problem, setProblem] = createSignal('');
  const [draft, setDraft] = createSignal('');
  let list!: HTMLOListElement;
  let dragged: number | undefined;
  const save = async (next: Partial<TodayTemplate>) => {
    setProblem('');
    try { await props.notebook.setSetting('today_template', JSON.stringify({ ...template(), ...next })); return true; }
    catch { return false; /* The document shows the save error and keeps the acknowledged template. */ }
  };
  const taken = (name: string, except?: string) => template().sections.some(section => section.id !== except && foldName(section.name) === foldName(name));
  const move = async (from: number, to: number) => {
    const sections = [...template().sections];
    if (to < 0 || to >= sections.length || from === to) return;
    const [section] = sections.splice(from, 1);
    sections.splice(to, 0, section!);
    if (await save({ sections })) requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-section="${section!.id}"] .today-section-handle`)?.focus());
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
  const locked = (section: TodaySection) => section.id === 'notes' ? 'Always on' : section.id === captureSection(template()).id ? '⌘E captures here, so it stays on' : '';

  return <section id={props.id} aria-labelledby={`${props.id}-heading`} aria-busy={busy()}>
    {props.heading}
    <p class="settings-empty">Today shows these sections in order. Written sections are headings in the day's outline; the others are lists Today draws. Changes apply from today on.</p>
    <ol ref={list} class="today-sections" aria-label="Today sections">
      <For each={template().sections}>{(section, index) => <li class="today-section" data-section={section.id} data-off={section.on ? undefined : ''}
        onKeyDown={event => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
          event.preventDefault();
          void move(index(), index() + (event.key === 'ArrowUp' ? -1 : 1));
        }}
        onDragOver={event => { if (dragged !== undefined) event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); if (dragged !== undefined) void move(dragged, index()); dragged = undefined; }}>
        <button type="button" class="today-section-handle" draggable={!busy()} aria-label={`Move ${section.name}`} title="Drag, or Alt+Up and Alt+Down"
          onDragStart={event => { dragged = index(); event.dataTransfer?.setData('text/plain', section.name); event.dataTransfer?.setDragImage(event.currentTarget.parentElement!, 16, 16); }}
          onDragEnd={() => { dragged = undefined; }}><Icon name="grip" /></button>
        <span class="today-section-text">
          <input class="today-section-name" value={section.name} aria-label={`Rename ${section.name}`} maxLength={80} disabled={busy()} spellcheck={false}
            onChange={event => { void rename(section, event.currentTarget); }}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') { event.currentTarget.value = section.name; event.currentTarget.blur(); }
            }} />
          <span class="today-section-role" id={`${props.id}-${section.id}-role`}>{role(section)}<Show when={!isWritten(section) && section.id !== 'notes'}> · Generated</Show><Show when={locked(section)}>{reason => <span class="today-section-lock"> · {reason()}</span>}</Show></span>
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
      <input class="input" value={draft()} placeholder="Add a section" aria-label="New section name" maxLength={80} disabled={busy()} onInput={event => { setDraft(event.currentTarget.value); setProblem(''); }} />
      <Button type="submit" class="bordered" icon="plus" disabled={busy() || !draft().trim()}>Add</Button>
    </form>
    <Show when={problem()}><p class="error" role="alert">{problem()}</p></Show>
    <div class="settings-row">
      <div class="settings-label"><span class="settings-name">⌘E captures into</span><p>Add a task on Today lands here too.</p></div>
      <div class="mode-tabs settings-segments" role="group" aria-label="⌘E captures into">
        <For each={writtenSections(template())}>{section =>
          <Button aria-pressed={captureSection(template()).id === section.id} disabled={busy()} onClick={() => { void save({ capture: section.id }); }}>{section.name}</Button>}</For>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label"><span class="settings-name">A pasted link becomes</span><p>In the ⌘E slip; Into can still send it elsewhere.</p></div>
      <div class="mode-tabs settings-segments" role="group" aria-label="A pasted link becomes">
        <For each={[['link', 'A link'], ['source', 'A source']] as const}>{([value, label]) =>
          <Button aria-pressed={template().links === value} disabled={busy()} onClick={() => { void save({ links: value }); }}>{label}</Button>}</For>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-label"><span class="settings-name">Top of Today shows</span><p>The tiles above the day's title.</p></div>
      <div class="today-tiles">
        <For each={tiles}>{([key, label]) => <label class="today-tile">
          <input class="settings-switch" type="checkbox" role="switch" checked={template().tiles[key]} disabled={busy()}
            onChange={event => {
              const on = event.currentTarget.checked;
              void save({ tiles: { ...template().tiles, [key]: on } }).then(saved => { if (!saved) event.currentTarget.checked = !on; });
            }} />
          <span>{label}</span>
        </label>}</For>
      </div>
    </div>
  </section>;
}
