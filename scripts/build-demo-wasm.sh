#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

host=$(rustc -vV | sed -n 's/^host: //p')
export AR_wasm32_unknown_unknown="$(rustc --print sysroot)/lib/rustlib/$host/bin/llvm-ar"
if [[ ! -x "$AR_wasm32_unknown_unknown" ]]; then
  printf '%s\n' 'Missing llvm-ar. Run: rustup component add llvm-tools' >&2
  exit 1
fi
if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
  printf '%s\n' 'Missing browser target. Run: rustup target add wasm32-unknown-unknown' >&2
  exit 1
fi
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  printf '%s\n' 'Missing wasm-bindgen. Run: cargo install wasm-bindgen-cli --version 0.2.129 --locked' >&2
  exit 1
fi
if [[ "$(wasm-bindgen --version)" != 'wasm-bindgen 0.2.129' ]]; then
  printf '%s\n' 'The browser bridge requires wasm-bindgen 0.2.129. Run: cargo install wasm-bindgen-cli --version 0.2.129 --locked' >&2
  exit 1
fi

cargo build -p tessera-web --target wasm32-unknown-unknown --release --locked
wasm-bindgen --target web --out-name tessera_web --out-dir web/src/demo/pkg \
  target/wasm32-unknown-unknown/release/tessera_web.wasm
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz web/src/demo/pkg/tessera_web_bg.wasm -o web/src/demo/pkg/tessera_web_bg.wasm
fi
