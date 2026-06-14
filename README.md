# foundry-sol

Solidity language support for Zed, built for Foundry projects.

## Features

- **Syntax highlighting** — tree-sitter grammar for `.sol` and `.yul`
- **LSP** — go-to-definition, hover, diagnostics, completions via
  `@nomicfoundation/solidity-language-server` (auto-installed)
- **Foundry project detection** — reads `foundry.toml`, resolves remappings
  via `forge remappings` automatically
- **32 snippets** — core Solidity patterns, ERC interfaces (ERC20/721/1155),
  NatSpec block templates (`natfunc`, `natcontract`, `natvar`, `natevent`)
- **Code outline** — contracts, functions, events, errors in the symbol tree

## Installation

Search `foundry-sol` in `zed: extensions`.

Requires Foundry installed (`curl -L https://foundry.paradigm.xyz | bash`).

## Snippets

| Prefix | Expands to |
|--------|------------|
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
| `natfunc` | NatSpec function doc block |
| `natcontract` | NatSpec contract doc block |
| `natvar` | NatSpec variable doc block |
| `natevent` | NatSpec event doc block |
| `erc20i` | ERC20 interface |
| `erc20` | ERC20 example implementation |
| `erc721i` | ERC721 interface |
| `erc1155i` | ERC1155 interface |
| `erc165i` | ERC165 interface |
| `erc777i` | ERC777 interface |
| `erc173i-draft` | ERC173 ownership interface |
| `erc1820` | ERC1820 registry interface |

## Formatting

`forge fmt` isn't wirable from the extension API directly. Add this to your
Zed `settings.json`:

```json
{
  "languages": {
    "Solidity": {
      "formatter": {
        "external": {
          "command": "forge",
          "arguments": ["fmt", "--raw", "-"]
        }
      }
    }
  }
}
```

## Fetching verified contracts

Use Foundry's `cast` tool:

```bash
export ETHERSCAN_API_KEY="your-key"
cast source <ADDRESS> --chain mainnet          # print source
cast source <ADDRESS> --chain mainnet --flatten # single file
cast source <ADDRESS> --chain mainnet -d ./lib/<name> # output to dir
```

## Known limitations

### Hardhat config in vendored dependencies
If your project depends on `chainlink-evm` (or any `lib/` dependency that
ships its own `hardhat.config.ts`), the LSP may log:

```
[contracts] Cannot find module 'hardhat/internal/lsp-helpers'
```

This is an upstream bug in `@nomicfoundation/solidity-language-server` —
it scans `lib/` for Hardhat configs and tries to initialize them.

**Impact**: go-to-definition into `lib/chainlink-evm/` files may not work.
Your own contracts are unaffected.

**Workaround**:
```bash
bash scripts/patch-hardhat-indexer.sh \
  ~/.local/share/zed/extensions/work/foundry-sol/node_modules/@nomicfoundation/solidity-language-server/out/index.js
```

Re-apply after the LSP server updates.

### Hover
Hover sometimes returns nothing for cross-file symbols. Pre-existing
limitation in the LSP server's analyzer — not specific to this extension.

## Fork history

Forked from [zarifpour/zed-solidity](https://github.com/zarifpour/zed-solidity).
