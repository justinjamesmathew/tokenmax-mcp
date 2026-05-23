/**
 * Tree-sitter S-expression queries shared by the `typescript` and `tsx` grammars.
 *
 * Captures are namespaced so the parser can dispatch by name. Post-processing in
 * parser.ts handles exported-flag detection, parent-class lookup, modifier
 * extraction, and signature/doc-comment slicing — those are awkward to express
 * inside the query language and we don't pay much for doing them in TS.
 */
export const TS_QUERY_SOURCE = String.raw`
;; --- top-level declarations ---

(function_declaration
  name: (identifier) @sym.name) @sym.function

(class_declaration
  name: (type_identifier) @sym.name) @sym.class

(abstract_class_declaration
  name: (type_identifier) @sym.name) @sym.class

(interface_declaration
  name: (type_identifier) @sym.name) @sym.interface

(type_alias_declaration
  name: (type_identifier) @sym.name) @sym.type

(enum_declaration
  name: (identifier) @sym.name) @sym.enum

;; const/let/var with arrow or function-expression value → indexed as "function".
(lexical_declaration
  (variable_declarator
    name: (identifier) @sym.name
    value: [(arrow_function) (function_expression) (generator_function)]) @sym.const_function)

;; const/let/var with any other value → "const". The parser de-dupes against
;; const_function by node id.
(lexical_declaration
  (variable_declarator
    name: (identifier) @sym.name
    value: (_)) @sym.const_value)

;; --- class members ---

(method_definition
  name: [(property_identifier) (private_property_identifier)] @sym.name) @sym.method

;; --- re-exports ---

;; export { X } from './y'  and  export { X as Y } from './y'
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @sym.reexport_name
      alias: (identifier)? @sym.reexport_alias))
  source: (string) @sym.reexport_from) @sym.reexport

;; export * from './y'
(export_statement
  source: (string) @sym.reexport_star_from) @sym.reexport_star
`;
