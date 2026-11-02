---
name: cutting-tessera-releases
description: "Prepares, lands and tags Tessera GitHub releases (vX.Y.Z with macOS, Linux and Android assets); use when the user requests a new release, including changelog curation, upgrade smoke and signing checks."
---

# Cutting a Tessera release

`docs/releasing.md` is the process. Do not run `gh release create`. A `v*` tag
push runs `.github/workflows/release.yml`, which refuses a tag that does not
match `Cargo.toml` or a changelog section that is missing or still marked draft.

Follow
[`managing-tessera-task-workspaces`](../managing-tessera-task-workspaces/SKILL.md)
to prepare/source the release workspace and run. Execute mise/gh commands with
tool `cwd: TASK_SOURCE`, and scope Git with `-C "$TASK_SOURCE"`.

Authorize the actual version/tag/publication; Mac shipping, tailnet APK
publication and device installation remain separate actions. Retain release
proof/assets in `TASK_EVIDENCE` and leave managed publish caches under their
persistent owner.

## Getting the version commit onto main

Use `shipping-tessera-live-builds`, “Land a change on main”, for the
protected-main rulesets, required CI checks and landing workflow. See also
`docs/releasing.md`, “Land a change on main”.

0. Before tagging a minor bump with migrations since the last tag, run the
   previous-release upgrade smoke in `smoke-testing-tessera-migrations`. A patch
   release whose only migration was already upgrade-smoked from the previous
   release's schema before landing can skip it; say so in the report.
1. Fetch with `git -C <selected-checkout> fetch -q origin`, then prepare the
   owned release source at the explicit intended `origin/main` commit through
   the shared lifecycle. Do not mutate the dirty shared tree to obtain the
   release base.
2. `mise run release:prepare -- X.Y.Z`. It bumps the workspace version, rewrites
   `Cargo.lock`, and prepends a changelog draft.
3. Edit `CHANGELOG.md` as below. Delete the `<!-- draft: ... -->` line.
4. `mise run release:cut -- X.Y.Z --push` (run async; ~15 min). It lands the
   version commit with `mise run land -- omp/release-X.Y.Z --wait`, then pushes
   the tag at that same SHA. The action fast-forwards main without rewriting
   commits or signatures, and GitHub deletes the `omp/release-X.Y.Z` branch
   itself (a later `git push --delete` fails harmlessly). A detached worktree is
   fine: land pushes `HEAD` to the branch.
5. If main moves before CI finishes, the workflow comments on the PR instead of
   landing. Fetch/rebase only the owned release branch with
   `git -C "$TASK_SOURCE" fetch origin` and
   `git -C "$TASK_SOURCE" rebase origin/main`, then rerun `mise run land` there
   with the same branch name. Push the tag only at the landed version SHA,
   following the protected-main procedure if a leased branch update is required.
6. Watch from `TASK_SOURCE`: `gh run list -w release.yml -L 1`, then
   `gh run watch <id> --exit-status` (~12–20 min). Assets: `latest.json`,
   `SHA256SUMS`, `darwin` and `linux` tarballs, `.app.tar.gz` + `.sig`, `.dmg`,
   `.apk`. Check `gh release download vX.Y.Z -p latest.json -O -` reports the
   version; put retained downloads and verification in `TASK_EVIDENCE`.
7. Tell peers the landed sha and that new changelog bullets go under empty
   `## Unreleased`. If Mac shipping is authorized, run
   `mise run ship <landed-sha>` from `TASK_SOURCE` and check `/api/service`
   reports the version. A GitHub release does not replace
   `/Applications/Tessera.app`. Retain evidence and follow shared teardown;
   peers reconcile their own checkouts.

The fast-forward workflow dispatches the browser demo deploy after each landing.
Failures open or update one issue labeled `demo-deploy`; the next good deploy
closes it. Roll it back with
`gh workflow run demo.yml --ref main -f ref=<commit>`. Do not delete the latest
GitHub release; installed apps poll its `latest.json`. Publish a newer patch
instead.

## Upgrade smoke (previous release → new build)

Use `smoke-testing-tessera-migrations`, “Previous release → new build”, for the
old-tag fixture, shared-endpoint snapshots, migration checks and browser
mutation.

## Changelog

`release:prepare` inserts a draft of capitalized commit subjects after
`<!-- releases -->` and leaves the hand-written `## Unreleased` section below
it. Do not publish that draft. The curated Unreleased section is the release
notes.

After prepare, edit only the generated draft section and draft marker in the
owned checkout; do not restore the whole changelog over curated work. Keep the
hand-written notes and place `## X.Y.Z, DATE` below an empty `## Unreleased`.
DATE is today's UTC date from `date -u +%F`, not the previous section's date.
Published notes are that version section up to the next `##`. Use American spelling
throughout the published notes.

Add user-visible work committed after the last changelog touch: use
`git -C "$TASK_SOURCE" log vPREV..origin/main --oneline`, and for each
`feat`/`fix` that did not touch CHANGELOG.md, search Unreleased before writing a
bullet in its voice. Skip commit-subject wording.

`mise run release:notes -- X.Y.Z --published` must succeed before `release:cut`
(it fails with "still a draft" while the draft marker remains).

## Android signing

Use `distributing-tessera-android-apks` for release/debug signer compatibility,
key alias and Keychain lookup, the `ANDROID_KEYSTORE` and
`ANDROID_KEYSTORE_PASSWORD` GitHub secrets, phone-signer checks, and
publishing/verifying the release-signed tailnet APK after a release. Never
uninstall on the user's behalf: it deletes the phone's notebook. A release APK
must not be described as requiring an uninstall without checking the phone's
signer first.

- Local signed build, with tool `cwd: TASK_SOURCE` and normal host HOME:
  `TESSERA_ANDROID_KEYSTORE=~/.android/tessera-release.jks TESSERA_ANDROID_KEYSTORE_PASSWORD=… CARGO_TARGET_DIR="$TASK_TARGET" mise run android:build --target aarch64 --apk`;
  output: `.../apk/universal/release/app-universal-release.apk`. Use the shared
  target/exception procedure; never substitute a debug APK for release
  acceptance.
- Check with `apksigner verify --print-certs` (SHA-256 starts `985788718fa4`)
  and `aapt2 dump badging` (`versionName` = workspace version, `versionCode` =
  major*1000000+minor*1000+patch, e.g. 5001 for 0.5.1).

## CI gotchas

- Run `cargo fmt --all -- --check` (part of `mise run lint`, the CI "Format and
  Clippy" step) before landing any Rust change; lane patches often arrive
  unformatted, and a `fmt` failure costs a full land cycle.
- The `mise` `android-sdk@23.0` `sdkmanager --licenses` no longer records
  acceptance. The workflow writes `\n24333f8a63b6825ea9c5514f83c2829b004d1fee`
  to `$(mise where android-sdk@23.0)/licenses/android-sdk-license` after
  `mise install android-sdk@23.0`; without it, Gradle fails on platform 37 and
  build-tools 36.
- `NDK_HOME="$ANDROID_NDK_LATEST_HOME"` on `ubuntu` runners.
- CI runs only for pull requests (and by hand:
  `gh workflow run ci.yml --ref <branch>`). A bare temp branch push does not run
  CI. To trial a workflow change before tagging, use a pull request with a copy
  of the job (no `needs`, `TAG` hard-coded, `actions/upload-artifact` in place
  of the release upload). Remove the trial-only job before landing through
  `mise run land`.
- macOS `/bin/bash` is 3.2. Release scripts must not use `[[ =~ ]]` with nested
  groups; that is a syntax error before the script runs.
