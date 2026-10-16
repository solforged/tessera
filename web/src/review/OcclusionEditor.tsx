import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { ulid } from 'ulid';
import type { ImageRef, Occlusion, OcclusionMask } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { Button } from '../ui/Button';
import { NotebookImage } from '../ui/NotebookImage';
import { groupLetter } from './card-text';
import { MaskShape } from './OcclusionFigure';
import { prepareOcclusionDraft } from './occlusion-draft';
import './occlusion.css';

type Point = { x: number; y: number };
type Gesture = { pointer: number; start: Point; before: Occlusion; kind: 'draw' | 'move' | 'resize' | 'area'; mask?: string; corner?: string; moved: boolean; duplicate?: string };
const clone = (state: Occlusion): Occlusion => JSON.parse(JSON.stringify(state));
const clamp = (value: number, lower = 0, upper = 1) => Math.max(lower, Math.min(upper, value));

export function OcclusionEditor(props: { id: string; image: ImageRef; caption: string; state: Occlusion | null; notebook: NotebookClient; doc: PageDocument; onClose(): void }) {
  const initial = clone(props.state ?? { mode: 'hide_one', groups: [], masks: [] });
  const [draft, setDraft] = createSignal(initial);
  const [selected, setSelected] = createSignal<string[]>([]);
  const [shape, setShape] = createSignal<OcclusionMask['shape']>('rect');
  const [areaMode, setAreaMode] = createSignal(false);
  const [discard, setDiscard] = createSignal(false);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const undo: Occlusion[] = [], redo: Occlusion[] = [];
  let root!: HTMLDialogElement, overlay!: SVGSVGElement;
  let gesture: Gesture | undefined, longPress: number | undefined, inputHistory = '';
  const selectedGroup = createMemo(() => selected().length === 1 ? draft().groups.find(group => group.id === selected()[0]) : undefined);
  const dirty = () => JSON.stringify(initial) !== JSON.stringify(draft());
  function change(update: (state: Occlusion) => void, coalesce = '') {
    const before = draft(), next = clone(before);
    update(next);
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    if (!coalesce || coalesce !== inputHistory) undo.push(before);
    inputHistory = coalesce; redo.length = 0; setError(''); setDraft(next);
  }
  function history(backwards: boolean) {
    const from = backwards ? undo : redo, to = backwards ? redo : undo, next = from.pop();
    if (!next) return;
    to.push(draft()); setDraft(next); setSelected([]); setAreaMode(false); inputHistory = '';
  }
  function close() {
    if (busy()) return;
    if (dirty()) setDiscard(true); else props.onClose();
  }
  function escape() {
    if (selected().length || areaMode()) { setSelected([]); setAreaMode(false); }
    else close();
  }
  function clean(state: Occlusion) {
    state.groups = state.groups.filter(group => state.masks.some(mask => mask.group === group.id));
  }
  function remove() {
    change(state => { state.masks = state.masks.filter(mask => !selected().includes(mask.group)); clean(state); });
    setSelected([]); setAreaMode(false);
  }
  function group() {
    const first = draft().groups.find(group => selected().includes(group.id));
    if (!first) return;
    change(state => { for (const mask of state.masks) if (selected().includes(mask.group)) mask.group = first.id; clean(state); });
    setSelected([first.id]);
  }
  function ungroup() {
    const ids: string[] = [];
    change(state => {
      state.groups = state.groups.flatMap(group => {
        if (!selected().includes(group.id)) return [group];
        return state.masks.filter(mask => mask.group === group.id).map((mask, index) => {
          const id = index ? ulid() : group.id; mask.group = id; ids.push(id); return { ...group, id };
        });
      });
    });
    setSelected(ids);
  }
  function point(event: PointerEvent): Point {
    const bounds = overlay.getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) };
  }
  function pointerDown(event: PointerEvent) {
    if (busy() || event.button !== 0 || gesture) return;
    event.preventDefault(); overlay.focus(); inputHistory = '';
    const element = event.target as Element, id = element.closest('[data-mask]')?.getAttribute('data-mask') ?? undefined;
    const mask = draft().masks.find(mask => mask.id === id), corner = element.getAttribute('data-corner') ?? undefined;
    const before = draft(), oldSelection = selected();
    if (mask && !areaMode()) {
      if (event.shiftKey) setSelected(groups => groups.includes(mask.group) ? groups : [...groups, mask.group]);
      else if (!oldSelection.includes(mask.group)) setSelected([mask.group]);
      if (event.pointerType === 'touch') longPress = window.setTimeout(() => { setSelected([...new Set([...oldSelection, mask.group])]); }, 500);
    }
    gesture = { pointer: event.pointerId, start: point(event), before, kind: areaMode() && selectedGroup() ? 'area' : mask ? corner ? 'resize' : 'move' : 'draw', mask: id, corner, moved: false, duplicate: event.altKey ? ulid() : undefined };
    overlay.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent) {
    const active = gesture;
    if (!active || active.pointer !== event.pointerId) return;
    const end = point(event), dx = end.x - active.start.x, dy = end.y - active.start.y;
    if (!active.moved && Math.hypot(dx, dy) < .005) return;
    clearTimeout(longPress); active.moved = true;
    const next = clone(active.before);
    if (active.kind === 'draw') {
      const rect = { x: Math.min(active.start.x, end.x), y: Math.min(active.start.y, end.y), w: Math.abs(dx), h: Math.abs(dy) };
      if (rect.w >= .005 && rect.h >= .005) {
        active.mask ??= ulid();
        next.groups.push({ id: active.mask }); next.masks.push({ id: active.mask, group: active.mask, shape: shape(), ...rect });
      }
    } else if (active.kind === 'area') {
      const group = next.groups.find(group => group.id === selected()[0]);
      if (group && Math.abs(dx) >= .005 && Math.abs(dy) >= .005) group.area = { x: Math.min(active.start.x, end.x), y: Math.min(active.start.y, end.y), w: Math.abs(dx), h: Math.abs(dy) };
    } else {
      let mask = next.masks.find(mask => mask.id === active.mask);
      if (!mask) return;
      if (active.kind === 'move') {
        if (active.duplicate) { mask = { ...mask, id: active.duplicate }; next.masks.push(mask); }
        mask.x = clamp(mask.x + dx, 0, 1 - mask.w); mask.y = clamp(mask.y + dy, 0, 1 - mask.h);
      } else {
        const right = mask.x + mask.w, bottom = mask.y + mask.h;
        if (active.corner?.includes('w')) { mask.x = clamp(mask.x + dx, 0, right - .005); mask.w = right - mask.x; }
        else mask.w = clamp(mask.w + dx, .005, 1 - mask.x);
        if (active.corner?.includes('n')) { mask.y = clamp(mask.y + dy, 0, bottom - .005); mask.h = bottom - mask.y; }
        else mask.h = clamp(mask.h + dy, .005, 1 - mask.y);
      }
    }
    setDraft(next);
  }
  function pointerEnd(event: PointerEvent, cancel = false) {
    const active = gesture;
    if (!active || active.pointer !== event.pointerId) return;
    clearTimeout(longPress); gesture = undefined;
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    if (cancel) setDraft(active.before);
    else if (active.moved && JSON.stringify(active.before) !== JSON.stringify(draft())) {
      undo.push(active.before); redo.length = 0;
      if (active.kind === 'draw' && active.mask) setSelected([active.mask]);
    }
    else if (!active.moved && active.kind === 'draw') setSelected([]);
    if (active.kind === 'area') setAreaMode(false);
  }
  function keydown(event: KeyboardEvent) {
    event.stopPropagation();
    const input = (event.target as Element).closest('input, textarea');
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); history(!event.shiftKey); return; }
    if (event.key === 'Escape') { event.preventDefault(); escape(); return; }
    if (input || !selected().length || busy()) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); return; }
    const nudge = event.shiftKey ? .05 : .01;
    const dx = event.key === 'ArrowLeft' ? -nudge : event.key === 'ArrowRight' ? nudge : 0;
    const dy = event.key === 'ArrowUp' ? -nudge : event.key === 'ArrowDown' ? nudge : 0;
    if (dx || dy) {
      event.preventDefault();
      change(state => { for (const mask of state.masks) if (selected().includes(mask.group)) { mask.x = clamp(mask.x + dx, 0, 1 - mask.w); mask.y = clamp(mask.y + dy, 0, 1 - mask.h); } });
    }
  }
  async function save() {
    if (busy()) return;
    setBusy(true); setError('');
    try {
      const occlusion = prepareOcclusionDraft(draft());
      const result = props.doc.edit({ kind: 'occlusion', id: props.id, occlusion });
      if (!result.ok) throw new Error(result.reason);
      await props.doc.flush();
      if (props.doc.saveState() === 'conflict' || props.doc.saveState() === 'error') throw new Error(props.doc.saveMessage());
      props.onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  onMount(() => root.showModal());
  onCleanup(() => clearTimeout(longPress));
  return <Portal><dialog ref={root} class="occlusion-editor" aria-label="Edit image masks" onCancel={event => { event.preventDefault(); escape(); }} onKeyDown={keydown}>
    <header class="occlusion-header"><p>{props.caption || 'Image'}</p><Button disabled={busy()} onClick={close}>Close</Button></header>
    <div class="occlusion-toolbar" role="toolbar" aria-label="Edit image masks">
      <Button aria-pressed={shape() === 'rect'} onClick={() => setShape('rect')}>Rectangle</Button>
      <Button aria-pressed={shape() === 'ellipse'} onClick={() => setShape('ellipse')}>Ellipse</Button>
      <Button aria-pressed={draft().mode === 'hide_one'} onClick={() => change(state => { state.mode = 'hide_one'; })}>Hide one</Button>
      <Button aria-pressed={draft().mode === 'hide_all'} onClick={() => change(state => { state.mode = 'hide_all'; })}>Hide all</Button>
      <Button disabled={selected().length < 2} onClick={group}>Group</Button>
      <Button disabled={!selected().length} onClick={ungroup}>Ungroup</Button>
      <Button disabled={!selectedGroup()} aria-pressed={areaMode()} onClick={() => setAreaMode(value => !value)}>Area</Button>
      <Show when={areaMode() && selectedGroup()?.area}><Button onClick={() => { change(state => { delete state.groups.find(group => group.id === selected()[0])!.area; }); setAreaMode(false); }}>Clear area</Button></Show>
      <Button disabled={!selected().length} onClick={remove}>Delete</Button>
    </div>
    <div class="occlusion-stage"><div class="occlusion-editor-image" style={{ '--image-ratio': props.image.width / props.image.height }}>
      <NotebookImage image={props.image} api={props.notebook.api} alt={props.caption || 'Image'} draggable={false} />
      <svg ref={overlay} viewBox="0 0 1 1" preserveAspectRatio="none" tabIndex={0} aria-label="Edit image masks" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => pointerEnd(event)} onPointerCancel={event => pointerEnd(event, true)}>
        <For each={draft().masks}>{mask => <g data-mask={mask.id} role="button" aria-label={`Mask ${groupLetter(draft().groups.findIndex(group => group.id === mask.group))}`} aria-pressed={selected().includes(mask.group)}>
          <MaskShape mask={mask} class={selected().includes(mask.group) ? 'occlusion-mask occlusion-selected' : 'occlusion-mask'} />
          <text class="occlusion-letter" font-size=".025" x={mask.x + mask.w / 2} y={mask.y + mask.h / 2} text-anchor="middle" dominant-baseline="central">{groupLetter(draft().groups.findIndex(group => group.id === mask.group))}</text>
          <Show when={selected().includes(mask.group)}><For each={['nw', 'ne', 'sw', 'se']}>{corner => <rect class="occlusion-handle" data-corner={corner} x={(corner.includes('w') ? mask.x : mask.x + mask.w) - .006} y={(corner.includes('n') ? mask.y : mask.y + mask.h) - .006} width=".012" height=".012" vector-effect="non-scaling-stroke" />}</For></Show>
        </g>}</For>
        <Show when={selectedGroup()?.area}>{area => <rect class="occlusion-area" x={area().x} y={area().y} width={area().w} height={area().h} vector-effect="non-scaling-stroke" />}</Show>
      </svg>
    </div></div>
    <Show when={selectedGroup()}>{group => <div class="occlusion-inputs"><For each={['hint', 'answer'] as const}>{key => <label>{key === 'hint' ? 'Hint' : 'Answer'}<input class="input" value={group()[key] ?? ''} onBlur={() => { inputHistory = ''; }} onInput={event => { const text = event.currentTarget.value; change(state => { state.groups.find(value => value.id === group().id)![key] = text; }, `${group().id}:${key}`); }} /></label>}</For></div>}</Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <footer class="occlusion-footer"><span>{draft().groups.length} {draft().groups.length === 1 ? 'card' : 'cards'} · {draft().masks.length} {draft().masks.length === 1 ? 'mask' : 'masks'}</span><Button disabled={busy()} onClick={close}>Cancel</Button><Button class="bordered" disabled={busy()} onClick={() => void save()}>Save</Button></footer>
    <Show when={discard()}><div class="occlusion-discard" role="alertdialog" aria-label="Discard changes to these masks?"><p>Discard changes to these masks?</p><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button onClick={() => props.onClose()}>Discard</Button></div></Show>
  </dialog></Portal>;
}
