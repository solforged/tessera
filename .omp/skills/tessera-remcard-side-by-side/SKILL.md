---
name: tessera-remcard-side-by-side
description: Pull up tessera (:4318) and remcard (:4317) browsers side by side to compare UI; handles already-running servers and Tern tab quirks.
---

# Tessera vs remcard side by side

Use when the user wants to compare the tessera rewrite against the remcard reference UI.

## Servers

Tessera (from ~/src/tessera):
```sh
bun run --cwd web build && cargo run -p tessera-cli -- --notebook .tessera/dev serve --assets web/dist
```
Remcard (from ~/src/remcard):
```sh
bun run --cwd web build && cargo run -p remcard-web -- --notebook .remcard/notebook
```
Both often already run from an earlier session. Tessera fails with `notebook .tessera/dev is already served by PID N on port 4318`; remcard fails with `Address already in use`. Either failure means just use the existing server; do not kill it.

## Browser

- `browser.open({url, name})`: options object is required, and always pass distinct `name`s or the second open reuses the first tab.
- Click by role, not by text, for pills and sidebar items: `tab.click('role/button[name="#claim"]')`; `text/...` misses buttons whose text is nested.
- `ariaSnapshot(undefined, {interactive: true, compact: true})` is the fastest inventory of a screen.
- Remcard: type pill click opens a menu with "Show all #tag" which opens the type table in the side pane; notebook menu (top-left button) holds Fields and Settings.
- Tessera: page header has a `Table` button opening the type table beside; sidebar has no Fields destination.

## Demo data

Both dev notebooks are thin (one journal day, one page). Seed a dozen typed rows before judging table design.
