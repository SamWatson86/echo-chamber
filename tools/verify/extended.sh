#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if ! command -v cargo >/dev/null 2>&1; then
  echo "[verify] cargo is required for extended verification" >&2
  exit 1
fi

echo "[verify] running quick checks first"
VERIFY_REQUIRE_RUST=1 VERIFY_RUN_FMT=1 bash tools/verify/quick.sh

echo "[verify] Rust clippy (control plane)"
(
  cd core
  cargo clippy -p echo-core-control -- -D warnings
)

echo "[verify] Rust tests (control plane)"
(
  cd core
  cargo test -p echo-core-control --all-targets
)

echo "[verify] extended verification complete"
