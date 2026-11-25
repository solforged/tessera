/**
 * The platform's status and navigation bars. Android hides them while the reader's chrome is away, so a page reads
 * to the screen's edges; other platforms have none to hide.
 */
let hideBars: (hidden: boolean) => void = () => {};

export function setSystemBarsHandler(handler: (hidden: boolean) => void) {
  hideBars = handler;
}

export function setSystemBarsHidden(hidden: boolean) {
  hideBars(hidden);
}
