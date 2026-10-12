# Releasing

Tessera has three publishes. They are not interchangeable.

| Publish | Who it is for | Command |
|---|---|---|
| GitHub release | Anyone downloading the app | `mise run release:cut -- <version> --push` |
| Browser demo | Anyone trying it at <https://tessera.solforged.io> | A green CI run on `main`, or a manual dispatch |
| This Mac, and the tailnet APK | The machine you are using | `mise run ship` and `mise run android:publish` |

`ship` and `android:publish` build one commit into the local app or the tailnet download page. They do not create a GitHub release, and a GitHub release does not replace the app on this Mac.

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

Without `--push`, the tag stays local. With `--push`, the task fast-forwards `main` and pushes `v0.4.0`. [`.github/workflows/release.yml`](../.github/workflows/release.yml) creates the release. Do not run `gh release create`.

The workflow refuses a tag whose version does not match `Cargo.toml`, or whose changelog section is missing or still marked draft. It publishes the notes from that section, then uploads `SHA256SUMS` after every asset is present. A failed macOS, Linux or Android job leaves the release in place, marks it incomplete and fails the workflow.

| Asset | What it is |
|---|---|
| `Tessera_<version>_aarch64.dmg` | macOS app. Ad-hoc signed, not notarised. |
| `Tessera_<version>_aarch64.app.tar.gz` and `.sig` | Signed updater archive. Installed apps poll `latest.json`. |
| `tessera-v<version>-aarch64-apple-darwin.tar.gz` | macOS command line. |
| `tessera-v<version>-x86_64-unknown-linux-gnu.tar.gz` | Linux command line. |
| `Tessera_<version>_aarch64.apk` | Android app, signed with the release key. |
| `SHA256SUMS` | Checksums of the files above. |
| `latest.json` | Updater manifest. It must be on the release before that release is the latest one. |

`mise run release:finish -- v0.4.0` can upload `SHA256SUMS` again if the workflow stopped after the assets were published.

## Browser demo

[`.github/workflows/demo.yml`](../.github/workflows/demo.yml) deploys `main` only after the CI workflow succeeds. A red CI run leaves the previous demo in place. The deploy then requests the new deployment and <https://tessera.solforged.io>, and fails if either page does not contain Tessera.

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
