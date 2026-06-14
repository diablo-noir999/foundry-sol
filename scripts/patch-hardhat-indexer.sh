#!/bin/bash
# OPTIONAL MANUAL PATCH — not part of the extension's normal install flow.
# Only needed if you use chainlink-evm as a Foundry dependency and want
# go-to-definition to work inside lib/chainlink-evm/ files.
# See README for context.
# Upstream issue: https://github.com/NomicFoundation/hardhat-vscode/issues/XXX

set -e

SERVER_INDEX="${1:-node_modules/@nomicfoundation/solidity-language-server/out/index.js}"

if [ ! -f "$SERVER_INDEX" ]; then
  echo "ERROR: Server not found at $SERVER_INDEX"
  exit 1
fi

# The HardhatIndexer pattern (unique occurrence):
#   "**/hardhat.config.{ts,js}",
#   ["**/node_modules/**"]
#
# Patch to:
#   "**/hardhat.config.{ts,js}",
#   ["**/node_modules/**","**/lib/**"]

# The two lines to patch (on separate lines in the file):
#   "**/hardhat.config.{ts,js}",
#   ["**/node_modules/**"]
#
# Replace the second line only, adding "**/lib/**" to the exclusion array.

# Check if already patched (look for the patched version)
if grep -A1 '"\*\*/hardhat.config' "$SERVER_INDEX" | grep -q '"\*\*/lib/\*\*"' 2>/dev/null; then
  echo "Already patched: $SERVER_INDEX"
  exit 0
fi

# Use sed to replace the exclusion array on the line after the hardhat config glob
# This is a single-line replacement on the ["**/node_modules/**"] line
sed -i '/hardhat\.config/{
n
s|\["\*\*/node_modules/\*\*"\]|["**/node_modules/**","**/lib/**"]|
}' "$SERVER_INDEX"

# Verify patch applied
if grep -A1 '"\*\*/hardhat.config' "$SERVER_INDEX" | grep -q '"\*\*/lib/\*\*"' 2>/dev/null; then
  echo "Patched successfully: $SERVER_INDEX"
else
  echo "ERROR: Patch failed to apply to $SERVER_INDEX"
  exit 1
fi
