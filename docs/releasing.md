# Releasing

Tessera has three publishes. They are not interchangeable.

| Publish | Who it is for | Command |
|---|---|---|
| GitHub release | Anyone downloading the app | `mise run release:cut -- <version> --push` |
| Browser demo | Anyone trying it at <https://tessera.solforged.io> | Landing a pull request on `main`, or a manual dispatch |
| This Mac, and the tailnet APK | The machine you are using | `mise run ship` and `mise run android:publish` |

`ship` and `android:publish` build one commit into the local app or the tailnet download page. They do not create a GitHub release, and a GitHub release does not replace the app on this Mac.

## Land a change on main

`main` takes no direct pushes and no merge or squash commits. A change lands through a pull request whose head is moved onto `main` as it is, so every commit keeps its SHA and signature.

```sh
git fetch && git rebase origin/main
mise run land                       # one commit: its subject is the title
mise run land -- --title "fix(review): …" --issue 12 --wait
```

`land` pushes `HEAD` to `omp/<short sha>` (or the branch you name) and opens a pull request with the `fast-forward` label. [`.github/workflows/fast-forward.yml`](../.github/workflows/fast-forward.yml) moves `main` to that head when CI passes on it, deletes the branch, and deploys the demo. `--wait` returns once `main` is there, and fails if a required check fails or `main` moves underneath.

Two rulesets guard `main`:

| Ruleset | Rules | Bypass |
|---|---|---|
| `green` | Signed commits, linear history, no force-push or deletion, and the seven CI checks on the new head | Nobody |
| `reviewed` | Changes arrive through a pull request | Deploy keys. The fast-forward workflow pushes with the write key in the `FAST_FORWARD_KEY` secret. |

If `main` moves before CI finishes, the workflow comments on the pull request instead of landing it. Rebase onto `origin/main` and run `land` again; the new head lands when its CI passes. A pull request without the label, or a draft, waits until the label is added or it is marked ready. CI runs once per pull request push, and not again on `main`, which only ever moves to a head that passed. Branches without a pull request do not run CI; `gh workflow run ci.yml --ref <branch>` runs it by hand.

A pull request that changes only `web/` (outside `web/src/fields/`, which Rust tests read), `docs/` or Markdown files skips the steps of `rust`, `browser wasm build` and `backend correctness and scaling`, so those checks pass within seconds. `android app` and `embedded release assets` build the editor and always run.

GitHub only lets an organization's own apps bypass a ruleset, so on this personal repository the workflow token cannot move `main`. A deploy key can, and only this workflow holds the write key. To rotate it, generate a key, add it under Settings → Deploy keys with write access, and replace the secret with `gh secret set FAST_FORWARD_KEY`.

Use an issue for a user-visible bug or feature and pass `--issue`, so the pull request closes it. Chores, docs and lockfile updates need no issue.

## Cut a version

Run this from a clean worktree of `origin/main`, not from a tree that holds another session's edits.

```sh
mise run release:prepare -- 0.4.0
```

The task:

1. Refuses a version that is not newer than `Cargo.toml`, or a tag that already exists.
2. Sets the workspace version and rewrites the workspace entries in `Cargo.lock`.
3. Prepends a changelog draft built from commits since the latest `v*` tag.

Edit `CHANGELOG.md`. Delete the `<!-- draft: ... -->` line. Group or drop bullets that are not what the release should say. Then:

```sh
mise run release:cut -- 0.4.0
mise run release:cut -- 0.4.0 --push
```

Without `--push`, the tag stays local. With `--push`, the task lands the version commit through `mise run land -- omp/release-<version> --wait`, then pushes `v0.4.0` at that same commit. [`.github/workflows/release.yml`](../.github/workflows/release.yml) creates the release. Do not run `gh release create`.

The workflow refuses a tag whose version does not match `Cargo.toml`, or whose changelog section is missing or still marked draft. It publishes the notes from that section, then uploads `SHA256SUMS` after every asset is present. A failed macOS, Linux or Android job leaves the release in place, marks it incomplete and fails the workflow.

| Asset | What it is |
|---|---|
| `Tessera_<version>_aarch64.dmg` | macOS app. Ad-hoc signed, not notarized. |
| `Tessera_<version>_aarch64.app.tar.gz` and `.sig` | Signed updater archive. Installed apps poll `latest.json`. |
| `tessera-v<version>-aarch64-apple-darwin.tar.gz` | macOS command line. |
| `tessera-v<version>-x86_64-unknown-linux-gnu.tar.gz` | Linux command line. |
| `Tessera_<version>_aarch64.apk` | Android app, signed with the release key. |
| `SHA256SUMS` | Checksums of the files above. |
| `latest.json` | Updater manifest. It must be on the release before that release is the latest one. |

`mise run release:finish -- v0.4.0` can upload `SHA256SUMS` again if the workflow stopped after the assets were published.

## Browser demo

[`.github/workflows/demo.yml`](../.github/workflows/demo.yml) deploys each commit the fast-forward workflow moves `main` to, after CI passed on it. A red CI run never lands, so the previous demo stays. The deploy then requests <https://tessera.solforged.io> and fails if it does not serve this build's entry script. A failed deploy opens one issue labelled `demo-deploy`, or comments on the open one, and the next good deploy closes it.

To publish a chosen commit, or to put the demo back on an earlier one:

```sh
gh workflow run demo.yml --ref main -f ref=<commit>
```

A manual dispatch does not wait for CI. Use a commit whose CI already passed.

The demo needs `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`. Without the token, the workflow builds and does not deploy.

## This Mac and the phone

`mise run ship [commit]` builds that commit in `~/Library/Caches/tessera/ship` and installs it over `/Applications/Tessera.app`. Uncommitted edits never ship. If the new build does not answer, the previous app and notebook backup are restored.

`mise run android:publish [commit]` builds a signed APK and replaces the page at `https://<this Mac>.<tailnet>:8443/`. That page is on the tailnet only. It can update a phone that installed a GitHub release APK, and the other way around, because both use the release key.

## Secrets

| Secret | Purpose and risk |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Signs the updater archive. Its public half is in [`crates/tessera-desktop/tauri.conf.json`](../crates/tessera-desktop/tauri.conf.json). Losing the private key strands installed apps on their version. |
| `ANDROID_KEYSTORE` (base64) and `ANDROID_KEYSTORE_PASSWORD` | Sign the APK. Android updates only an app signed with the same key. Losing the keystore prevents a released APK from updating an installed one. |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | Deploy the browser demo. Losing them stops deploys; it does not affect installed apps. |

The updater key's password in CI is empty. The Android key's local copies are in [Android usage](usage.md#tailnet-download).

## Rollback

Do not delete the latest release. Installed Mac apps poll its `latest.json`. Deleting it can leave them with no update to fetch.

Publish a newer patch instead. `release:prepare` the next version, say what went wrong in the changelog, then `release:cut --push`. The updater offers that version on its next check.

To take the browser demo back, dispatch `demo.yml` with the last good commit as `ref`.

`ship` already restores the previous app on this Mac when the new build does not answer. It does not roll back a GitHub release.
