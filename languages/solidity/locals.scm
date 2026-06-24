(function_definition) @local.scope
(block_statement) @local.scope
(contract_body) @local.scope
(for_statement) @local.scope
(catch_clause) @local.scope

(function_definition (parameter name: (_) @local.definition))
(modifier_definition (parameter name: (_) @local.definition))
(event_definition (event_parameter name: (_) @local.definition))

; Struct members
(struct_member name: (_) @local.definition)

; State variables
(state_variable_declaration name: (_) @local.definition)

; For-loop variable declarations
(for_statement
  (variable_declaration_statement
    (variable_declaration name: (_) @local.definition)))

; Try/catch error bindings
(catch_clause
  (error_parameter name: (_) @local.definition))

; Variable declarations
(variable_declaration_statement
  (variable_declaration name: (_) @local.definition))

; still have to support tuple assignments
(assignment_expression left: (_) @local.definition)

(identifier) @local.reference
