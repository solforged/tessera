import type { JSX } from 'solid-js';

const paths = {
  search: 'm11 11 4 4 M12.5 7a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z',
  command: 'M5 6h6v6H5z M5 6V3a2 2 0 1 0-2 2h3 M11 6V3a2 2 0 1 1 2 2h-3 M5 12v1a2 2 0 1 1-2-2h3 M11 12v1a2 2 0 1 0 2-2h-3',
  left: 'm10 3-5 5 5 5', right: 'm6 3 5 5-5 5', down: 'm3 6 5 5 5-5', up: 'm3 10 5-5 5 5',
  plus: 'M8 2v12 M2 8h12', close: 'm3 3 10 10 M13 3 3 13',
  more: 'M3 8h.01 M8 8h.01 M13 8h.01',
  sidebar: 'M2 2h12v12H2z M6 2v12', panes: 'M1 2h14v12H1z M8 2v12',
  calendar: 'M2 4h12v10H2z M5 2v4 M11 2v4 M2 7h12',
  page: 'M3 1h7l3 3v11H3z M10 1v4h3',
  pin: 'm6 1 5 2-2 4 2 3-8-3 3-1z M6 9l-3 6',
  check: 'm2 8 4 4 8-8', saving: 'M13 5a5.5 5.5 0 1 0 0 6 M13 1v4H9',
  offline: 'm2 2 12 12 M2 6a10 10 0 0 1 3-2 M9 4a10 10 0 0 1 5 2 M5 9a5 5 0 0 1 2-1 M8 13h.01',
  warning: 'm8 1 7 13H1z M8 5v4 M8 11h.01', trash: 'M2 4h12 M6 2h4 M4 4l1 10h6l1-10 M7 6v5 M9 6v5',
  undo: 'M2 7V2 M2 7h5 M2 7a6 6 0 1 1 2 6',
  redo: 'M14 7V2 M14 7H9 M14 7a6 6 0 1 0-2 6',
  edit: 'm10 2 4 4-8 8H2v-4z M8 4l4 4',
  link: 'm6 10 4-4 M5 8 3 10a3 3 0 0 0 4 4l3-3 M6 5l3-3a3 3 0 0 1 4 4l-2 2',
  brokenLink: 'm1 1 14 14 M5 8l-2 2a3 3 0 0 0 4 4l1-1 M8 3l1-1a3 3 0 0 1 4 4l-1 1',
  copy: 'M5 5h9v10H5z M2 11V1h9', bullet: 'M10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  archive: 'M1 2h14v3H1z M3 5v9h10V5 M6 8h4',
  table: 'M1 2h14v12H1z M1 6h14 M6 2v12 M11 6v8',
  field: 'M2 3h12 M2 8h8 M2 13h5 M12 10v5 M10 12h4',
  settings: 'M2 4h12 M2 12h12 M5 2v4 M11 10v4',
  tag: 'M2 2h6l6 6-6 6-6-6z M5 5h.01',
  select: 'M2 2h5 M9 2h5 M2 14h5 M9 14h5 M2 2v5 M2 9v5 M14 2v5 M14 9v5',
  book: 'M2 2.5h4.5A1.5 1.5 0 0 1 8 4v10a1.5 1.5 0 0 0-1.5-1.5H2z M14 2.5H9.5A1.5 1.5 0 0 0 8 4v10a1.5 1.5 0 0 1 1.5-1.5H14z',
  quote: 'M3 4h10 M3 8h10 M3 12h6 M1 3v10',
  highlight: 'M3 13h10 M5 10l6-7 2 2-6 7H5z',
  contents: 'M2 3h2 M6 3h8 M4 7h2 M8 7h6 M4 11h2 M8 11h6',
  upload: 'M8 11V2 M4 6l4-4 4 4 M2 11v3h12v-3',
  download: 'M8 2v9 M4 7l4 4 4-4 M2 11v3h12v-3',
} as const;
export type IconName = keyof typeof paths;
export function Icon(props: { name: IconName; class?: string }): JSX.Element {
  return <svg class={`icon ${props.class ?? ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[props.name]} /></svg>;
}
