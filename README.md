# foundry-sol

Solidity language support for Zed, built for Foundry projects.

## Features

- **Syntax highlighting** — tree-sitter grammar for `.sol` and `.yul` (including `nonpayable` modifier)
- **LSP** — full language server with 13 capabilities:
  - Completion (keywords, types, globals, NatSpec, imports, dot-access, local variables, inherited members)
  - Hover (functions, variables, contracts, structs, enums, events, errors, modifiers, types, `@inheritdoc` resolution)
  - Go-to-definition (cross-file, remappings-aware, struct/enum scoped access)
  - Find references (cross-file via AST `referencedDeclaration` IDs)
  - Rename (cross-file workspace edits with GlobalIndex invalidation)
  - Code actions (9 error-code-based quickfixes + 4 ERC templates + via-ir suggestion + implement interface)
  - Document symbols (nested hierarchy with function parameters as children)
  - Formatting (`forge fmt` via stdin with fallback when forge unavailable)
  - Semantic tokens (19 node types + string/number/comment literals)
  - Type definition
  - Signature help (functions, events, modifiers, errors with NatSpec docs, overload resolution)
  - Workspace symbols (fuzzy search)
  - Implementation (interface → implementing contracts)
- **Foundry project detection** — reads `foundry.toml`, resolves remappings (with `remappings.txt` fallback)
- **50+ snippets** — core Solidity, ERC interfaces, Foundry templates, patterns
- **Dependency checking** — auto-installs Foundry if missing
- **Standalone .sol support** — works on files outside Foundry projects via temp-project compilation

## Installation

Search `foundry-sol` in `zed: extensions`.

Requires:
- Node.js (managed by Zed)
- Foundry (auto-installed if missing)

## LSP Features

### Completion
- Solidity keywords with snippets
- Elementary types sorted by frequency
- Global functions (assert, require, keccak256, abi.encode, etc.)
- Global variables (msg.sender, block.timestamp, tx.origin, etc.)
- Global object sub-properties (msg., block., tx., abi.)
- Address members (balance, call, transfer, etc.)
- Import path completion
- `emit` trigger → events only
- `revert` trigger → custom errors only
- `using` trigger → library suggestions
- NatSpec auto-generation with @param/@return (`*` trigger in comments)
- `this.` and `super.` member completion with full inheritance walk
- **Local variable scope** — function parameters, local variables, for-loop variables, catch parameters
- **Inherited members** — dot completion walks full inheritance chain with visibility filtering

### Hover
- Functions, state variables, contracts, structs, enums, events, errors, modifiers
- Elementary type descriptions (e.g., "Unsigned integer (256 bits)")
- NatSpec extraction (@notice, @dev, @param, @return, @title, @author)
- **`@inheritdoc` resolution** — follows inheritance chain to fetch documentation from parent contracts/interfaces

### Go-to-Definition
- Cross-file via GlobalIndex and `sourceFileMap`
- Import resolution with remappings (longest-prefix-first matching)
- Named import symbol resolution (`import {Foo} from "..."`)
- **Struct/enum scoped access** — `MyContract.MyStruct` resolves to the correct definition

### Signature Help
- Functions, events, modifiers, errors with NatSpec documentation
- Parameter label offsets for active parameter highlighting
- Built-in signatures (require, assert, revert, blockhash)
- **Overload resolution** — best match by argument count, shows all overloads

### Code Actions
- Error code-based quickfix dispatch (9 registered handlers)
- Error deduplication (group-by-location, blocked code filtering)
- SPDX license identifier
- Missing visibility (public/internal/external)
- Missing override/virtual/abstract specifiers
- State mutability restriction (view/pure)
- Data location (memory/storage/calldata)
- Compiler version pragma
- Address checksum
- **via-ir suggestion** for contract code size errors
- Implement interface (generate function stubs)
- ERC templates (ERC-20, ERC-721, ERC-1155, Ownable)

### Formatting
- `forge fmt` via stdin (primary)
- **Fallback formatting** — brace placement + whitespace cleanup when forge unavailable

### Semantic Tokens
- 19 node types: contracts, functions, variables, structs, enums, events, errors, modifiers, imports
- Token modifiers: declaration, definition, readonly, static, deprecated, abstract
- **String/number/comment literals** — highlighted in editor

### Document Symbols
- Contracts, functions, state variables, constants, structs, enums, events, errors, modifiers, UDVTs
- Nested hierarchy (contract members, struct members)
- **Function parameters as children** — input and return params nested under functions

### Project Detection
- Foundry project detection via `foundry.toml` (search upward + children + fallback)
- Remappings via `forge remappings` with **`remappings.txt` fallback**
- File watcher for `foundry.toml`, `remappings.txt`, and `.sol` files
- **Standalone .sol support** — compiles via temp Foundry project, reads AST before cleanup

### Indexing
- GlobalIndex with 12 symbol kinds (contract, interface, library, function, variable, struct, enum, event, error, modifier, typedef, constant)
- **Incremental indexing** — only re-indexes changed files instead of full rebuild
- **Rename invalidation** — removes stale entries from GlobalIndex after rename

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

Formatting is built-in via `forge fmt`. Falls back to basic brace placement + whitespace cleanup if forge is unavailable.

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
│   │   ├── capabilities.ts ← SERVER_CAPABILITIES (single source of truth)
│   │   ├── connection.ts   ← LSP connection (stdio)
│   │   ├── documents.ts    ← TextDocuments manager
│   │   ├── indexer.ts      ← GlobalIndex (cross-file symbol index, incremental)
│   │   ├── features/       ← 13 LSP feature providers
│   │   ├── compiler/       ← forge build --ast pipeline (incremental, async I/O)
│   │   ├── project/        ← foundry.toml, remappings (with fallback)
│   │   ├── ast/            ← Solidity AST types + traversal (O(log n) position lookup)
│   │   ├── linter/         ← solhint integration (secure temp files)
│   │   └── utils.ts        ← Shared utilities (NatSpec, type extraction, etc.)
│   ├── out/server.js       ← Bundled server (self-contained, no node_modules needed)
│   └── test-project/
│       ├── test-lsp.js     ← LSP integration tests
│       └── test-parity.js  ← Comprehensive parity test suite (40 tests)
├── languages/solidity/     ← Tree-sitter query files
├── grammars/               ← tree-sitter-solidity, tree-sitter-yul
├── snippets/               ← 50+ Solidity snippets
└── extension.wasm          ← Compiled WASM (includes embedded server.js)
```

## Testing

Run the LSP test suite:

```bash
cd foundry-lsp/test-project
node test-lsp.js        # Core LSP tests
node test-parity.js     # Parity improvement tests (40 test cases)
```

Tests cover: diagnostics, completions, hover, go-to-definition, find references,
type definition, code actions, formatting, document symbols, semantic tokens,
workspace symbols, signature help, rename, local variable scope, inheritance walk,
@inheritdoc resolution, overload resolution, and more.

## Security

- Temp files use `crypto.randomBytes()` (not predictable timestamps)
- Crash logs use random filenames with `0o600` permissions
- All errors are logged for debugging (no silent failures)

## Performance

- O(log n) position lookup via pre-computed line offset tables
- Async file I/O throughout (no blocking `readFileSync`)
- Incremental indexing (only re-indexes changed files)
- Cached directory listings for import completion (2s TTL)
- Validation ID deduplication (stale results discarded)

## License

MIT
