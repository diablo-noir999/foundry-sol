# foundry-sol

Solidity language support for Zed, built for Foundry projects.

## Features

- **Syntax highlighting** — tree-sitter grammar for `.sol` and `.yul` (including `nonpayable` modifier)
- **LSP** — full language server with 13 capabilities:
  - Completion (keywords, types, globals, NatSpec, imports, dot-access for msg./block./tx./abi./this./super.)
  - Hover (functions, variables, contracts, structs, enums, events, errors, modifiers, types)
  - Go-to-definition (cross-file, remappings-aware)
  - Find references (cross-file via AST `referencedDeclaration` IDs)
  - Rename (cross-file workspace edits)
  - Code actions (9 quickfixes + 4 ERC templates + implement interface)
  - Document symbols (nested contract hierarchy with functions, variables, structs, enums, events, errors, modifiers)
  - Formatting (`forge fmt` via stdin)
  - Semantic tokens (19 node types)
  - Type definition
  - Signature help (functions, events, modifiers, errors with NatSpec docs)
  - Workspace symbols (fuzzy search)
  - Implementation (interface → implementing contracts)
- **Foundry project detection** — reads `foundry.toml`, resolves remappings
- **50+ snippets** — core Solidity, ERC interfaces, Foundry templates, patterns
- **Dependency checking** — auto-installs Foundry if missing

## Installation

Search `foundry-sol` in `zed: extensions`.

Requires:
- Node.js (managed by Zed)
- Foundry (auto-installed if missing)

## LSP Features

### Completion
- Solidity keywords with snippets
- Elementary types sorted by frequency: `uint`, `uint256`, `uint128`, `uint64`, `uint32`, `uint16`, `uint8`, `int`, `int256`, `int128`, `int64`, `int32`, `int16`, `int8`, `bytes4`, `bytes8`, `bytes16`, `bytes20`, `bytes32`, `bytes96`, `bytes112`, `bytes160`
- Global functions (assert, require, keccak256, abi.encode, etc.)
- Global variables (msg.sender, block.timestamp, tx.origin, etc.)
- Global object sub-properties (msg., block., tx., abi.)
- Address members (balance, call, transfer, etc.)
- Import path completion
- `emit` trigger → events only
- `revert` trigger → custom errors only
- `using` trigger → library suggestions
- NatSpec auto-generation with @param/@return
- `this.` and `super.` member completion

### Quickfixes
- Add SPDX license identifier
- Add visibility (public/internal/external)
- Add override specifier
- Add virtual specifier
- Mark contract as abstract
- Add data location (memory/storage/calldata)
- Add pragma version
- Add mutability (view)
- Implement interface (generate function stubs)

### ERC Templates
- ERC-20 Token
- ERC-721 NFT
- ERC-1155 Multi-Token
- Ownable Contract

## Snippets

| Prefix | Description |
|--------|-------------|
| `con` | Contract declaration |
| `func` | Function |
| `funcr` | Function with return |
| `funcrview` | View function |
| `mod` | Modifier |
| `ev` | Event |
| `error` | Custom error |
| `const` | Constructor |
| `map` | Mapping |
| `interf` | Interface |
| `lib` | Library |
| `spdx` | SPDX license identifier |
| `pragm` | Pragma statement |
| `import` | Import statement |
| `enum` | Enum |
| `ife` | If/else |
| `for` | For loop |
| `unchecked` | Unchecked block |
| `assembly` | Assembly block |
| `forge-test` | Forge test contract |
| `forge-script` | Forge script contract |
| `clog` | console.log |
| `natfunc` | NatSpec function doc |
| `natcontract` | NatSpec contract doc |
| `natvar` | NatSpec variable doc |
| `natevent` | NatSpec event doc |
| `erc20i` | ERC20 interface |
| `erc20` | ERC20 implementation |
| `erc721i` | ERC721 interface |
| `erc1155i` | ERC1155 interface |
| `erc165i` | ERC165 interface |
| `erc777i` | ERC777 interface |
| `erc173i` | ERC173 ownership |
| `erc4626i` | ERC4626 vault |
| `erc2981i` | ERC2981 royalty |
| `erc1167i` | ERC1167 minimal proxy |
| `ownable` | Ownable pattern |
| `pausable` | Pausable pattern |
| `reentrancyguard` | ReentrancyGuard |

## Formatting

Formatting is built-in via `forge fmt`. No additional configuration needed.

## Fetching Verified Contracts

Use Foundry's `cast` tool:

```bash
export ETHERSCAN_API_KEY="your-key"
cast source <ADDRESS> --chain mainnet          # print source
cast source <ADDRESS> --chain mainnet --flatten # single file
cast source <ADDRESS> --chain mainnet -d ./lib/<name> # output to dir
```

## Architecture

```
foundry-sol/
├── extension.toml          ← Zed extension manifest
├── src/foundry_sol.rs      ← WASM bootstrap (embeds server.js, writes to work dir)
├── foundry-lsp/            ← TypeScript LSP server (bundled with esbuild)
│   ├── src/
│   │   ├── server.ts       ← Entry point
│   │   ├── features/       ← 13 LSP feature providers
│   │   ├── compiler/       ← forge build --ast pipeline
│   │   ├── project/        ← foundry.toml, remappings
│   │   ├── ast/            ← Solidity AST types + traversal
│   │   ├── linter/         ← solhint integration (tmp files in os.tmpdir())
│   │   └── indexer.ts      ← GlobalIndex (cross-file symbol index)
│   └── out/server.js       ← Bundled server (self-contained, no node_modules needed)
├── languages/solidity/     ← Tree-sitter query files
├── grammars/               ← tree-sitter-solidity, tree-sitter-yul
├── snippets/               ← 50+ Solidity snippets
└── extension.wasm          ← Compiled WASM (includes embedded server.js)
```

## Testing

Run the LSP test suite against a Foundry project:

```bash
cd <foundry-project>
node /path/to/foundry-sol/test-lsp.js
```

Tests cover: diagnostics, completions, hover, go-to-definition, find references,
type definition, code actions, formatting, document symbols, semantic tokens,
workspace symbols, signature help, rename, and library file support.

## License

MIT
