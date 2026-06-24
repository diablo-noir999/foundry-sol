#!/bin/bash
# Setup script for foundry-sol dev extension
# Run this after modifying the extension to update the installed copy

set -e

EXTENSION_DIR="$HOME/.local/share/zed/extensions/work/foundry-sol"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Setting up foundry-sol dev extension..."

# Build LSP
echo "Building LSP..."
cd "$SOURCE_DIR/foundry-lsp"
npm run build

# Build WASM
echo "Building WASM extension..."
cd "$SOURCE_DIR"
cargo component build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/foundry_sol.wasm extension.wasm

# Copy files to Zed extension directory
echo "Copying to Zed extension directory..."
mkdir -p "$EXTENSION_DIR"

# Copy source files
cp -r "$SOURCE_DIR/src" "$EXTENSION_DIR/"
cp -r "$SOURCE_DIR/languages" "$EXTENSION_DIR/"
cp -r "$SOURCE_DIR/snippets" "$EXTENSION_DIR/"
cp -r "$SOURCE_DIR/grammars" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/extension.toml" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/extension.wasm" "$EXTENSION_DIR/"

# Copy LSP
mkdir -p "$EXTENSION_DIR/foundry-lsp"
cp -r "$SOURCE_DIR/foundry-lsp/out" "$EXTENSION_DIR/foundry-lsp/"
cp "$SOURCE_DIR/foundry-lsp/package.json" "$EXTENSION_DIR/foundry-lsp/"
cp -r "$SOURCE_DIR/foundry-lsp/node_modules" "$EXTENSION_DIR/foundry-lsp/"

echo "Done! Restart Zed to load the updated extension."
