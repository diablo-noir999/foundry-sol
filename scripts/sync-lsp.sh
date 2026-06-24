#!/usr/bin/env bash
# Build and sync foundry-lsp output into the bundle directory.
# Run this after making changes: bash scripts/sync-lsp.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOL_DIR="$(dirname "$SCRIPT_DIR")"
LSP_DIR="$SOL_DIR/foundry-lsp"
BUNDLE_DIR="$SOL_DIR/foundry-lsp"

# Build the LSP
echo "Building foundry-lsp..."
cd "$LSP_DIR"
npm run build

# out/ is already in the right place (source of truth)
echo "Done. LSP built at $LSP_DIR/out/"
