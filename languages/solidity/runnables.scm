; Solidity test function detection for Zed editor

; Match test functions (test*, testFail*, testFuzz*, invariant*)
(
  (
    (function_definition
      name: (identifier) @run
      (#match? @run "^test"))
  ) @_
  (#set! tag solidity-test)
)

(
  (
    (function_definition
      name: (identifier) @run
      (#match? @run "^invariant"))
  ) @_
  (#set! tag solidity-test)
)

; Match setUp functions (Foundry test setup)
(
  (
    (function_definition
      name: (identifier) @run
      (#match? @run "^setUp$"))
  ) @_
  (#set! tag solidity-test)
)

; Match entire contract for running all tests in a contract
(
  (contract_declaration
    name: (identifier) @run
  ) @_
  (#set! tag solidity-contract-test)
)
