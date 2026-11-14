# Toolchain and commands for building Tessera. `direnv allow` loads the shell;
# `devenv info` lists the ts-* commands. Longer ones live in scripts/.
#
# Outside a loaded shell, run a command as `direnv exec . ts-check`, or
# `devenv shell -- ts-check`, which also works in CI but unsets TMPDIR.
{
  pkgs,
  lib,
  options,
  ...
}:

let
  # The wasm32 target and llvm-tools build the browser demo; the Android and iOS
  # targets build the phone apps. buildEnv keeps only bin/ and share/: the
  # toolchain itself propagates Nix's clang and its link flags, and the host's
  # compiler and Xcode must stay in charge, as with rustup.
  rustToolchain = pkgs.rust-bin.stable.latest.minimal.override {
    extensions = [
      "rustfmt"
      "clippy"
      "llvm-tools"
    ];
    targets = [
      "wasm32-unknown-unknown"
      "aarch64-linux-android"
      "aarch64-apple-ios"
    ];
  };
  rust = pkgs.buildEnv {
    name = "rust-${rustToolchain.version}";
    paths = [ rustToolchain ];
    pathsToLink = [
      "/bin"
      "/share"
    ];
  };

  # Must match the major version of the Chrome for Testing build that
  # ts-demo-test runs. CI passes the runner's own driver in CHROMEDRIVER.
  chromedriver = pkgs.fetchzip {
    url = "https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/mac-arm64/chromedriver-mac-arm64.zip";
    hash = "sha256-VumWeOfl/SEk8+SdS2WOXd6zh5vCyfHrKy2SRFzV/b0=";
    postFetch = ''
      mkdir -p $out/bin
      mv $out/chromedriver $out/bin/
    '';
  };

  # Each command runs from the checkout that contains the working directory,
  # as mise tasks did, rather than $DEVENV_ROOT: an agent or shell that
  # inherited this environment from another worktree still builds its own.
  prelude = name: ''
    set -euo pipefail
    root=$PWD
    until [ -f "$root/devenv.nix" ] && [ -d "$root/crates/tessera-core" ]; do
      if [ "$root" = / ]; then
        echo "${name}: run inside a Tessera checkout" >&2
        exit 1
      fi
      root=$(dirname "$root")
    done
    cd "$root"
  '';

  # The Android commands re-enter through the android profile, so the SDK and
  # NDK download only when an Android build first needs them.
  android = name: ''
    if [ "''${TESSERA_ANDROID:-}" != 1 ]; then
      exec devenv --quiet --profile android shell -- ${name} "$@"
    fi
  '';

  # True when the output exists and no source is newer, like mise's
  # sources/outputs check.
  fresh = ''
    fresh() {
      local out=$1
      shift
      [ -e "$out" ] && [ -z "$(find "$@" -newer "$out" -print -quit 2>/dev/null)" ]
    }
  '';

  wasmAr = ''
    export AR_wasm32_unknown_unknown="$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | sed -n 's/^host: //p')/bin/llvm-ar"
  '';

  commands = {
    ts-deps = {
      description = "Install the web dependencies";
      run = "bun install --cwd web --frozen-lockfile";
    };
    ts-web-dev = {
      description = "Serve the editor with live reloading on port 5173";
      run = ''
        ts-deps
        exec bun run --cwd web dev "$@"
      '';
    };
    ts-web-build = {
      description = "Typecheck and build the editor into web/dist";
      run = ''
        ts-deps
        ${fresh}
        fresh web/dist/index.html web/src web/public web/index.html web/package.json web/bun.lock web/vite.config.ts web/tsconfig.json && exit 0
        bun run --cwd web build
      '';
    };
    # The document tests drive a real service. They start target/debug/tessera,
    # so it is built first and never stale; TESSERA_TEST_BINARY names another
    # build.
    ts-web-test = {
      description = "Run the editor's tests against a freshly built service";
      run = ''
        ts-deps
        [ -n "''${TESSERA_TEST_BINARY:-}" ] || cargo build --locked -p tessera-cli
        exec bun run --cwd web test "$@"
      '';
    };
    ts-docs-lint = {
      description = "Check the prose in the docs, changelog, agent skills and UI copy with Vale";
      run = "exec vale --no-global README.md CHANGELOG.md docs .agents/skills web/src";
    };
    ts-docs-test = {
      description = "Run the Vale rules' own tests and check Brief.md names every Voice rule";
      run = ''
        vale --no-global test --coverage .vale/styles/Voice .vale/styles/Tessera
        for f in .vale/styles/Voice/*.yml; do
          n=$(basename "$f" .yml)
          grep -q "\*\*$n:\*\*" .vale/styles/Voice/Brief.md || {
            echo "ts-docs-test: Brief.md does not describe Voice.$n" >&2
            exit 1
          }
        done
      '';
    };
    ts-docs-style = {
      description = "Copy the shared Voice prose style from the system checkout into .vale/styles";
      run = ''exec scripts/docs/style "$@"'';
    };
    ts-serve = {
      description = "Serve the development workshop in .tessera/dev on port 4320";
      run = ''
        ts-web-build
        exec cargo run -p tessera-cli -- --workshop .tessera/dev serve --port 4320 --assets web/dist "$@"
      '';
    };
    ts-fmt = {
      description = "Format the Rust code";
      run = ''exec cargo fmt --all "$@"'';
    };
    ts-lint = {
      description = "Check formatting and run Clippy on the workspace";
      run = ''
        cargo fmt --all -- --check
        exec cargo clippy --workspace --all-targets --locked -- -D warnings
      '';
    };
    ts-test = {
      description = "Run the Rust tests";
      run = ''exec cargo test --workspace --locked "$@"'';
    };
    ts-check = {
      description = "Run the checks a change must pass";
      run = ''
        ts-lint
        ts-test
        ts-web-test
        ts-web-build
        ts-docs-test
        ts-docs-lint
      '';
    };
    ts-bench = {
      description = "Run the backend benchmarks; arguments go to tessera-bench";
      run = ''exec cargo run --release --locked -p tessera-bench -- "$@"'';
    };
    ts-cli-build = {
      description = "Build the release command line with the editor embedded";
      run = ''
        ts-web-build
        exec cargo build --release --locked -p tessera-cli --features embed-web "$@"
      '';
    };
    ts-cli-install = {
      description = "Install the command line with the editor embedded into ~/.cargo/bin";
      run = ''
        ts-web-build
        exec cargo install --locked --path crates/tessera-cli --features embed-web "$@"
      '';
    };
    ts-cli-lint = {
      description = "Run Clippy with the editor embedded";
      run = ''
        ts-web-build
        exec cargo clippy --workspace --all-targets --locked --features embed-web -- -D warnings
      '';
    };
    ts-cli-test = {
      description = "Test the embedded editor assets";
      run = ''
        ts-web-build
        exec cargo test --locked -p tessera-service --features embed-web --test assets "$@"
      '';
    };
    ts-demo-wasm = {
      description = "Build the browser demo's wasm engine into web/src/demo/pkg";
      run = ''
        ${wasmAr}
        cargo build -p tessera-web --target wasm32-unknown-unknown --release --locked
        wasm-bindgen --target web --out-name tessera_web --out-dir web/src/demo/pkg "''${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/tessera_web.wasm"
        wasm-opt -Oz web/src/demo/pkg/tessera_web_bg.wasm -o web/src/demo/pkg/tessera_web_bg.wasm
      '';
    };
    ts-demo-build = {
      description = "Build the browser demo into web/dist-demo";
      run = ''
        ts-deps
        ts-demo-wasm
        exec bun run --cwd web build:demo
      '';
    };
    ts-demo-lint = {
      description = "Run Clippy on the crates the browser demo compiles to wasm";
      run = ''
        ${wasmAr}
        exec cargo clippy -p tessera-web -p tessera-service -p tessera-core --target wasm32-unknown-unknown --locked -- -D warnings
      '';
    };
    ts-demo-test = {
      description = "Run the browser demo's wasm tests in headless Chrome for Testing";
      packages = lib.optional (pkgs.stdenv.hostPlatform.system == "aarch64-darwin") chromedriver;
      run = ''exec scripts/demo/test "$@"'';
    };
    ts-mobile-pages = {
      description = "Build the Android and iOS apps' pages into web/dist-mobile";
      run = ''
        ts-deps
        ${fresh}
        fresh web/dist-mobile/mobile.html web/src web/mobile.html web/package.json web/bun.lock web/vite.config.ts web/tsconfig.json && exit 0
        bun run --cwd web build:mobile
      '';
    };
    ts-desktop-build = {
      description = "Build Tessera.app for this Mac; arguments go to `tauri build`";
      run = ''
        ts-web-build
        exec scripts/desktop/build "$@"
      '';
    };
    ts-ship = {
      description = "Build a commit (default HEAD) into Tessera.app and make it the live app on this Mac";
      run = ''exec scripts/ship "$@"'';
    };
    ts-ios-build = {
      description = "Build the iOS app; arguments go to `tauri ios build`";
      run = ''
        ts-mobile-pages
        exec scripts/ios/build "$@"
      '';
    };
    ts-android-build = {
      description = "Build the Android app; arguments go to `tauri android build`";
      android = true;
      run = ''
        ts-mobile-pages
        exec scripts/android/build "$@"
      '';
    };
    ts-android-lint = {
      description = "Run Clippy on the Android app";
      android = true;
      run = ''
        ts-mobile-pages
        exec scripts/android/lint "$@"
      '';
    };
    ts-android-publish = {
      description = "Build a commit (default HEAD) into the Android APK offered for download on the tailnet";
      android = true;
      run = ''exec scripts/android/publish "$@"'';
    };
    ts-commit-lint = {
      description = "Lint commit messages with the shared Voice convention";
      run = ''exec scripts/commit/lint "$@"'';
    };
    ts-fonts-keys = {
      description = "Draw the key glyphs into web/src/ui/fonts/keys.woff2";
      packages = [ pkgs.uv ];
      run = ''exec scripts/fonts/keys "$@"'';
    };
    ts-hooks-install = {
      description = "Enable this clone's versioned Git hooks";
      run = ''exec scripts/hooks/install "$@"'';
    };
    ts-land = {
      description = "Open a pull request for HEAD that fast-forwards main once CI passes";
      run = ''exec scripts/land "$@"'';
    };
    ts-release-prepare = {
      description = "Bump the workspace version and prepend a changelog draft";
      run = ''exec scripts/release/prepare "$@"'';
    };
    ts-release-notes = {
      description = "Print release notes: a draft from commits, or the committed changelog section";
      run = ''exec scripts/release/notes "$@"'';
    };
    ts-release-cut = {
      description = "Commit the version bump, tag it, and optionally push the release";
      run = ''exec scripts/release/cut "$@"'';
    };
    ts-release-body = {
      description = "Print the GitHub release body for a tag from CHANGELOG.md";
      run = ''exec scripts/release/body "$@"'';
    };
    ts-release-finish = {
      description = "Upload SHA256SUMS for a tag and fail if a release asset is missing";
      run = ''exec scripts/release/finish "$@"'';
    };
    ts-seed-clickaround = {
      description = "Seed a workshop with a realistic past week for clickarounds; arguments: [dir] [--replace]";
      run = ''exec scripts/seed/clickaround "$@"'';
    };
  };
in
{
  # No Nix compiler, Apple SDK or xcrun shim: Rust links with the host's cc,
  # and the Tauri and Xcode builds use the installed Xcode, as with rustup.
  stdenv = pkgs.stdenvNoCC;
  apple.sdk = null;
  # stdenv sets these for Nix builds; they would pin the app's minimum macOS
  # to the SDK's and stamp build outputs with 1980.
  unsetEnvVars = options.unsetEnvVars.default ++ [
    "SOURCE_DATE_EPOCH"
    "MACOSX_DEPLOYMENT_TARGET"
    "ZERO_AR_DATE"
  ];

  packages = [
    rust
    pkgs.bun
    # Must match the wasm-bindgen crate in Cargo.lock.
    pkgs.wasm-bindgen-cli_0_2_129
    pkgs.binaryen
    # Checks prose against .vale.ini; 3.25 reads JSX text for the UI copy check.
    pkgs.vale
  ];

  scripts = lib.mapAttrs (name: command: {
    inherit (command) description;
    packages = command.packages or [ ];
    exec = prelude name + lib.optionalString (command.android or false) (android name) + command.run;
  }) commands;

  # `devenv --profile android shell`: the JDK, and an Android SDK with the
  # platform the app compiles against, its build tools and an NDK.
  profiles.android.module =
    { pkgs, ... }:
    let
      ndk = "29.0.14206865";
      sdk = (pkgs.androidenv.override { licenseAccepted = true; }).composeAndroidPackages {
        # The app's compileSdk and the tauri-android library's, and the
        # build tools the Android Gradle plugin defaults to; Gradle cannot
        # add any of them to the read-only SDK.
        platformVersions = [
          "36"
          "37.0"
        ];
        buildToolsVersions = [ "36.0.0" ];
        includeNDK = true;
        ndkVersions = [ ndk ];
        includeEmulator = false;
        includeSystemImages = false;
        includeCmake = false;
        toolsVersion = null;
      };
      home = "${sdk.androidsdk}/libexec/android-sdk";
    in
    {
      packages = [
        sdk.androidsdk
        pkgs.jdk21
      ];
      env = {
        ANDROID_HOME = home;
        ANDROID_SDK_ROOT = home;
        NDK_HOME = "${home}/ndk/${ndk}";
        JAVA_HOME = pkgs.jdk21.home;
        TESSERA_ANDROID = "1";
      };
    };
}
