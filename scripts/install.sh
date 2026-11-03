#!/usr/bin/env bash
# Builds tf (TUI) and tf-backend (Rust) and installs both into $PREFIX (default ~/.local/bin).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREFIX:-$HOME/.local/bin}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required ($2)" >&2; exit 1; }; }
want() { command -v "$1" >/dev/null 2>&1 || echo "note: '$1' not found — $2" >&2; }

need cargo "https://rustup.rs"
need bun "https://bun.sh"
want dl-daemon "install dl (github.com/Nexgear75/dl) to download results"
want jackett "tf will offer to install it with Homebrew on first launch"

echo "› building tf-backend (release)"
(cd "$ROOT/backend" && cargo build --release --quiet)

echo "› building tf"
(cd "$ROOT/tui" && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null)

mkdir -p "$PREFIX"
install -m 755 "$ROOT/backend/target/release/tf-backend" "$PREFIX/tf-backend"
install -m 755 "$ROOT/dist/tf" "$PREFIX/tf"

echo "✓ installed $PREFIX/tf and $PREFIX/tf-backend"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "note: add $PREFIX to your PATH (e.g. in ~/.zshrc: export PATH=\"$PREFIX:\$PATH\")" ;;
esac
