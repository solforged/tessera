import { For } from 'solid-js';

/** Digit runs of a phrase, set as figures (the phone shows them in mono); the words around them stay as written. */
export function Figures(props: { text: string }) {
  return <For each={props.text.split(/(\d+)/)}>{(part, index) => index() % 2 ? <span class="journal-fig">{part}</span> : part}</For>;
}

/** A task fact's clock, `17:30`, set as a figure (the phone shows it in mono); the words before it stay as written. */
export function ClockFigure(props: { text: string }) {
  return <For each={props.text.split(/(\d{1,2}:\d{2})/)}>{(part, index) => index() % 2 ? <span class="journal-time">{part}</span> : part}</For>;
}
