// Glyph paths without JSX, so editor widgets and tests can draw icons without the Solid runtime.

/** A glyph is a stroked path, optionally with a filled part such as a pupil or a hub. */
export type Glyph = string | readonly [stroke: string, fill: string];

export const paths = {
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
  // A gear: the clockwork of the notebook itself.
  settings: 'M12.6 8a4.6 4.6 0 1 1-9.2 0 4.6 4.6 0 0 1 9.2 0Z M9.8 8a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0Z M12.6 8h1.8 M11.25 11.25l1.28 1.28 M8 12.6v1.8 M4.75 11.25l-1.28 1.28 M3.4 8H1.6 M4.75 4.75 3.47 3.47 M8 3.4V1.6 M11.25 4.75l1.28-1.28',
  tag: 'M2 2h6l6 6-6 6-6-6z M5 5h.01',
  select: 'M2 2h5 M9 2h5 M2 14h5 M9 14h5 M2 2v5 M2 9v5 M14 2v5 M14 9v5',
  book: 'M2 2.5h4.5A1.5 1.5 0 0 1 8 4v10a1.5 1.5 0 0 0-1.5-1.5H2z M14 2.5H9.5A1.5 1.5 0 0 0 8 4v10a1.5 1.5 0 0 1 1.5-1.5H14z',
  article: 'M2 2h12v12H2z M5 5h6 M5 8h6 M5 11h4',
  quote: 'M3 4h10 M3 8h10 M3 12h6 M1 3v10',
  highlight: 'M3 13h10 M5 10l6-7 2 2-6 7H5z',
  note: 'M2 2h12v8l-4 4H2z M10 14v-4h4 M5 5h6 M5 8h4',
  contents: 'M2 3h2 M6 3h8 M4 7h2 M8 7h6 M4 11h2 M8 11h6',
  upload: 'M8 11V2 M4 6l4-4 4 4 M2 11v3h12v-3',
  download: 'M8 2v9 M4 7l4 4 4-4 M2 11v3h12v-3',
  clock: 'M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z M8 4.5V8l2.5 1.5',
  history: 'M2 6a6 6 0 1 1 0 4 M2 2v4h4 M8 4.5V8l2.5 1.5',
  repeat: 'M2 8V6.5A2.5 2.5 0 0 1 4.5 4H13 M11 2l2 2-2 2 M14 8v1.5a2.5 2.5 0 0 1-2.5 2.5H3 M5 14l-2-2 2-2',
  heading: 'M4 3v10 M12 3v10 M4 8h8',
  flag: 'M3 15V2 M3 2.5h9l-2 3 2 3H3',
  play: 'm5 3 8 5-8 5z',
  // Places on the desk, drawn from circles and rules like the oculus.
  today: 'M2 12h12 M4.5 12a3.5 3.5 0 0 1 7 0 M8 4.5V6 M3.6 6.6l1 1 M12.4 6.6l-1 1',
  agenda: ['M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z M8 2.8V4 M13.2 8H12 M8 13.2V12 M2.8 8H4 M8 8l2.6-2.2', 'M9 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z'],
  review: ['M12.9 9.4A5 5 0 1 1 12.3 5.4 M12.8 2.6v3.1H9.7', 'M9.1 8a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0Z'],
  library: 'M2.5 3.5h3v9h-3z M6.5 2.5h3v10h-3z M11 4.2l2.5 8.1',
  find: ['M1.8 8s2.4-4.2 6.2-4.2S14.2 8 14.2 8s-2.4 4.2-6.2 4.2S1.8 8 1.8 8Z M10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z', 'M8.8 8a.8.8 0 1 1-1.6 0 .8.8 0 0 1 1.6 0Z'],
  // The depth dial: one iris, its pupil widening from gloss to full.
  'depth-gloss': ['M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z', 'M9.5 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z'],
  'depth-opening': ['M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z', 'M10.6 8a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0Z'],
  'depth-perspectives': ['M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z', 'M11.7 8a3.7 3.7 0 1 1-7.4 0 3.7 3.7 0 0 1 7.4 0Z'],
  'depth-full': ['M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z', 'M12.8 8a4.8 4.8 0 1 1-9.6 0 4.8 4.8 0 0 1 9.6 0Z'],
  // Perspectives and inquiry: a holder's mark, the compare grid, the constellation, open and settled questions.
  perspective: 'M3 3h10v10H3z M6.6 11V5h1.9a1.8 1.8 0 0 1 0 3.6H6.6',
  compare: 'M2.5 3.5h11v9h-11z M6.2 3.5v9 M2.5 6.5h11 M2.5 9.5h11',
  constellation: 'M10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z M4.7 4a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0Z M14 5a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0Z M11.7 13a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0Z M6.3 6.8 4.4 4.8 M9.9 7.3l1.9-1.6 M8.8 9.8l1.2 2',
  'question-open': ['M12.9 5.6A5.5 5.5 0 1 1 10.6 3.1', 'M9.2 8a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0Z'],
  'question-settled': ['M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z', 'M10.2 8a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0Z'],
} as const satisfies Record<string, Glyph>;

export type IconName = keyof typeof paths;

/** Build an icon's SVG for code that renders outside Solid, such as CodeMirror widgets. */
export function glyphElement(name: IconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${className}`);
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const glyph: Glyph = paths[name];
  const [stroke, fill] = typeof glyph === 'string' ? [glyph, null] : glyph;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', stroke);
  svg.append(path);
  if (fill) {
    const filled = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    filled.setAttribute('d', fill);
    filled.setAttribute('fill', 'currentColor');
    filled.setAttribute('stroke', 'none');
    svg.append(filled);
  }
  return svg;
}
