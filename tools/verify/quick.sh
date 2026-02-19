#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[verify] starting quick verification"

echo "[verify] JS syntax checks"
node --check core/viewer/app.js
node --check core/viewer/jam.js

echo "[verify] JS deterministic tests"
node --test core/viewer/room-switch-state.test.js

if [[ "${VERIFY_SKIP_RUST:-0}" == "1" ]]; then
  echo "[verify] skipping Rust checks (VERIFY_SKIP_RUST=1)"
  echo "[verify] quick verification complete"
  exit 0
fi

if ! command -v cargo >/dev/null 2>&1; then
  if [[ "${VERIFY_REQUIRE_RUST:-0}" == "1" ]]; then
    echo "[verify] cargo is required but not installed" >&2
    exit 1
  fi
  echo "[verify] cargo not found; skipping Rust checks"
  echo "[verify] set VERIFY_REQUIRE_RUST=1 to enforce Rust checks"
  echo "[verify] quick verification complete"
  exit 0
fi

if [[ "${VERIFY_RUN_FMT:-0}" == "1" ]]; then
  echo "[verify] Rust format check"
  (
    cd core
    cargo fmt --all -- --check
  )
else
  echo "[verify] skipping Rust format check (set VERIFY_RUN_FMT=1 to enable)"
fi

echo "[verify] Rust compile check (control plane)"
(
  cd core
  cargo check -p echo-core-control
)

echo "[verify] quick verification complete"
