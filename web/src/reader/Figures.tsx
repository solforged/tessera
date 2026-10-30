/** A phrase with its numbers set as figures: mono digits, plain words (`3 h 50 min left in book`). */
export function Figures(props: { text: string }) {
  return <>{props.text.split(/(\d+)/).map((part, index) => index % 2 ? <span class="fig">{part}</span> : part)}</>;
}
