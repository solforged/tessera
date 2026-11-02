---
name: tessera-remcard-side-by-side
description: Pull up tessera (:4318) and remcard (:4317) browsers side by side to compare UI; handles already-running servers and Tern tab quirks.
---

# Tessera vs remcard side by side

Use when the user wants to compare the tessera rewrite against the remcard reference UI.

Follow [managing-tessera-task-workspaces](../../../.agents/skills/managing-tessera-task-workspaces/SKILL.md) to prepare/source the comparison workspaces and separate runs. The RemCard checkout/toolchain and permitted fixture are external prerequisites; neither side may use live/dev notebooks.

## Servers

Tessera: stage matching `TASK_BIN`/`TASK_DIST` by the shared procedure and serve a fresh private notebook as a unique named service:
```sh
task_run "$TASK_BIN" --workshop "$TASK_RUN/notebooks/tessera-comparison" serve --port <owned-free-http> --sync-port <owned-free-sync> --assets "$TASK_DIST"
```
Record readiness, both actual ports, origin and `/api/service` build. A permitted notebook copy uses `/usr/bin/sqlite3` online backup plus objects on Mac, copied-lock removal only at the verified owned destination, and clearing the copy's current-schema `sync_hub` before serving.

RemCard: in a separate shell/allocation, use the same originating shared procedure with its selected owned RemCard checkout and explicit base, preserving that repository's rules and its own build/runtime environment rather than overwriting the Tessera allocation. Build its dependencies/assets from that checkout and use only a private notebook under its run. Resolve the supported private-notebook, loopback-port and asset configuration from that repository before launching its named service; this skill does not supply unverified replacement CLI flags. If the available RemCard build cannot serve an owned private fixture/origin, report that prerequisite rather than falling back to `.remcard/notebook` or the existing :4317 service.

An already-running listener is not permission to use its notebook or proof that it matches the desired build. Never kill or reuse it merely because the example port collided; select private free ports and verify the recorded handles instead.

## Browser

- Use the shared owned browser launcher/CDP procedure separately for each side. Attach `browser.open({name, app:{cdp_url}})` to each recorded endpoint and navigate to its owned origin; distinct names and profiles prevent accidental tab reuse.
- Click by role, not by text, for pills and sidebar items: `tab.click('role/button[name="#claim"]')`; `text/...` misses buttons whose text is nested.
- `ariaSnapshot(undefined, {interactive: true, compact: true})` is the fastest inventory of a screen.
- Remcard: type pill click opens a menu with "Show all #tag" which opens the type table in the side pane; notebook menu (top-left button) holds Fields and Settings.
- Tessera: page header has a `Table` button opening the type table beside; sidebar has no Fields destination.

## Demo data

Seed a dozen typed rows only in the two verified owned comparison notebooks before judging table design; never seed the original dev/live notebooks. If copying permitted data, use the source repository's supported consistent-copy/detachment procedure and retain fixture provenance.

## Handoff and cleanup

Retain matched captures/comparisons and each side's provenance in its `TASK_EVIDENCE`, then follow shared teardown independently for both allocations.
